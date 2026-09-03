/**
 * COST-BE-027 (#386) — GitHub billing as the Actions usage/cost source
 * (epic §41-P2).
 *
 * **The endpoint issue #386 names no longer exists.**
 * `GET /users/{owner}/settings/billing/actions` (and the `/orgs/` form) was
 * shut down on **2025-09-26** when GitHub moved billing to the enhanced
 * billing platform. Its replacement is
 * `GET /{users|organizations}/{account}/settings/billing/usage`
 * (docs fetched 2026-09-03, `docs.github.com/en/rest/billing/usage`), which
 * answers with line items rather than the old minute counters:
 *
 * ```json
 * { "usageItems": [ { "date": "2026-09-02", "product": "actions",
 *                     "sku": "Actions Linux", "quantity": 120,
 *                     "unitType": "minutes", "pricePerUnit": 0.006,
 *                     "grossAmount": 0.72, "discountAmount": 0.72,
 *                     "netAmount": 0, "repositoryName": "namnh92/GoGo-BE" } ] }
 * ```
 *
 * That is strictly more than the old endpoint gave: every item carries its
 * own `date`, so a day's minutes are a **measured daily figure** rather than
 * a month-to-date counter differenced across runs, and `netAmount` is
 * GitHub's own money for the day — an ACTUAL cost, not an estimate.
 *
 * Provider knowledge stays here (epic §5): the account kind decides the path
 * (`/users/` for a user account, `/organizations/` for an org — GoGo's repos
 * are owned by a user), `year`/`month`/`day` narrow the report, only the past
 * 24 months are available, and amounts are plain JSON numbers in USD. What
 * the API does not say this adapter does not invent: a field the body lacks
 * is `null`, never 0.
 *
 * The endpoint is free and unmetered.
 */

export type GitHubAccountKind = 'user' | 'organization';

export type GitHubBillingConfig = {
  /** Fine-grained or classic token with the billing read permission. */
  token: string;
  /** The account whose billing is read — a login, not a display name. */
  account: string;
  /** Which billing path to use; GoGo's repos sit under a user account. */
  accountKind?: GitHubAccountKind;
  /** Override for tests; `GITHUB_API_BASE` otherwise. */
  endpoint?: string;
};

/** One `usageItems[]` entry, normalised. */
export type GitHubUsageItem = {
  /** UTC day of `date`. */
  day: string;
  /** `product`, lower-cased — `actions`, `packages`, `copilot`… */
  product: string;
  sku: string;
  quantity: number;
  /** `unitType`, lower-cased — `minutes`, `gigabytes`… */
  unitType: string | null;
  pricePerUnit: number | null;
  grossAmount: number | null;
  discountAmount: number | null;
  /** What GitHub actually charges after the included allowance. */
  netAmount: number | null;
  repositoryName: string | null;
  organizationName: string | null;
};

export type GitHubUsageQuery = {
  /** Four-digit year. */
  year: number;
  /** 1–12. Omit for the whole year. */
  month?: number;
  /** 1–31. Omit for the whole month. */
  day?: number;
  signal?: AbortSignal;
};

/**
 * The port the cost collector consumes. Structural, so a fixture-backed fake
 * in a test and the HTTP client below are interchangeable.
 */
export interface GitHubBillingPort {
  usage(query: GitHubUsageQuery): Promise<GitHubUsageItem[]>;
}

export type GitHubBillingErrorCode =
  | 'AUTH_FAILED'
  /** 403: the token lacks the billing permission, or the plan has no report. */
  | 'FORBIDDEN'
  /** 404: wrong account login, or an account not on the enhanced platform. */
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_RESPONSE'
  | 'INVALID_ARGUMENT'
  | `HTTP_${number}`;

/** `code` is what the collector scheduler stores on the freshness row. */
export class GitHubBillingError extends Error {
  constructor(
    readonly code: GitHubBillingErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'GitHubBillingError';
  }
}

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';

/** GitHub logins: alphanumerics and hyphens, up to 39 characters. */
const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;

const lower = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v.toLowerCase() : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Pure: a usage report body → its items. Exported for the fixture tests. An
 * entry without a parseable `date`, `product` or `quantity` is dropped — a
 * line that cannot be placed on a day and a product is not a fact about one.
 */
