/**
 * COST-BE-024 (#383) — Cloudflare GraphQL Analytics as a usage source (epic
 * §41-P2, §42.8–.9).
 *
 * Reads two datasets, both included in every Cloudflare plan and billed to
 * nobody (the Analytics API has no per-query price):
 *
 * - `r2OperationsAdaptiveGroups` / `r2StorageAdaptiveGroups` — R2 operations
 *   per action type and the day's peak storage, per bucket;
 * - `workersInvocationsAdaptive` — Workers requests and errors, per script.
 *
 * Provider knowledge stays here (epic §5): which action is Class A and which
 * is Class B is Cloudflare's pricing page, not the Cost Center's business, so
 * the port hands back counts already folded into the two classes plus the
 * raw per-action breakdown for the metadata column. Anything the page does
 * not list is counted as `unclassified` and *reported*, never dropped and
 * never guessed into a class.
 *
 * What the datasets do not expose, this adapter does not invent: R2 egress
 * bytes and a summed Workers CPU time are absent from the documented schema
 * (only CPU-time quantiles exist), so neither appears in the result — the
 * registry keeps those meters declared and the collector leaves them
 * unwritten (epic §44.8: an extrapolated figure is not accounting).
 *
 * Retention is 31 days; a collector that asks for an older day gets an empty
 * answer, not an error, which is why the caller only ever asks for today and
 * yesterday.
 */

export type CloudflareAnalyticsConfig = {
  accountId: string;
  token: string;
  /** Override for tests; the real endpoint otherwise. */
  endpoint?: string;
};

export type CloudflareR2DayUsage = {
  bucketName: string;
  /** Class A operations (writes, lists) on the day. */
  classA: number;
  /** Class B operations (reads, heads) on the day. */
  classB: number;
  /** Operations whose action type the pricing page does not classify. */
  unclassified: number;
  /** `actionType → requests`, verbatim from the dataset. */
  byAction: Record<string, number>;
  /** Peak payload + metadata bytes held during the day. */
  peakBytes: number;
  /** Peak object count during the day. */
  peakObjects: number;
};

export type CloudflareWorkersDayUsage = {
  scriptName: string;
  requests: number;
  errors: number;
  subrequests: number;
};

export type CloudflareAnalyticsQuery = {
  /** UTC day `YYYY-MM-DD`. */
  day: string;
  signal?: AbortSignal;
};

/**
 * The port the cost collector consumes. Structural, so a fixture-backed fake
 * in a test and the HTTP client below are interchangeable.
 */
export interface CloudflareAnalyticsPort {
  /** R2 usage for `day`, one entry per bucket (filtered to `buckets` when given). */
  r2Usage(
    query: CloudflareAnalyticsQuery & { buckets?: readonly string[] },
  ): Promise<CloudflareR2DayUsage[]>;
  /** Workers usage for `day`, one entry per script (filtered to `scripts` when given). */
  workersUsage(
    query: CloudflareAnalyticsQuery & { scripts?: readonly string[] },
  ): Promise<CloudflareWorkersDayUsage[]>;
}

export type CloudflareAnalyticsErrorCode =
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'GRAPHQL_ERROR'
  | 'BAD_RESPONSE'
  | 'INVALID_ARGUMENT'
  | `HTTP_${number}`;

/** `code` is what the collector scheduler stores on the freshness row. */
export class CloudflareAnalyticsError extends Error {
  constructor(
    readonly code: CloudflareAnalyticsErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'CloudflareAnalyticsError';
  }
}

export const CLOUDFLARE_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

/**
 * Cloudflare R2 pricing page, fetched 2026-09-03: "Class A operations:
 * ListBuckets, PutBucket, ListObjects, PutObject, CopyObject,
 * CompleteMultipartUpload, CreateMultipartUpload,
 * LifecycleStorageTierTransition, ListMultipartUploads, UploadPart,
 * UploadPartCopy, ListParts, PutBucketEncryption, PutBucketCors and
 * PutBucketLifecycleConfiguration."
 */
export const R2_CLASS_A_ACTIONS: ReadonlySet<string> = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
]);

/**
 * Same page: "Class B operations: HeadBucket, HeadObject, GetObject,
 * UsageSummary, GetBucketEncryption, GetBucketLocation, GetBucketCors and
 * GetBucketLifecycleConfiguration."
 */
export const R2_CLASS_B_ACTIONS: ReadonlySet<string> = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

