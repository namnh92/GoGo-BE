/**
 * COST-BE-025 (#384) — Upstash Developer API as a usage source (epic
 * §41-P2, §42.7).
 *
 * One endpoint, `GET /v2/redis/stats/{databaseId}` with HTTP Basic auth
 * (account email + Developer API key). The answer is what the console's
 * charts are drawn from — docs fetched 2026-09-03
 * (`upstash.com/docs/devops/developer-api/redis/get_database_stats`):
 *
 * - `dailyrequests` — one point per day, `y` = that day's request total;
 * - `bandwidths` — one point per day, `y` = that day's bytes;
 * - `diskusage` — point-in-time samples of bytes held;
 * - today's scalars `daily_net_commands`, `dailybandwidth`,
 *   `current_storage`, and month-to-date `total_monthly_*` totals;
 * - `days` — the weekday labels of the daily charts, whose length is the
 *   window those charts cover.
 *
 * Provider knowledge stays here (epic §5): the timestamp format is Go's
 * `time.String()` (`2025-09-04 15:12:52.76649148 +0000 UTC`), parsed into a
 * UTC instant and day; the series come back normalised to `{ day, at, value }`
 * so the collector never sees a raw `x`. What the endpoint does not say this
 * adapter does not invent: a field the body lacks is `null`, never 0, and no
 * total is extrapolated (epic §44.8).
 *
 * The Developer API has no per-request charge and no published rate limit;
 * the collector calls it four times a day.
 */

export type UpstashDeveloperApiConfig = {
  /** Account email — the Basic-auth username. */
  email: string;
  /** Developer API key from the console — the Basic-auth password. */
  apiKey: string;
  /** The database's id (console → database → id), not its name or endpoint. */
  databaseId: string;
  /** Override for tests; `UPSTASH_API_BASE` otherwise. */
  endpoint?: string;
};

/** One normalised chart point. `day` is the UTC day of `at`. */
export type UpstashPoint = { day: string; at: Date; value: number };

export type UpstashRedisStats = {
  /** `daily_net_commands`: "Total number of commands executed today". */
  dailyNetCommands: number | null;
  /** `dailybandwidth`: "Total daily bandwidth usage in bytes". */
  dailyBandwidthBytes: number | null;
  /** `current_storage`: "Current storage used (bytes)". */
  currentStorageBytes: number | null;
  totalMonthlyRequests: number | null;
  totalMonthlyBandwidthBytes: number | null;
  /** `total_monthly_storage`: "Total storage used in current month (bytes)". */
  totalMonthlyStorageBytes: number | null;
  /** `dailyrequests`, one point per day. */
  dailyRequests: UpstashPoint[];
  /** `bandwidths`, one point per day, bytes. */
  dailyBandwidth: UpstashPoint[];
  /** `diskusage`, point-in-time samples, bytes. */
  diskUsage: UpstashPoint[];
  /** Days the daily charts span (`days.length`); `null` when absent. */
  windowDays: number | null;
};

export type UpstashStatsQuery = { signal?: AbortSignal };

/**
 * The port the cost collector consumes. Structural, so a fixture-backed fake
 * in a test and the HTTP client below are interchangeable.
 */
export interface UpstashRedisStatsPort {
  stats(query?: UpstashStatsQuery): Promise<UpstashRedisStats>;
}

export type UpstashDeveloperApiErrorCode =
  | 'AUTH_FAILED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_RESPONSE'
  | 'INVALID_ARGUMENT'
  | `HTTP_${number}`;

/** `code` is what the collector scheduler stores on the freshness row. */
export class UpstashDeveloperApiError extends Error {
  constructor(
    readonly code: UpstashDeveloperApiErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'UpstashDeveloperApiError';
  }
}

export const UPSTASH_API_BASE = 'https://api.upstash.com/v2';

// Database ids are UUIDs; the check refuses nonsense before a request is made
// and keeps the id path-safe (it is also `encodeURIComponent`ed).
const DATABASE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Go's `time.String()`: `2025-09-04 15:12:52.76649148 +0000 UTC`. Fractional
 * seconds are optional and up to nine digits; the offset is optional and, when
 * present, applied so the day is UTC whatever zone the API renders in. A bare
 * `YYYY-MM-DD` and anything `Date.parse` accepts are taken as fallbacks.
 */
const GO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:\s*([+-])(\d{2}):?(\d{2}))?/;

export function parseUpstashTime(x: unknown): Date | null {
  if (typeof x !== 'string') return null;
  const m = GO_TIME.exec(x);
  if (m) {
    const [, y, mo, d, h, mi, s, frac, sign, oh, om] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | undefined,
      string | undefined,
      string | undefined,
      string | undefined,
    ];
    const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
    let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
    if (sign && oh && om) {
      const offset = (+oh * 60 + +om) * 60_000;
      t += sign === '+' ? -offset : offset;
    }
    return Number.isFinite(t) ? new Date(t) : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return new Date(`${x}T00:00:00Z`);
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t) : null;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

function scalar(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : null;
  return n !== null && Number.isFinite(n) ? n : null;
}

