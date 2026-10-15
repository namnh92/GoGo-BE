/**
 * BE#696 (ADR-0011 D-14) — Sentry's org usage stats as the source of the
 * `sentry.errors` meter: `GET /api/0/organizations/{org}/stats_v2/`.
 *
 * This is the REST API with a bearer token, not the `@sentry/node` SDK — the
 * #588 boundary (`apps/api/src/sentry-usage.spec.ts`) is not involved.
 *
 * Provider knowledge kept here (epic §5), checked against the live API on
 * 2026-10-15 with `groupBy=outcome&groupBy=project&category=error`:
 *
 * ```json
 * { "start": "2026-10-14T00:00:00Z", "end": "2026-10-15T00:00:00Z",
 *   "groups": [ { "by": { "project": 4512252504178688, "outcome": "accepted" },
 *                 "totals": { "sum(quantity)": 8 } } ] }
 * ```
 *
 * - **Grouping by project gives totals only** — no `intervals`, no `series`
 *   (the docs say so too). A day's figure therefore needs a query whose range
 *   is that one day: `start=<day>T00:00:00Z&end=<day>T23:59:59Z`, which Sentry
 *   echoes back as `[day, day+1)`. `end` is inclusive, so `end=<day+1>T00:00Z`
 *   would pull the next day's bucket in.
 * - `by.project` is a JSON number; `/projects/` gives `id` as a string. Both
 *   are compared as strings. Key order inside `by` is not stable.
 * - Groups with nothing in them are omitted: a 200 with `groups: []` for the
 *   requested day is a measured zero, not a missing day.
 *
 * Both endpoints need only `org:read` and are free.
 */

export type SentryStatsConfig = {
  /** Internal-integration token with Organization: Read. */
  token: string;
  /** Organization slug. */
  org: string;
  /** Override for tests; `SENTRY_API_BASE` otherwise. */
  endpoint?: string;
};

/** The outcomes stats_v2 reports, accepted first. */
export const SENTRY_OUTCOMES = [
  'accepted',
  'filtered',
  'rate_limited',
  'invalid',
  'abuse',
  'client_discard',
  'cardinality_limited',
] as const;
export type SentryOutcome = (typeof SENTRY_OUTCOMES)[number];

/** One `(project, outcome)` total for one UTC day. */
export type SentryOutcomeTotal = {
  /** Project id, as a string. */
  projectId: string;
  /** Lower-cased `outcome`; an outcome Sentry adds later passes through. */
  outcome: string;
  quantity: number;
};

/** One day's error counts, folded. */
export type SentryDayStats = {
  /** UTC day the totals cover. */
  day: string;
  totals: SentryOutcomeTotal[];
};

export type SentryProject = { id: string; slug: string };

export type SentryDayQuery = {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  signal?: AbortSignal;
};

/** The port the cost collector consumes. */
export interface SentryStatsPort {
  /** Error-category totals per project and outcome for one UTC day. */
  errorsForDay(query: SentryDayQuery): Promise<SentryDayStats>;
  projects(signal?: AbortSignal): Promise<SentryProject[]>;
}

export type SentryStatsErrorCode =
  | 'AUTH_FAILED'
  /** 403: the token lacks Organization: Read. */
  | 'FORBIDDEN'
  /** 404: wrong organization slug. */
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_RESPONSE'
  | 'INVALID_ARGUMENT'
  | `HTTP_${number}`;

/**
 * `code` is what the collector scheduler stores on the freshness row.
 * Messages never carry the URL, a header or the response body.
 */
export class SentryStatsError extends Error {
  constructor(
    readonly code: SentryStatsErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'SentryStatsError';
  }
}

export const SENTRY_API_BASE = 'https://sentry.io';
export const SENTRY_DEFAULT_ORG = 'gogo-vn';

/** Sentry slugs: lower-case alphanumerics, hyphens, underscores. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,49}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const QUANTITY = 'sum(quantity)';

const nextDay = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** `'2026-10-14T00:00:00Z'` / `'2026-10-14T00:00:00+00:00'` → epoch ms. */
const instant = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const id = (v: unknown): string | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    ? String(v)
    : typeof v === 'string' && /^\d+$/.test(v)
      ? v
      : null;

/**
 * Pure: a stats_v2 body for one requested day → that day's totals. Exported
 * for the fixture tests. The body must echo the day the query asked for; a
 * range that is not exactly `[day, day+1)` is a response for something else.
 * A group without a numeric total, a project or an outcome is dropped.
 */
