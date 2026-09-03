import { createHash, createHmac } from 'node:crypto';

/**
 * COST-BE-027 (#386) — AWS Cost Explorer as the ACTUAL-cost source
 * (epic §41-P2, §20–§22, §26).
 *
 * One operation, `GetCostAndUsage`, over the JSON-1.1 protocol: `POST /` to
 * `ce.<region>.amazonaws.com` with `X-Amz-Target:
 * AWSInsightsIndexService.GetCostAndUsage`, signed SigV4 (docs fetched
 * 2026-09-03, `docs.aws.amazon.com/aws-cost-management`). Signing is done
 * here rather than through the AWS SDK, for the reason already written down
 * in `r2-storage.adapter.ts`: SigV4 is a hashing recipe, not a protocol, and
 * one operation does not justify the dependency.
 *
 * Contract facts this adapter encodes, so the collector need not know them:
 *
 * - `TimePeriod.End` is **exclusive** — "if start is 2017-01-01 and end is
 *   2017-05-01 … up to and including 2017-04-30".
 * - `Granularity: DAILY`, `GroupBy: [{ Type: DIMENSION, Key: SERVICE }]`.
 * - `Metrics` are returned as **strings** (`Amount`, `Unit`), which is why
 *   nothing here parses money into a float and back: the decimal string is
 *   converted to integer micros directly.
 * - `ResultsByTime[].Estimated` marks a day AWS may still restate.
 * - `NextPageToken` paginates, and the request parameters must not change
 *   between pages (`RequestChangedException`).
 *
 * **This operation is charged: $0.01 per request** (epic §20). The collector
 * calls it once a day and the scheduler enforces `maxCallsPerDay: 1`; nothing
 * in this file retries on its own.
 */

export type AwsCostExplorerConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary-credential token, when the identity is an assumed role. */
  sessionToken?: string;
  /** Cost Explorer is a global service reached in one region; `us-east-1`. */
  region?: string;
  /** Override for tests; the regional Cost Explorer host otherwise. */
  endpoint?: string;
};

/** One (day, AWS service name) cost, as Cost Explorer reported it. */
export type AwsServiceCost = {
  /** UTC day — `ResultsByTime[].TimePeriod.Start`. */
  day: string;
  /** The `SERVICE` dimension value, e.g. `AWS Systems Manager`. */
  service: string;
  /** `UnblendedCost` in integer micros of `currency`. */
  unblendedMicros: number;
  /** `AmortizedCost` in integer micros, when the metric was returned. */
  amortizedMicros: number | null;
  currency: string;
  /** `ResultsByTime[].Estimated` — AWS may still restate this day. */
  estimated: boolean;
};

export type AwsCostQuery = {
  /** Inclusive UTC day. */
  from: string;
  /** **Inclusive** UTC day; the adapter converts to the API's exclusive end. */
  to: string;
  signal?: AbortSignal;
};

/**
 * The port the cost collector consumes. Structural, so a fixture-backed fake
 * in a test and the signed client below are interchangeable.
 */
export interface AwsCostExplorerPort {
  costsByService(query: AwsCostQuery): Promise<AwsServiceCost[]>;
}

export type AwsCostExplorerErrorCode =
  | 'AUTH_FAILED'
  | 'ACCESS_DENIED'
  | 'THROTTLED'
  | 'DATA_UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'BAD_RESPONSE'
  | 'INVALID_ARGUMENT'
  | `HTTP_${number}`;

/** `code` is what the collector scheduler stores on the freshness row. */
export class AwsCostExplorerError extends Error {
  constructor(
    readonly code: AwsCostExplorerErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'AwsCostExplorerError';
  }
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'ce';
export const AWS_CE_DEFAULT_REGION = 'us-east-1';
export const AWS_CE_TARGET = 'AWSInsightsIndexService.GetCostAndUsage';
const CONTENT_TYPE = 'application/x-amz-json-1.1';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGES = 20;

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest();

/** `2026-09-03` + n days, UTC. */
export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure: a Cost Explorer decimal string → integer micros, **without floating
 * point**. `"39.1603300457"` → `39_160_330`; the digits past the sixth are
 * dropped, not rounded away into a float first. A value that is not a decimal
 * number is rejected rather than guessed at.
 */
export function decimalToMicros(amount: unknown): number {
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    return Math.round(amount * 1_000_000);
  }
  if (typeof amount !== 'string') {
    throw new AwsCostExplorerError('BAD_RESPONSE', 'cost explorer: amount is not a string');
  }
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(amount.trim());
  if (m === null || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new AwsCostExplorerError('BAD_RESPONSE', `cost explorer: bad amount ${amount}`);
  }
  const [, sign, whole, frac] = m as unknown as [string, string, string, string | undefined];
  const micros =
    BigInt(whole === '' ? '0' : whole) * 1_000_000n +
    BigInt((frac ?? '').slice(0, 6).padEnd(6, '0'));
  const signed = sign === '-' ? -micros : micros;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new AwsCostExplorerError('BAD_RESPONSE', 'cost explorer: amount out of range');
  }
  return Number(signed);
}