export function foldUsageReport(body: unknown): GitHubUsageItem[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GitHubBillingError('BAD_RESPONSE', 'github billing: body is not an object');
  }
  const items = (body as { usageItems?: unknown }).usageItems;
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) {
    throw new GitHubBillingError('BAD_RESPONSE', 'github billing: usageItems is not a list');
  }
  const out: GitHubUsageItem[] = [];
  for (const raw of items as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const date = typeof raw.date === 'string' ? raw.date.slice(0, 10) : null;
    const product = lower(raw.product);
    const quantity = num(raw.quantity);
    if (
      date === null ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      product === null ||
      quantity === null
    ) {
      continue;
    }
    out.push({
      day: date,
      product,
      sku: str(raw.sku) ?? '',
      quantity,
      unitType: lower(raw.unitType),
      pricePerUnit: num(raw.pricePerUnit),
      grossAmount: num(raw.grossAmount),
      discountAmount: num(raw.discountAmount),
      netAmount: num(raw.netAmount),
      repositoryName: str(raw.repositoryName),
      organizationName: str(raw.organizationName),
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.sku.localeCompare(b.sku));
}

export class GitHubBillingClient implements GitHubBillingPort {
  private readonly base: string;
  private readonly path: string;

  constructor(
    private readonly config: GitHubBillingConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!ACCOUNT.test(config.account)) {
      throw new GitHubBillingError('INVALID_ARGUMENT', 'bad github account login');
    }
    if (!config.token || /\s/.test(config.token)) {
      throw new GitHubBillingError('INVALID_ARGUMENT', 'bad github token');
    }
    this.base = (config.endpoint ?? GITHUB_API_BASE).replace(/\/+$/, '');
    const segment = config.accountKind === 'organization' ? 'organizations' : 'users';
    this.path = `/${segment}/${encodeURIComponent(config.account)}/settings/billing/usage`;
  }

  async usage(query: GitHubUsageQuery): Promise<GitHubUsageItem[]> {
    if (!Number.isInteger(query.year) || query.year < 2000 || query.year > 9999) {
      throw new GitHubBillingError('INVALID_ARGUMENT', 'bad year');
    }
    if (
      query.month !== undefined &&
      (!Number.isInteger(query.month) || query.month < 1 || query.month > 12)
    ) {
      throw new GitHubBillingError('INVALID_ARGUMENT', 'bad month');
    }
    if (
      query.day !== undefined &&
      (!Number.isInteger(query.day) || query.day < 1 || query.day > 31)
    ) {
      throw new GitHubBillingError('INVALID_ARGUMENT', 'bad day');
    }
    const params = new URLSearchParams({ year: String(query.year) });
    if (query.month !== undefined) params.set('month', String(query.month));
    if (query.day !== undefined) params.set('day', String(query.day));

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${this.path}?${params}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        ...(query.signal ? { signal: query.signal } : {}),
      });
    } catch (err) {
      if (query.signal?.aborted) throw err;
      throw new GitHubBillingError('BAD_RESPONSE', 'github billing unreachable', err);
    }
    if (res.status === 401) throw new GitHubBillingError('AUTH_FAILED', 'github billing 401');
    if (res.status === 403) throw new GitHubBillingError('FORBIDDEN', 'github billing 403');
    // 404 is also what a token without the billing permission gets, and what
    // an account outside the enhanced billing platform gets — both are
    // configuration, not a quiet month.
    if (res.status === 404) {
      throw new GitHubBillingError('NOT_FOUND', 'github billing: no usage report for this account');
    }
    if (res.status === 429) throw new GitHubBillingError('RATE_LIMITED', 'github billing 429');
    if (!res.ok) {
      throw new GitHubBillingError(`HTTP_${res.status}`, `github billing ${res.status}`);
    }
    try {
      return foldUsageReport(await res.json());
    } catch (err) {
      if (err instanceof GitHubBillingError) throw err;
      throw new GitHubBillingError('BAD_RESPONSE', 'github billing: not json', err);
    }
  }
}

/**
 * INF-060 (Infra#114): `github/billing-token` → `GITHUB_BILLING_TOKEN`,
 * `github/billing-account` → `GITHUB_BILLING_ACCOUNT` (defaulting to
 * `GITHUB_OWNER` where that is already set), and the optional
 * `GITHUB_BILLING_ACCOUNT_KIND` (`user` | `organization`, default `user`).
 * Either required value absent → `null`, and the caller registers nothing:
 * the provider stays visible in the Cost Center with freshness UNKNOWN.
 *
 * The token is read-only billing and nothing else; a repo-scoped CI token is
 * deliberately not a fallback.
 */
export function githubBillingFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): GitHubBillingClient | null {
  const token = env.GITHUB_BILLING_TOKEN?.trim();
  const account = (env.GITHUB_BILLING_ACCOUNT ?? env.GITHUB_OWNER)?.trim();
  if (!token || !account) return null;
  const kind = env.GITHUB_BILLING_ACCOUNT_KIND?.trim().toLowerCase();
  return new GitHubBillingClient(
    {
      token,
      account,
      accountKind: kind === 'organization' || kind === 'org' ? 'organization' : 'user',
    },
    fetchImpl,
  );
}
