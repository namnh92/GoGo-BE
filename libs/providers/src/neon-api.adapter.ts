/**
 * COST-BE-026 (#385) — the Neon API as a usage source (epic §41-P2).
 *
 * Two read-only endpoints on `console.neon.tech/api/v2`, Bearer API key
 * (docs fetched 2026-09-03, `api-docs.neon.tech`):
 *
 * - `GET /consumption_history/projects?org_id=…&project_ids=…&granularity=daily`
 *   — one consumption entry per UTC day (`timeframe_start`/`timeframe_end`)
 *   with `active_time_seconds`, `compute_time_seconds`, `written_data_bytes`,
 *   `synthetic_storage_size_bytes` and, when asked, `data_storage_bytes_hour`.
 *   **`org_id` is mandatory** (#411, live DEV 2026-09-05: without it the API
 *   answers 400 "org_id is required"); it is read once from `GET /projects/{id}`
 *   (`project.org_id`) and cached, or given in the config. **Scale plans and
 *   above only** — Free and Launch get a 403 ("included with Scale plans and
 *   above"), which this adapter reports as `PLAN_NOT_SUPPORTED` so the
 *   collector can fall back rather than fail.
 * - `GET /projects/{id}` — every plan. Carries the same counters as
 *   **period-to-date totals** since `consumption_period_start` (they reset at
 *   the billing period), plus `data_transfer_bytes` (which the history
 *   endpoint does not list) and the live `synthetic_storage_size`.
 *
 * Provider knowledge stays here (epic §5): plan gating, the shape of both
 * bodies, cursor pagination, the 403 / 406 meanings. What the API does not say
 * this adapter does not invent: a counter the body lacks is `null`, never 0,
 * and nothing is extrapolated (epic §44.8). Neither call wakes a compute
 * endpoint, and neither is charged.
 */

export type NeonApiConfig = {
  /** Personal or organisation API key — read-only use. */
  apiKey: string;
  /** The project's id (console → project settings → id), not its name. */
  projectId: string;
  /**
   * The organisation the project belongs to (`project.org_id`). Optional:
   * when absent it is read from `GET /projects/{id}` the first time the
   * history endpoint needs it and cached for the client's lifetime.
   */
  orgId?: string;
  /** Override for tests; `NEON_API_BASE` otherwise. */
  endpoint?: string;
};

/** One `consumption[]` entry of the history endpoint, folded to its UTC day. */
export type NeonConsumptionDay = {
  /** UTC day of `timeframe_start`. */
  day: string;
  timeframeStart: Date;
  timeframeEnd: Date;
  /** `period_plan` of the billing period the entry sits in. */
  periodPlan: string | null;
  activeTimeSeconds: number | null;
  /** CPU seconds = active seconds × compute size (CU). `/ 3600` = CU-hours. */
  computeTimeSeconds: number | null;
  writtenDataBytes: number | null;
  /** Storage held at the timeframe (logical size + WAL, all branches). */
  syntheticStorageSizeBytes: number | null;
  dataStorageBytesHour: number | null;
  /** Not documented for this endpoint; folded when a body carries it. */
  dataTransferBytes: number | null;
};

/** `GET /projects/{id}` — the period-to-date counters and the live storage size. */
export type NeonProjectConsumption = {
  projectId: string;
  consumptionPeriodStart: Date | null;
  consumptionPeriodEnd: Date | null;
  activeTimeSeconds: number | null;
  computeTimeSeconds: number | null;
  writtenDataBytes: number | null;
  dataStorageBytesHour: number | null;
  /** Egress to clients over the public internet, period-to-date. */
  dataTransferBytes: number | null;
  /** `synthetic_storage_size`: the current space occupied. */
  syntheticStorageSizeBytes: number | null;
};

export type NeonHistoryQuery = { from: Date; to: Date; signal?: AbortSignal };
export type NeonProjectQuery = { signal?: AbortSignal };

/**
 * The port the cost collector consumes. Structural, so a fixture-backed fake
 * in a test and the HTTP client below are interchangeable.
 */
export interface NeonUsagePort {
  consumptionHistory(query: NeonHistoryQuery): Promise<NeonConsumptionDay[]>;
  project(query?: NeonProjectQuery): Promise<NeonProjectConsumption>;
}

export type NeonApiErrorCode =
  | 'AUTH_FAILED'
  /** 403 on the history endpoint: the plan does not include it. */
  | 'PLAN_NOT_SUPPORTED'
  | 'NOT_FOUND'
  /** 406: the date range falls outside what the granularity allows. */
  | 'RANGE_REJECTED'
  | 'RATE_LIMITED'
  | 'BAD_RESPONSE'
  | 'INVALID_ARGUMENT'
  | `HTTP_${number}`;

/** `code` is what the collector scheduler stores on the freshness row. */
export class NeonApiError extends Error {
  constructor(
    readonly code: NeonApiErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'NeonApiError';
  }
}

export const NEON_API_BASE = 'https://console.neon.tech/api/v2';

/** Project ids are `^[a-z0-9-]{1,60}$` in the API's own schema. */
const PROJECT_ID = /^[a-z0-9-]{1,60}$/;