function metric(
  metrics: Record<string, unknown> | undefined,
  name: string,
): { micros: number; currency: string } | null {
  const m = metrics?.[name];
  if (!m || typeof m !== 'object') return null;
  const { Amount, Unit } = m as { Amount?: unknown; Unit?: unknown };
  if (Amount === undefined || Amount === null) return null;
  return {
    micros: decimalToMicros(Amount),
    currency: typeof Unit === 'string' && Unit !== '' ? Unit : 'USD',
  };
}

/**
 * Pure: a `GetCostAndUsage` body → one entry per (day, service). Exported for
 * the fixture tests. A group whose `UnblendedCost` is absent is dropped — a
 * cost that was not reported is not a zero cost.
 */
export function foldCostAndUsage(body: unknown): AwsServiceCost[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AwsCostExplorerError('BAD_RESPONSE', 'cost explorer: body is not an object');
  }
  const results = (body as { ResultsByTime?: unknown }).ResultsByTime;
  if (results === undefined || results === null) return [];
  if (!Array.isArray(results)) {
    throw new AwsCostExplorerError('BAD_RESPONSE', 'cost explorer: ResultsByTime is not a list');
  }
  const out: AwsServiceCost[] = [];
  for (const r of results as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const period = r.TimePeriod as { Start?: unknown } | undefined;
    const day = typeof period?.Start === 'string' ? period.Start.slice(0, 10) : null;
    if (day === null || !DAY.test(day)) continue;
    const estimated = r.Estimated === true;
    const groups = r.Groups;
    if (groups !== undefined && groups !== null && !Array.isArray(groups)) {
      throw new AwsCostExplorerError('BAD_RESPONSE', 'cost explorer: Groups is not a list');
    }
    for (const g of (groups ?? []) as Record<string, unknown>[]) {
      if (!g || typeof g !== 'object') continue;
      const keys = g.Keys;
      const service = Array.isArray(keys) && typeof keys[0] === 'string' ? keys[0] : null;
      if (service === null || service === '') continue;
      const metrics = g.Metrics as Record<string, unknown> | undefined;
      const unblended = metric(metrics, 'UnblendedCost');
      if (unblended === null) continue;
      const amortized = metric(metrics, 'AmortizedCost');
      out.push({
        day,
        service,
        unblendedMicros: unblended.micros,
        amortizedMicros: amortized?.micros ?? null,
        currency: unblended.currency,
        estimated,
      });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.service.localeCompare(b.service));
}

export class AwsCostExplorerClient implements AwsCostExplorerPort {
  private readonly region: string;
  private readonly host: string;
  private readonly base: string;