/**
 * Pure: a raw `{x, y}[]` chart → normalised points, sorted by time. Entries
 * whose `x` does not parse or whose `y` is not a finite number are dropped —
 * a point that cannot be placed on a day cannot be a day's figure.
 */
export function foldPoints(raw: unknown, field: string): UpstashPoint[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new UpstashDeveloperApiError('BAD_RESPONSE', `upstash stats: ${field} not a list`);
  }
  const out: UpstashPoint[] = [];
  for (const entry of raw as { x?: unknown; y?: unknown }[]) {
    if (!entry || typeof entry !== 'object') continue;
    const at = parseUpstashTime(entry.x);
    const value = scalar(entry.y);
    if (at === null || value === null) continue;
    out.push({ day: utcDay(at), at, value });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Pure: the endpoint's body → `UpstashRedisStats`. Exported for the fixture tests. */
export function foldStats(body: unknown): UpstashRedisStats {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new UpstashDeveloperApiError('BAD_RESPONSE', 'upstash stats: body is not an object');
  }
  const b = body as Record<string, unknown>;
  const days = b.days;
  return {
    dailyNetCommands: scalar(b.daily_net_commands),
    dailyBandwidthBytes: scalar(b.dailybandwidth),
    currentStorageBytes: scalar(b.current_storage),
    totalMonthlyRequests: scalar(b.total_monthly_requests),
    totalMonthlyBandwidthBytes: scalar(b.total_monthly_bandwidth),
    totalMonthlyStorageBytes: scalar(b.total_monthly_storage),
    dailyRequests: foldPoints(b.dailyrequests, 'dailyrequests'),
    dailyBandwidth: foldPoints(b.bandwidths, 'bandwidths'),
    diskUsage: foldPoints(b.diskusage, 'diskusage'),
    windowDays: Array.isArray(days) ? days.length : null,
  };
}

export class UpstashDeveloperApiClient implements UpstashRedisStatsPort {
  private readonly base: string;
  private readonly authorization: string;

  constructor(
    private readonly config: UpstashDeveloperApiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!DATABASE_ID.test(config.databaseId)) {
      throw new UpstashDeveloperApiError('INVALID_ARGUMENT', 'bad database id');
    }
    // Basic auth splits on the first colon; an email cannot carry one.
    if (!config.email || /[\s:]/.test(config.email) || !config.apiKey) {
      throw new UpstashDeveloperApiError('INVALID_ARGUMENT', 'bad email or api key');
    }
    this.base = (config.endpoint ?? UPSTASH_API_BASE).replace(/\/+$/, '');
    this.authorization = `Basic ${Buffer.from(`${config.email}:${config.apiKey}`, 'utf8').toString('base64')}`;
  }

  async stats(query: UpstashStatsQuery = {}): Promise<UpstashRedisStats> {
    const url = `${this.base}/redis/stats/${encodeURIComponent(this.config.databaseId)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: this.authorization, Accept: 'application/json' },
        ...(query.signal ? { signal: query.signal } : {}),
      });
    } catch (err) {
      if (query.signal?.aborted) throw err;
      throw new UpstashDeveloperApiError('BAD_RESPONSE', 'upstash developer api unreachable', err);
    }
    if (res.status === 401 || res.status === 403) {
      throw new UpstashDeveloperApiError('AUTH_FAILED', `upstash developer api ${res.status}`);
    }
    // The id names one database; 404 is a wrong id or one this account cannot
    // see — a configuration problem, not a quiet day.
    if (res.status === 404) {
      throw new UpstashDeveloperApiError('NOT_FOUND', 'upstash developer api: database not found');
    }
    if (res.status === 429) {
      throw new UpstashDeveloperApiError('RATE_LIMITED', 'upstash developer api 429');
    }
    if (!res.ok) {
      throw new UpstashDeveloperApiError(
        `HTTP_${res.status}`,
        `upstash developer api ${res.status}`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new UpstashDeveloperApiError('BAD_RESPONSE', 'upstash developer api: not json', err);
    }
    return foldStats(body);
  }
}

/**
 * INF-060 (Infra#114): `upstash/api-email` → `UPSTASH_API_EMAIL`,
 * `upstash/api-key` → `UPSTASH_API_KEY`, `upstash/database-id` →
 * `UPSTASH_DATABASE_ID`. Any absent → `null`, and the caller registers
 * nothing: the provider stays visible in the Cost Center with freshness
 * UNKNOWN, which is the truthful state. `REDIS_URL` is deliberately not a
 * fallback — it is the data-plane credential, a different scope entirely.
 */
export function upstashDeveloperApiFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): UpstashDeveloperApiClient | null {
  const email = env.UPSTASH_API_EMAIL?.trim();
  const apiKey = env.UPSTASH_API_KEY?.trim();
  const databaseId = env.UPSTASH_DATABASE_ID?.trim();
  if (!email || !apiKey || !databaseId) return null;
  return new UpstashDeveloperApiClient({ email, apiKey, databaseId }, fetchImpl);
}
