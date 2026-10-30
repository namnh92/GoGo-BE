/**
 * GoGo-BE#709 — what OpenRouter charged, as OpenRouter reports it: the source
 * of the `openrouter_activity` cost collector.
 *
 * Contract checked against the official `@openrouter/sdk` 1.5.3 (generated
 * from OpenRouter's OpenAPI, published 2026-10-22; openrouter.ai itself was
 * not reachable from the authoring session):
 *
 * - `GET /api/v1/keys` — every API key on the account: `hash`, `name` (what
 *   the owner typed at creation), `label` (a **masked preview of the key
 *   itself**, `sk-or-v1-f2c...61a` — checked on the live account 2026-10-22;
 *   never read here), `usage_daily` (USD, current UTC day), `usage_monthly`, `disabled`.
 *   **Management key required.**
 * - `GET /api/v1/activity?api_key_hash=<hash>` — `data: [...]` for the last 30
 *   *completed* UTC days, one item per (date, model, endpoint): `date`
 *   (YYYY-MM-DD), `model`, `model_permaslug`, `provider_name`, `usage` (USD
 *   credits spent), `byok_usage_inference` (USD on the user's own provider
 *   key), `requests`, `prompt_tokens`, `completion_tokens`,
 *   `reasoning_tokens`, `cached_tokens`. **Management key required.**
 *
 * OpenRouter keys live in workspaces. `/keys` without `workspace_id` lists
 * only the Default Workspace, so the account's GoGo workspace is named by
 * `OPENROUTER_WORKSPACE_ID` (GoGo-BE#729) — a UUID; the slug answers 400.
 * `/activity` takes the key hash alone, whatever its workspace.
 *
 * Only these two GETs are made. A management key can also create and delete
 * keys; this client never calls those endpoints, and the key lives only in
 * the worker's environment (`openrouter/management-key`, GoGo-Infra#241).
 * Messages never carry the URL, a header or the response body.
 */

export type OpenRouterKeyUsage = {
  /** OpenRouter's key hash — an identifier, not the secret. */
  hash: string;
  /**
   * What the key was named at creation (`name`); drives service routing.
   * `(unnamed)` when the key has none. OpenRouter's `label` is a masked
   * preview of the secret, so it is never used, stored or logged.
   */
  name: string;
  disabled: boolean;
  /** USD spent on the current UTC day so far. */
  usageDailyUsd: number;
  usageMonthlyUsd: number;
};

export type OpenRouterActivityItem = {
  day: string;
  model: string;
  modelPermaslug: string | null;
  providerName: string | null;
  /** USD, OpenRouter credits spent. */
  usageUsd: number;
  /**
   * USD spent on the account's own provider keys (BYOK) — billed by that
   * provider, not OpenRouter. `null` when the item does not carry the field:
   * absent is unknown, never a measured zero.
   */
  byokUsageUsd: number | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
};

export interface OpenRouterUsagePort {
  keys(signal?: AbortSignal): Promise<OpenRouterKeyUsage[]>;
  /** Completed UTC days (up to 30) for one key. */
  activity(apiKeyHash: string, signal?: AbortSignal): Promise<OpenRouterActivityItem[]>;
}

export type OpenRouterUsageErrorCode =
  | 'AUTH_FAILED'
  /** 403: the key is not a management key. */
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'BAD_RESPONSE'
  | 'INVALID_ARGUMENT'
  | `HTTP_${number}`;