  constructor(
    private readonly config: AwsCostExplorerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new AwsCostExplorerError('INVALID_ARGUMENT', 'bad aws credentials');
    }
    this.region = config.region?.trim() || AWS_CE_DEFAULT_REGION;
    const endpoint = config.endpoint ?? `https://ce.${this.region}.amazonaws.com`;
    this.base = endpoint.replace(/\/+$/, '');
    this.host = new URL(this.base).host;
  }

  async costsByService(query: AwsCostQuery): Promise<AwsServiceCost[]> {
    if (!DAY.test(query.from) || !DAY.test(query.to) || query.from > query.to) {
      throw new AwsCostExplorerError('INVALID_ARGUMENT', 'bad cost explorer window');
    }
    const out: AwsServiceCost[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // The API's End is exclusive; the port's `to` is inclusive.
      const request: Record<string, unknown> = {
        TimePeriod: { Start: query.from, End: shiftDay(query.to, 1) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost', 'AmortizedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      };
      if (token !== null) request.NextPageToken = token;
      const body = await this.post(JSON.stringify(request), query.signal);
      out.push(...foldCostAndUsage(body));
      const next = (body as { NextPageToken?: unknown }).NextPageToken;
      if (typeof next !== 'string' || next === '' || next === token) return out;
      token = next;
    }
    throw new AwsCostExplorerError('BAD_RESPONSE', `cost explorer: more than ${MAX_PAGES} pages`);
  }

  private async post(payload: string, signal: AbortSignal | undefined): Promise<unknown> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.region}/${SERVICE}/aws4_request`;
    const payloadHash = sha256Hex(payload);

    const headers: Record<string, string> = {
      'content-type': CONTENT_TYPE,
      host: this.host,
      'x-amz-date': amzDate,
      'x-amz-target': AWS_CE_TARGET,
    };
    if (this.config.sessionToken) headers['x-amz-security-token'] = this.config.sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]!.trim()}\n`)
      .join('');

    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join(
      '\n',
    );
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.region), SERVICE),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/`, {
        method: 'POST',
        headers: {
          ...headers,
          Accept: 'application/json',
          Authorization: `${ALGORITHM} Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body: payload,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new AwsCostExplorerError('BAD_RESPONSE', 'cost explorer unreachable', err);
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (err) {
        throw new AwsCostExplorerError('BAD_RESPONSE', 'cost explorer: not json', err);
      }
    }
    throw await this.errorFor(res);
  }

  /**
   * The JSON protocol answers 400 for nearly everything and names the real
   * error in `__type`; a code the freshness row can be read against has to
   * come from there, not from the status alone.
   */
  private async errorFor(res: Response): Promise<AwsCostExplorerError> {
    let type = '';
    let message = '';
    try {
      const body = (await res.json()) as { __type?: unknown; message?: unknown; Message?: unknown };
      if (typeof body.__type === 'string') type = body.__type.split('#').pop() ?? '';
      const m = body.message ?? body.Message;
      if (typeof m === 'string') message = m;
    } catch {
      // A non-JSON error body tells us nothing beyond the status.
    }
    const detail = `cost explorer ${res.status}${type ? ` ${type}` : ''}`;
    if (
      res.status === 401 ||
      type === 'UnrecognizedClientException' ||
      type === 'InvalidSignatureException'
    ) {
      return new AwsCostExplorerError('AUTH_FAILED', detail);
    }
    if (res.status === 403 || type === 'AccessDeniedException') {
      return new AwsCostExplorerError('ACCESS_DENIED', detail);
    }
    if (res.status === 429 || type === 'LimitExceededException' || type === 'ThrottlingException') {
      return new AwsCostExplorerError('THROTTLED', detail);
    }
    if (type === 'DataUnavailableException' || type === 'BillExpirationException') {
      return new AwsCostExplorerError('DATA_UNAVAILABLE', detail);
    }
    if (res.status === 400) {
      return new AwsCostExplorerError('BAD_REQUEST', message ? `${detail}: ${message}` : detail);
    }
    return new AwsCostExplorerError(`HTTP_${res.status}`, detail);
  }
}

/**
 * INF-060 (Infra#114): `aws/cost-explorer-access-key-id` →
 * `AWS_COST_EXPLORER_ACCESS_KEY_ID`, `aws/cost-explorer-secret-access-key` →
 * `AWS_COST_EXPLORER_SECRET_ACCESS_KEY`, optional
 * `AWS_COST_EXPLORER_REGION`. Either of the two required values absent →
 * `null`, and the caller registers nothing: the provider stays visible in the
 * Cost Center with freshness UNKNOWN, which is the truthful state.
 *
 * The generic `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pair is
 * deliberately **not** a fallback. This collector spends money on every call
 * and needs exactly one permission (`ce:GetCostAndUsage`); inheriting whatever
 * ambient identity the worker happens to run under would make both the spend
 * and the blast radius accidental.
 */
export function awsCostExplorerFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): AwsCostExplorerClient | null {
  const accessKeyId = env.AWS_COST_EXPLORER_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_COST_EXPLORER_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = env.AWS_COST_EXPLORER_SESSION_TOKEN?.trim();
  const region = env.AWS_COST_EXPLORER_REGION?.trim();
  return new AwsCostExplorerClient(
    {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      ...(region ? { region } : {}),
    },
    fetchImpl,
  );
}