export function foldDayStats(day: string, body: unknown): SentryDayStats {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SentryStatsError('BAD_RESPONSE', 'sentry stats: body is not an object');
  }
  const b = body as { start?: unknown; end?: unknown; groups?: unknown };
  const start = instant(b.start);
  const end = instant(b.end);
  if (start !== Date.parse(`${day}T00:00:00Z`) || end !== Date.parse(`${nextDay(day)}T00:00:00Z`)) {
    throw new SentryStatsError('BAD_RESPONSE', 'sentry stats: range is not the requested day');
  }
  if (b.groups === undefined || b.groups === null) return { day, totals: [] };
  if (!Array.isArray(b.groups)) {
    throw new SentryStatsError('BAD_RESPONSE', 'sentry stats: groups is not a list');
  }
  const totals: SentryOutcomeTotal[] = [];
  for (const raw of b.groups as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const by = raw.by as Record<string, unknown> | undefined;
    const t = raw.totals as Record<string, unknown> | undefined;
    const projectId = id(by?.project);
    const outcome =
      typeof by?.outcome === 'string' && by.outcome !== '' ? by.outcome.toLowerCase() : null;
    const quantity = t?.[QUANTITY];
    if (
      projectId === null ||
      outcome === null ||
      typeof quantity !== 'number' ||
      !Number.isFinite(quantity) ||
      quantity < 0
    ) {
      continue;
    }
    totals.push({ projectId, outcome, quantity });
  }
  totals.sort(
    (a, b) => a.projectId.localeCompare(b.projectId) || a.outcome.localeCompare(b.outcome),
  );
  return { day, totals };
}

/** Pure: a `/projects/` body → `{ id, slug }`, unusable entries dropped. */
export function foldProjects(body: unknown): SentryProject[] {
  if (!Array.isArray(body)) {
    throw new SentryStatsError('BAD_RESPONSE', 'sentry projects: body is not a list');
  }
  const out: SentryProject[] = [];
  for (const raw of body as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const projectId = id(raw.id);
    const slug = typeof raw.slug === 'string' && raw.slug !== '' ? raw.slug : null;
    if (projectId === null || slug === null) continue;
    out.push({ id: projectId, slug });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export class SentryStatsClient implements SentryStatsPort {
  private readonly base: string;
  private readonly orgPath: string;

  constructor(
    private readonly config: SentryStatsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!SLUG.test(config.org)) {
      throw new SentryStatsError('INVALID_ARGUMENT', 'bad sentry organization slug');
    }
    if (!config.token || /\s/.test(config.token)) {
      throw new SentryStatsError('INVALID_ARGUMENT', 'bad sentry token');
    }
    this.base = (config.endpoint ?? SENTRY_API_BASE).replace(/\/+$/, '');
    this.orgPath = `/api/0/organizations/${encodeURIComponent(config.org)}`;
  }

  async errorsForDay(query: SentryDayQuery): Promise<SentryDayStats> {
    if (!DAY.test(query.day) || Number.isNaN(Date.parse(`${query.day}T00:00:00Z`))) {
      throw new SentryStatsError('INVALID_ARGUMENT', 'bad day');
    }
    const params = new URLSearchParams([
      ['field', QUANTITY],
      ['groupBy', 'outcome'],
      ['groupBy', 'project'],
      ['category', 'error'],
      ['interval', '1d'],
      ['start', `${query.day}T00:00:00Z`],
      ['end', `${query.day}T23:59:59Z`],
    ]);
    const body = await this.get('stats', `/stats_v2/?${params}`, query.signal);
    return foldDayStats(query.day, body);
  }

  async projects(signal?: AbortSignal): Promise<SentryProject[]> {
    // GoGo has three projects; the first page (100) holds them all.
    return foldProjects(await this.get('projects', '/projects/', signal));
  }

  private async get(what: string, path: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${this.orgPath}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/json',
        },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      // The cause is a network error; it names the host, never the header.
      throw new SentryStatsError('BAD_RESPONSE', `sentry ${what} unreachable`, err);
    }
    if (res.status === 401) throw new SentryStatsError('AUTH_FAILED', `sentry ${what} 401`);
    if (res.status === 403) throw new SentryStatsError('FORBIDDEN', `sentry ${what} 403`);
    if (res.status === 404) throw new SentryStatsError('NOT_FOUND', `sentry ${what} 404`);
    if (res.status === 429) throw new SentryStatsError('RATE_LIMITED', `sentry ${what} 429`);
    if (!res.ok) {
      throw new SentryStatsError(`HTTP_${res.status}`, `sentry ${what} ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new SentryStatsError('BAD_RESPONSE', `sentry ${what}: not json`);
    }
  }
}

/**
 * Infra#212: `sentry/stats-token` → `SENTRY_STATS_TOKEN`, `sentry/org` →
 * `SENTRY_ORG` (default `gogo-vn`). No token → `null`, and the caller
 * registers nothing: the provider stays visible with freshness UNKNOWN.
 * Sentry is one org for every environment, so only the environment that
 * holds the token counts it (Infra writes it for `dev` only).
 */
export function sentryStatsFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): SentryStatsClient | null {
  const token = env.SENTRY_STATS_TOKEN?.trim();
  if (!token) return null;
  const org = env.SENTRY_ORG?.trim() || SENTRY_DEFAULT_ORG;
  return new SentryStatsClient({ token, org }, fetchImpl);
}