/** Follow at most this many history pages; one project fits in one. */
const MAX_PAGES = 10;

function scalar(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : null;
  return n !== null && Number.isFinite(n) ? n : null;
}

function instant(v: unknown): Date | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

function record(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new NeonApiError('BAD_RESPONSE', `neon api: ${what} is not an object`);
  }
  return v as Record<string, unknown>;
}

const sumOrNull = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
const maxOrNull = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

/**
 * Pure: one history page → the project's days, merged. Entries whose
 * `timeframe_start` does not parse are dropped — a figure that cannot be
 * placed on a day cannot be a day's figure. Two entries on one day (a plan
 * change splits the day across two `periods`) are summed; the storage gauge
 * keeps its maximum. `periodPlan` keeps the later period's plan.
 */
export function foldConsumptionHistory(body: unknown, projectId: string): NeonConsumptionDay[] {
  const b = record(body, 'history body');
  const projects = b.projects;
  if (projects !== undefined && !Array.isArray(projects)) {
    throw new NeonApiError('BAD_RESPONSE', 'neon api: projects is not a list');
  }
  const byDay = new Map<string, NeonConsumptionDay>();
  for (const p of (projects ?? []) as unknown[]) {
    const project = record(p, 'project');
    if (project.project_id !== projectId) continue;
    const periods = project.periods;
    if (periods !== undefined && !Array.isArray(periods)) {
      throw new NeonApiError('BAD_RESPONSE', 'neon api: periods is not a list');
    }
    for (const per of (periods ?? []) as unknown[]) {
      const period = record(per, 'period');
      const plan = typeof period.period_plan === 'string' ? period.period_plan : null;
      const consumption = period.consumption;
      if (consumption !== undefined && !Array.isArray(consumption)) {
        throw new NeonApiError('BAD_RESPONSE', 'neon api: consumption is not a list');
      }
      for (const c of (consumption ?? []) as unknown[]) {
        const entry = record(c, 'consumption entry');
        const start = instant(entry.timeframe_start);
        if (start === null) continue;
        const end = instant(entry.timeframe_end) ?? start;
        const next: NeonConsumptionDay = {
          day: utcDay(start),
          timeframeStart: start,
          timeframeEnd: end,
          periodPlan: plan,
          activeTimeSeconds: scalar(entry.active_time_seconds),
          computeTimeSeconds: scalar(entry.compute_time_seconds),
          writtenDataBytes: scalar(entry.written_data_bytes),
          syntheticStorageSizeBytes: scalar(entry.synthetic_storage_size_bytes),
          dataStorageBytesHour: scalar(entry.data_storage_bytes_hour),
          dataTransferBytes: scalar(entry.data_transfer_bytes),
        };
        const prev = byDay.get(next.day);
        byDay.set(
          next.day,
          prev === undefined
            ? next
            : {
                day: next.day,
                timeframeStart:
                  prev.timeframeStart < next.timeframeStart
                    ? prev.timeframeStart
                    : next.timeframeStart,
                timeframeEnd:
                  prev.timeframeEnd > next.timeframeEnd ? prev.timeframeEnd : next.timeframeEnd,
                periodPlan: next.periodPlan ?? prev.periodPlan,
                activeTimeSeconds: sumOrNull(prev.activeTimeSeconds, next.activeTimeSeconds),
                computeTimeSeconds: sumOrNull(prev.computeTimeSeconds, next.computeTimeSeconds),
                writtenDataBytes: sumOrNull(prev.writtenDataBytes, next.writtenDataBytes),
                syntheticStorageSizeBytes: maxOrNull(
                  prev.syntheticStorageSizeBytes,
                  next.syntheticStorageSizeBytes,
                ),
                dataStorageBytesHour: sumOrNull(
                  prev.dataStorageBytesHour,
                  next.dataStorageBytesHour,
                ),
                dataTransferBytes: sumOrNull(prev.dataTransferBytes, next.dataTransferBytes),
              },
        );
      }
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Pure: the `GET /projects/{id}` body → the period-to-date counters. */
export function foldProject(body: unknown): NeonProjectConsumption {
  const b = record(body, 'project body');
  const p = record(b.project, 'project');
  if (typeof p.id !== 'string' || p.id === '') {
    throw new NeonApiError('BAD_RESPONSE', 'neon api: project without an id');
  }
  return {
    projectId: p.id,
    consumptionPeriodStart: instant(p.consumption_period_start),
    consumptionPeriodEnd: instant(p.consumption_period_end),
    activeTimeSeconds: scalar(p.active_time_seconds),
    computeTimeSeconds: scalar(p.compute_time_seconds),
    writtenDataBytes: scalar(p.written_data_bytes),
    dataStorageBytesHour: scalar(p.data_storage_bytes_hour),
    dataTransferBytes: scalar(p.data_transfer_bytes),
    syntheticStorageSizeBytes: scalar(p.synthetic_storage_size),
  };
}

export class NeonApiClient implements NeonUsagePort {
  private readonly base: string;
  private readonly authorization: string;
  /** `project.org_id`, from the config or the first project read. */
  private orgId: string | null;

  constructor(
    private readonly config: NeonApiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!PROJECT_ID.test(config.projectId)) {
      throw new NeonApiError('INVALID_ARGUMENT', 'bad project id');
    }
    if (!config.apiKey || /\s/.test(config.apiKey)) {
      throw new NeonApiError('INVALID_ARGUMENT', 'bad api key');
    }
    this.base = (config.endpoint ?? NEON_API_BASE).replace(/\/+$/, '');
    this.authorization = `Bearer ${config.apiKey}`;
    const orgId = config.orgId?.trim();
    this.orgId = orgId ? orgId : null;
  }

  async consumptionHistory(query: NeonHistoryQuery): Promise<NeonConsumptionDay[]> {
    if (!(query.from < query.to)) {
      throw new NeonApiError('INVALID_ARGUMENT', 'history window must be from < to');
    }
    const orgId = await this.resolveOrgId(query.signal);
    const days: NeonConsumptionDay[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        org_id: orgId,
        from: query.from.toISOString(),
        to: query.to.toISOString(),
        granularity: 'daily',
        project_ids: this.config.projectId,
        limit: '100',
      });
      if (cursor !== null) params.set('cursor', cursor);
      const body = await this.get(`/consumption_history/projects?${params}`, query.signal, {
        forbidden: 'PLAN_NOT_SUPPORTED',
      });
      days.push(...foldConsumptionHistory(body, this.config.projectId));
      const next = (body as { pagination?: { cursor?: unknown } }).pagination?.cursor;
      if (typeof next !== 'string' || next === '' || next === cursor) return days;
      cursor = next;
    }
    throw new NeonApiError('BAD_RESPONSE', `neon api: more than ${MAX_PAGES} history pages`);
  }

  async project(query: NeonProjectQuery = {}): Promise<NeonProjectConsumption> {
    const body = await this.get(
      `/projects/${encodeURIComponent(this.config.projectId)}`,
      query.signal,
      { forbidden: 'AUTH_FAILED' },
    );
    this.rememberOrgId(body);
    return foldProject(body);
  }

  /**
   * #411 — the history endpoint refuses a request without `org_id`. The
   * project body carries it, so the first history call pays one project read
   * and every later one reuses the answer; a `project()` call made earlier
   * already filled it. A project without an `org_id` is a body this adapter
   * does not understand, reported as such rather than retried without.
   */
  private async resolveOrgId(signal: AbortSignal | undefined): Promise<string> {
    if (this.orgId !== null) return this.orgId;
    const body = await this.get(`/projects/${encodeURIComponent(this.config.projectId)}`, signal, {
      forbidden: 'AUTH_FAILED',
    });
    this.rememberOrgId(body);
    if (this.orgId === null) {
      throw new NeonApiError('BAD_RESPONSE', 'neon api: project without an org_id');
    }
    return this.orgId;
  }

  private rememberOrgId(body: unknown): void {
    if (this.orgId !== null) return;
    const project = (body as { project?: { org_id?: unknown } } | null)?.project;
    const orgId = project?.org_id;
    if (typeof orgId === 'string' && orgId !== '') this.orgId = orgId;
  }

  private async get(
    path: string,
    signal: AbortSignal | undefined,
    meaning: { forbidden: NeonApiErrorCode },
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers: { Authorization: this.authorization, Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new NeonApiError('BAD_RESPONSE', 'neon api unreachable', err);
    }
    if (res.status === 401) throw new NeonApiError('AUTH_FAILED', 'neon api 401');
    // 403 means two different things: on the history endpoint the docs say
    // "not available" outside the usage-based plans; on a project it is a key
    // that cannot see it.
    if (res.status === 403) throw new NeonApiError(meaning.forbidden, 'neon api 403');
    if (res.status === 404) throw new NeonApiError('NOT_FOUND', 'neon api: project not found');
    if (res.status === 406) {
      throw new NeonApiError('RANGE_REJECTED', 'neon api 406: range outside granularity bounds');
    }
    if (res.status === 429) throw new NeonApiError('RATE_LIMITED', 'neon api 429');
    if (!res.ok) throw new NeonApiError(`HTTP_${res.status}`, `neon api ${res.status}`);
    try {
      return await res.json();
    } catch (err) {
      throw new NeonApiError('BAD_RESPONSE', 'neon api: not json', err);
    }
  }
}

/**
 * INF-060 (Infra#114) / INF-008 (Infra#8): `neon/api-key` → `NEON_API_KEY`,
 * `neon/project-id` → `NEON_PROJECT_ID`. Either absent → `null`, and the
 * caller registers nothing: the provider stays visible in the Cost Center
 * with freshness UNKNOWN, which is the truthful state. `DATABASE_URL` is
 * deliberately not a fallback — it is the data-plane credential and names an
 * endpoint host, not the project id.
 */
export function neonApiFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): NeonApiClient | null {
  const apiKey = env.NEON_API_KEY?.trim();
  const projectId = env.NEON_PROJECT_ID?.trim();
  if (!apiKey || !projectId) return null;
  return new NeonApiClient({ apiKey, projectId }, fetchImpl);
}