export function classifyR2Action(actionType: string): 'A' | 'B' | null {
  if (R2_CLASS_A_ACTIONS.has(actionType)) return 'A';
  if (R2_CLASS_B_ACTIONS.has(actionType)) return 'B';
  return null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Account tags are 32 hex chars; bucket and script names are DNS-ish labels.
// Every value is interpolated into the query as a JSON string literal, so the
// check is about refusing nonsense early, not about escaping.
const IDENT = /^[A-Za-z0-9._-]{1,128}$/;

function assertDay(day: string): void {
  if (!DAY.test(day)) throw new CloudflareAnalyticsError('INVALID_ARGUMENT', `bad day ${day}`);
}

function assertIdents(kind: string, values: readonly string[] | undefined): void {
  for (const v of values ?? []) {
    if (!IDENT.test(v)) throw new CloudflareAnalyticsError('INVALID_ARGUMENT', `bad ${kind} ${v}`);
  }
}

const lit = (v: string) => JSON.stringify(v);
const list = (values: readonly string[]) => `[${values.map(lit).join(', ')}]`;

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Cloudflare types `date` and `datetime` as its own scalars, so the values
 * are inlined as literals rather than passed as `String` variables — a typed
 * variable that does not match the scalar is rejected at validation.
 */
export function r2Query(
  accountId: string,
  day: string,
  buckets: readonly string[] | undefined,
): string {
  const bucketFilter = buckets && buckets.length > 0 ? `, bucketName_in: ${list(buckets)}` : '';
  return `{
  viewer {
    accounts(filter: { accountTag: ${lit(accountId)} }) {
      ops: r2OperationsAdaptiveGroups(limit: 10000, filter: { date: ${lit(day)}${bucketFilter} }) {
        dimensions { bucketName actionType }
        sum { requests }
      }
      storage: r2StorageAdaptiveGroups(limit: 10000, filter: { date: ${lit(day)}${bucketFilter} }) {
        dimensions { bucketName }
        max { payloadSize metadataSize objectCount }
      }
    }
  }
}`;
}

export function workersQuery(
  accountId: string,
  day: string,
  scripts: readonly string[] | undefined,
): string {
  const scriptFilter = scripts && scripts.length > 0 ? `, scriptName_in: ${list(scripts)}` : '';
  return `{
  viewer {
    accounts(filter: { accountTag: ${lit(accountId)} }) {
      invocations: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: ${lit(`${day}T00:00:00Z`)}, datetime_lt: ${lit(`${nextDay(day)}T00:00:00Z`)}${scriptFilter} }) {
        dimensions { scriptName }
        sum { requests errors subrequests }
      }
    }
  }
}`;
}

type GraphqlResponse = {
  data?: { viewer?: { accounts?: unknown } } | null;
  errors?: { message?: string; extensions?: { code?: string } }[] | null;
};

type R2OpsGroup = {
  dimensions?: { bucketName?: string; actionType?: string };
  sum?: { requests?: number | string };
};
type R2StorageGroup = {
  dimensions?: { bucketName?: string };
  max?: {
    payloadSize?: number | string;
    metadataSize?: number | string;
    objectCount?: number | string;
  };
};
type WorkersGroup = {
  dimensions?: { scriptName?: string };
  sum?: { requests?: number | string; errors?: number | string; subrequests?: number | string };
};

const num = (v: number | string | undefined | null): number => {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Pure: dataset groups → per-bucket usage. Exported for the fixture tests. */
export function foldR2(ops: readonly R2OpsGroup[], storage: readonly R2StorageGroup[]) {
  const byBucket = new Map<string, CloudflareR2DayUsage>();
  const bucket = (name: string) => {
    let b = byBucket.get(name);
    if (!b) {
      b = {
        bucketName: name,
        classA: 0,
        classB: 0,
        unclassified: 0,
        byAction: {},
        peakBytes: 0,
        peakObjects: 0,
      };
      byBucket.set(name, b);
    }
    return b;
  };
  for (const g of ops) {
    const name = g.dimensions?.bucketName;
    const action = g.dimensions?.actionType;
    if (!name || !action) continue;
    const b = bucket(name);
    const requests = num(g.sum?.requests);
    b.byAction[action] = (b.byAction[action] ?? 0) + requests;
    const cls = classifyR2Action(action);
    if (cls === 'A') b.classA += requests;
    else if (cls === 'B') b.classB += requests;
    else b.unclassified += requests;
  }
  for (const g of storage) {
    const name = g.dimensions?.bucketName;
    if (!name) continue;
    const b = bucket(name);
    b.peakBytes = Math.max(b.peakBytes, num(g.max?.payloadSize) + num(g.max?.metadataSize));
    b.peakObjects = Math.max(b.peakObjects, num(g.max?.objectCount));
  }
  return [...byBucket.values()].sort((a, b) => a.bucketName.localeCompare(b.bucketName));
}

export function foldWorkers(groups: readonly WorkersGroup[]): CloudflareWorkersDayUsage[] {
  const byScript = new Map<string, CloudflareWorkersDayUsage>();
  for (const g of groups) {
    const name = g.dimensions?.scriptName;
    if (!name) continue;
    const s = byScript.get(name) ?? { scriptName: name, requests: 0, errors: 0, subrequests: 0 };
    s.requests += num(g.sum?.requests);
    s.errors += num(g.sum?.errors);
    s.subrequests += num(g.sum?.subrequests);
    byScript.set(name, s);
  }
  return [...byScript.values()].sort((a, b) => a.scriptName.localeCompare(b.scriptName));
}

export class CloudflareAnalyticsClient implements CloudflareAnalyticsPort {
  private readonly endpoint: string;

  constructor(
    private readonly config: CloudflareAnalyticsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!IDENT.test(config.accountId)) {
      throw new CloudflareAnalyticsError('INVALID_ARGUMENT', 'bad account id');
    }
    this.endpoint = config.endpoint ?? CLOUDFLARE_GRAPHQL_ENDPOINT;
  }

  async r2Usage(
    query: CloudflareAnalyticsQuery & { buckets?: readonly string[] },
  ): Promise<CloudflareR2DayUsage[]> {
    assertDay(query.day);
    assertIdents('bucket', query.buckets);
    const account = await this.account(
      r2Query(this.config.accountId, query.day, query.buckets),
      query.signal,
    );
    const ops = asArray<R2OpsGroup>(account.ops, 'ops');
    const storage = asArray<R2StorageGroup>(account.storage, 'storage');
    return foldR2(ops, storage);
  }

  async workersUsage(
    query: CloudflareAnalyticsQuery & { scripts?: readonly string[] },
  ): Promise<CloudflareWorkersDayUsage[]> {
    assertDay(query.day);
    assertIdents('script', query.scripts);
    const account = await this.account(
      workersQuery(this.config.accountId, query.day, query.scripts),
      query.signal,
    );
    return foldWorkers(asArray<WorkersGroup>(account.invocations, 'invocations'));
  }

  /** One POST; returns the single account object every query is shaped around. */
  private async account(
    query: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ query }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new CloudflareAnalyticsError('BAD_RESPONSE', 'cloudflare graphql unreachable', err);
    }
    if (res.status === 401 || res.status === 403) {
      throw new CloudflareAnalyticsError('AUTH_FAILED', `cloudflare graphql ${res.status}`);
    }
    if (res.status === 429) {
      throw new CloudflareAnalyticsError('RATE_LIMITED', 'cloudflare graphql 429');
    }
    if (!res.ok) {
      throw new CloudflareAnalyticsError(`HTTP_${res.status}`, `cloudflare graphql ${res.status}`);
    }
    let body: GraphqlResponse;
    try {
      body = (await res.json()) as GraphqlResponse;
    } catch (err) {
      throw new CloudflareAnalyticsError('BAD_RESPONSE', 'cloudflare graphql: not json', err);
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const first = body.errors[0];
      const code = first?.extensions?.code ?? '';
      const authy = /authent|authoriz|permission|token/i.test(`${code} ${first?.message ?? ''}`);
      throw new CloudflareAnalyticsError(
        authy ? 'AUTH_FAILED' : 'GRAPHQL_ERROR',
        `cloudflare graphql: ${first?.message ?? 'error'}`,
      );
    }
    const accounts = body.data?.viewer?.accounts;
    if (!Array.isArray(accounts)) {
      throw new CloudflareAnalyticsError('BAD_RESPONSE', 'cloudflare graphql: no viewer.accounts');
    }
    // The filter names one account; an empty list means the token cannot see
    // it, which is a credential problem, not a quiet day.
    const account = accounts[0];
    if (!account || typeof account !== 'object') {
      throw new CloudflareAnalyticsError(
        'AUTH_FAILED',
        'cloudflare graphql: account not visible to token',
      );
    }
    return account as Record<string, unknown>;
  }
}

function asArray<T>(value: unknown, field: string): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CloudflareAnalyticsError('BAD_RESPONSE', `cloudflare graphql: ${field} not a list`);
  }
  return value as T[];
}

/**
 * INF-060 (Infra#114): `cloudflare/analytics-token` → `CLOUDFLARE_ANALYTICS_TOKEN`,
 * `cloudflare/account-id` → `CLOUDFLARE_ACCOUNT_ID`. Either absent → `null`,
 * and the caller registers nothing: the provider stays visible in the Cost
 * Center with freshness UNKNOWN, which is the truthful state. `R2_ACCOUNT_ID`
 * is accepted for the account id because it is the same account; the token
 * has no such fallback — the S3 credentials are a different scope entirely.
 */
export function cloudflareAnalyticsFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): CloudflareAnalyticsClient | null {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? env.R2_ACCOUNT_ID)?.trim();
  if (!token || !accountId) return null;
  return new CloudflareAnalyticsClient({ accountId, token }, fetchImpl);
}