/** `code` is what the collector scheduler stores on the freshness row. */
export class OpenRouterUsageError extends Error {
  constructor(
    readonly code: OpenRouterUsageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpenRouterUsageError';
  }
}

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Pure: a `/keys` body → keys, unusable entries dropped. */
export function foldKeys(body: unknown): OpenRouterKeyUsage[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new OpenRouterUsageError('BAD_RESPONSE', 'openrouter keys: data is not a list');
  const out: OpenRouterKeyUsage[] = [];
  for (const raw of data as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const hash = str(raw.hash);
    const name = str(raw.name) ?? '(unnamed)';
    const daily = num(raw.usage_daily);
    const monthly = num(raw.usage_monthly);
    if (hash === null || daily === null || monthly === null) continue;
    out.push({
      hash,
      name,
      disabled: raw.disabled === true,
      usageDailyUsd: daily,
      usageMonthlyUsd: monthly,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pure: an `/activity` body → items. An item without a valid date, model or
 * USD figure is dropped rather than read as zero; an explicit empty list is a
 * measured "no spend in the window".
 */
export function foldActivity(body: unknown): OpenRouterActivityItem[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new OpenRouterUsageError('BAD_RESPONSE', 'openrouter activity: data is not a list');
  const out: OpenRouterActivityItem[] = [];
  for (const raw of data as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const day = str(raw.date);
    const model = str(raw.model);
    const usage = num(raw.usage);
    if (day === null || !DAY.test(day) || model === null || usage === null) continue;
    out.push({
      day,
      model,
      modelPermaslug: str(raw.model_permaslug),
      providerName: str(raw.provider_name),
      usageUsd: usage,
      byokUsageUsd: num(raw.byok_usage_inference),
      requests: Math.round(num(raw.requests) ?? 0),
      promptTokens: Math.round(num(raw.prompt_tokens) ?? 0),
      completionTokens: Math.round(num(raw.completion_tokens) ?? 0),
      reasoningTokens: Math.round(num(raw.reasoning_tokens) ?? 0),
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}

export class OpenRouterUsageClient implements OpenRouterUsagePort {
  private readonly base: string;

  constructor(
    private readonly managementKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    endpoint?: string,
    /** Workspace whose keys `/keys` lists; absent = the Default Workspace. */
    private readonly workspaceId?: string,
  ) {
    if (!managementKey || /\s/.test(managementKey)) {
      throw new OpenRouterUsageError('INVALID_ARGUMENT', 'bad openrouter management key');
    }
    if (workspaceId !== undefined && !UUID.test(workspaceId)) {
      throw new OpenRouterUsageError('INVALID_ARGUMENT', 'bad openrouter workspace id');
    }
    this.base = (endpoint ?? OPENROUTER_API_BASE).replace(/\/+$/, '');
  }

  async keys(signal?: AbortSignal): Promise<OpenRouterKeyUsage[]> {
    // GoGo holds a handful of keys; the first page holds them all.
    const path = this.workspaceId
      ? `/keys?${new URLSearchParams([['workspace_id', this.workspaceId]])}`
      : '/keys';
    return foldKeys(await this.get('keys', path, signal));
  }

  async activity(apiKeyHash: string, signal?: AbortSignal): Promise<OpenRouterActivityItem[]> {
    if (!HASH.test(apiKeyHash)) throw new OpenRouterUsageError('INVALID_ARGUMENT', 'bad key hash');
    const params = new URLSearchParams([['api_key_hash', apiKeyHash]]);
    return foldActivity(await this.get('activity', `/activity?${params}`, signal));
  }

  private async get(what: string, path: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.managementKey}`, Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      // The raw error is dropped: a fetch implementation may echo headers.
      throw new OpenRouterUsageError('BAD_RESPONSE', `openrouter ${what} unreachable`);
    }
    if (res.status === 401) throw new OpenRouterUsageError('AUTH_FAILED', `openrouter ${what} 401`);
    if (res.status === 403) throw new OpenRouterUsageError('FORBIDDEN', `openrouter ${what} 403`);
    if (res.status === 429)
      throw new OpenRouterUsageError('RATE_LIMITED', `openrouter ${what} 429`);
    if (!res.ok)
      throw new OpenRouterUsageError(`HTTP_${res.status}`, `openrouter ${what} ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new OpenRouterUsageError('BAD_RESPONSE', `openrouter ${what}: not json`);
    }
  }
}

/**
 * GoGo-Infra#241: `openrouter/management-key` → `OPENROUTER_MANAGEMENT_KEY`.
 * No key → `null`, and the caller registers nothing: the provider stays
 * visible with freshness UNKNOWN. One OpenRouter account serves every
 * environment, so only the environment holding the key counts it (dev).
 * `OPENROUTER_WORKSPACE_ID` (GoGo-BE#729, `openrouter/workspace-id`) picks the
 * workspace; blank keeps the Default Workspace, a non-UUID throws.
 */
export function openRouterUsageFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): OpenRouterUsageClient | null {
  const key = env.OPENROUTER_MANAGEMENT_KEY?.trim();
  if (!key) return null;
  const workspaceId = env.OPENROUTER_WORKSPACE_ID?.trim() || undefined;
  return new OpenRouterUsageClient(key, fetchImpl, undefined, workspaceId);
}
