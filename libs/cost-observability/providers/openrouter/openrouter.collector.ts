import type { Db } from '@gogo/database';
import type {
  OpenRouterActivityItem,
  OpenRouterKeyUsage,
  OpenRouterUsagePort,
} from '@gogo/providers';
import type { CollectorDefinition, CollectorRunContext } from '../../domain/collector';
import type { Confidence, CostSample, UsageSample } from '../../ports/collectors.port';
import { upsertCostSamples, upsertUsageSamples } from '../../application/sample-writer';

/**
 * GoGo-BE#709 — what OpenRouter charged GoGo, per key holder:
 * `openrouter_activity` for the `openrouter` provider.
 *
 * Source: the management API (see `openrouter-usage.adapter.ts`) — `/keys`
 * for every key and its spend so far today, `/activity` per key for the last
 * 30 completed UTC days. 1 + N GETs per run (N = keys, a handful), all free.
 *
 * Keys are routed to a service by their `name` (`-` or `_` between words),
 * the convention GoGo-Infra#241 sets when a key is created:
 *
 * | name                           | service                   |
 * | ------------------------------ | ------------------------- |
 * | `gogo_be_*`                    | `openrouter.decisions`    |
 * | `gogo_ai_harness_*`            | `openrouter.dev_tooling`  |
 * | `gogo_jev_*` (both of the above share it today) | `openrouter.jev_shared` |
 * | `gogo_claude_*` (BYOK)         | `openrouter.claude_byok`  |
 * | anything else                  | `openrouter.other_keys`   |
 *
 * Rows written per run (`replace`, not add — every figure is a day's total):
 *
 * | table                        | row                                                                          |
 * | ---------------------------- | ---------------------------------------------------------------------------- |
 * | `provider_cost_daily`        | `ACTUAL` USD per (completed day, service) from `/activity`, HIGH             |
 * | `provider_cost_daily`        | `ACTUAL` USD for today from `/keys usage_daily`, MEDIUM (the day is open)    |
 * | `provider_usage_meter_daily` | `requests`, `input_tokens`, `output_tokens` per (completed day, service)     |
 *
 * Today's MEDIUM row and the next day's HIGH row share one key, so the
 * completed figure replaces the partial one. A day `/activity` does not list
 * gets **no row** (epic §44.6): absence is not zero. That includes yesterday,
 * whose row may still hold the partial `usage_daily` figure written before
 * midnight — it stays, labelled MEDIUM `keys.usage_daily`, until OpenRouter
 * folds the day and the HIGH row replaces it (PR #710 review r4: a $0 here
 * replaced real spend for up to a run interval).
 *
 * `metadata.byModel` keeps the per-model split, `metadata.keys` the name and
 * an 8-character hash prefix of each contributing key — never a secret.
 * BYOK spend (`byok_usage_inference`) is billed by the other provider, not
 * OpenRouter, so it stays in metadata and out of `amountMicros`; the Claude
 * part of it is written for provider `anthropic` by the second collector in
 * this file, `anthropic_byok_openrouter`.
 */
export const OPENROUTER_SOURCE = 'openrouter_api';
export const OPENROUTER_ACTIVITY_COLLECTOR_ID = 'openrouter_activity';

const PROVIDER = 'openrouter';
export const OPENROUTER_SERVICE = {
  decisions: 'openrouter.decisions',
  devTooling: 'openrouter.dev_tooling',
  jevShared: 'openrouter.jev_shared',
  claudeByok: 'openrouter.claude_byok',
  otherKeys: 'openrouter.other_keys',
} as const;
type OpenRouterServiceId = (typeof OPENROUTER_SERVICE)[keyof typeof OPENROUTER_SERVICE];

export type OpenRouterCollectorOptions = {
  frequencyMs?: number;
  staleAfterMs?: number;
  timeoutMs?: number;
  maxCallsPerDay?: number;
  now?: () => Date;
};

const DEFAULTS = {
  frequencyMs: 6 * 60 * 60 * 1000,
  staleAfterMs: 24 * 60 * 60 * 1000,
  timeoutMs: 15_000,
  // Scheduler runs, not HTTP calls: 4 runs a day at 6 h, room for retries.
  maxCallsPerDay: 8,
};

/**
 * GoGo-BE#713 (ADR-0036) — the backend key `gogo_be_*` carries two models with
 * two bills: Jev (OpenRouter-direct, `openrouter.decisions`) and Claude Haiku
 * (Anthropic BYOK). A Claude item on that key is filed under
 * `openrouter.claude_byok` — OpenRouter's own charge for it is the BYOK
 * platform fee (0 inside the monthly allowance), its tokens are that
 * service's meters, and the inference itself is Anthropic's
 * (`anthropic_byok_openrouter`). So `openrouter.decisions` stays Jev alone and
 * nothing is counted twice. Harness keys keep their Claude on dev tooling.
 */
function serviceForItem(
  keyService: OpenRouterServiceId,
  it: OpenRouterActivityItem,
): OpenRouterServiceId {
  if (keyService === OPENROUTER_SERVICE.decisions && isAnthropic(it))
    return OPENROUTER_SERVICE.claudeByok;
  return keyService;
}

/** A key's name → the service its spend belongs to. */
export function openRouterServiceFor(name: string): OpenRouterServiceId {
  const l = name.trim().toLowerCase();
  if (/^gogo[-_]be([-_]|$)/.test(l)) return OPENROUTER_SERVICE.decisions;
  if (/^gogo[-_]ai[-_]harness([-_]|$)/.test(l)) return OPENROUTER_SERVICE.devTooling;
  if (/^gogo[-_]jev([-_]|$)/.test(l)) return OPENROUTER_SERVICE.jevShared;
  if (/^gogo[-_]claude([-_]|$)/.test(l)) return OPENROUTER_SERVICE.claudeByok;
  return OPENROUTER_SERVICE.otherKeys;
}

export type OpenRouterSampleContext = {
  /** The run's UTC day. */
  today: string;
  environment: string;
  now: Date;
};

export type OpenRouterKeyActivity = {
  key: OpenRouterKeyUsage;
  items: readonly OpenRouterActivityItem[];
};

const micros = (usd: number): number => Math.max(0, Math.round(usd * 1_000_000));
const keyRef = (k: OpenRouterKeyUsage) => ({ name: k.name, hash: k.hash.slice(0, 8) });

type Bucket = {
  day: string;
  serviceId: OpenRouterServiceId;
  usd: number;
  /** `null` while no item of the bucket carried the BYOK field. */
  byokUsd: number | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  byModel: Record<string, number>;
  keys: Map<string, { name: string; hash: string }>;
};

function cost(
  ctx: OpenRouterSampleContext,
  day: string,
  serviceId: string,
  usd: number,
  confidence: Confidence,
  metadata: Record<string, unknown>,
): CostSample {
  return {
    day,
    environment: ctx.environment,
    providerId: PROVIDER,
    serviceId,
    operationId: null,
    usageMetricId: null,
    billingSkuId: null,
    billableQuantity: null,
    billableUnit: null,
    amountMicros: micros(usd),
    currency: 'USD',
    basis: 'ACTUAL',
    confidence,
    source: OPENROUTER_SOURCE,
    costKind: 'USAGE',
    sourceAsOf: ctx.now,
    metadata,
  };
}

function usage(
  ctx: OpenRouterSampleContext,
  day: string,
  serviceId: string,
  metric: 'requests' | 'input_tokens' | 'output_tokens',
  quantity: number,
): UsageSample {
  return {
    day,
    environment: ctx.environment,
    providerId: PROVIDER,
    serviceId,
    operationId: null,
    usageMetricId: metric,
    billingSkuId: null,
    quantity: Math.max(0, Math.round(quantity)),
    unit: metric === 'requests' ? 'request' : 'token',
    source: OPENROUTER_SOURCE,
    confidence: 'HIGH',
    sourceAsOf: ctx.now,
    metadata: { from: 'activity' },
  };
}

/**
 * Pure: every key's `/activity` → completed-day cost and meter rows. A day
 * with no item writes nothing.
 * Items dated today or later are ignored (the window is completed days; a
 * stray one would fight today's MEDIUM row).
 */
export function activitySamples(
  ctx: OpenRouterSampleContext,
  keyed: readonly OpenRouterKeyActivity[],
): { cost: CostSample[]; usage: UsageSample[] } {
  const buckets = new Map<string, Bucket>();
  for (const { key, items } of keyed) {
    const keyService = openRouterServiceFor(key.name);
    for (const it of items) {
      if (it.day >= ctx.today) continue;
      const serviceId = serviceForItem(keyService, it);
      const id = `${it.day}\u0000${serviceId}`;
      let b = buckets.get(id);
      if (!b) {
        b = {
          day: it.day,
          serviceId,
          usd: 0,
          byokUsd: null,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          byModel: {},
          keys: new Map(),
        };
        buckets.set(id, b);
      }
      b.usd += it.usageUsd;
      if (it.byokUsageUsd !== null) b.byokUsd = (b.byokUsd ?? 0) + it.byokUsageUsd;
      b.requests += it.requests;
      b.promptTokens += it.promptTokens;
      b.completionTokens += it.completionTokens;
      b.reasoningTokens += it.reasoningTokens;
      b.byModel[it.model] = (b.byModel[it.model] ?? 0) + micros(it.usageUsd);
      b.keys.set(key.hash, keyRef(key));
    }
  }

  const costs: CostSample[] = [];
  const usages: UsageSample[] = [];
  const ordered = [...buckets.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.serviceId.localeCompare(b.serviceId),
  );
  for (const b of ordered) {
    costs.push(
      cost(ctx, b.day, b.serviceId, b.usd, 'HIGH', {
        from: 'activity',
        byModel: b.byModel,
        byokUsageMicros: b.byokUsd === null ? null : micros(b.byokUsd),
        reasoningTokens: b.reasoningTokens,
        keys: [...b.keys.values()].sort((x, y) => x.name.localeCompare(y.name)),
      }),
    );
    usages.push(
      usage(ctx, b.day, b.serviceId, 'requests', b.requests),
      usage(ctx, b.day, b.serviceId, 'input_tokens', b.promptTokens),
      usage(ctx, b.day, b.serviceId, 'output_tokens', b.completionTokens),
    );
  }

  return { cost: costs, usage: usages };
}

/** Pure: `/keys` → today's partial spend per service that holds a key. */
export function todaySamples(
  ctx: OpenRouterSampleContext,
  keys: readonly OpenRouterKeyUsage[],
): CostSample[] {
  const per = new Map<
    OpenRouterServiceId,
    { usd: number; keys: { name: string; hash: string }[] }
  >();
  for (const k of keys) {
    const s = openRouterServiceFor(k.name);
    const e = per.get(s) ?? { usd: 0, keys: [] };
    e.usd += k.usageDailyUsd;
    e.keys.push(keyRef(k));
    per.set(s, e);
  }
  return [...per.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([serviceId, e]) =>
      cost(ctx, ctx.today, serviceId, e.usd, 'MEDIUM', {
        from: 'keys.usage_daily',
        keys: e.keys.sort((x, y) => x.name.localeCompare(y.name)),
      }),
    );
}

/**
 * The definition, ready for `CollectorSchedulerService.register`. Build only
 * when `openRouterUsageFromEnv` returned a client; with none, register
 * nothing and the provider reads UNKNOWN.
 */
export function openRouterActivityCollector(
  db: Db,
  client: OpenRouterUsagePort,
  options: OpenRouterCollectorOptions = {},
): CollectorDefinition {
  const now = options.now ?? (() => new Date());
  return {
    id: OPENROUTER_ACTIVITY_COLLECTOR_ID,
    providerId: PROVIDER,
    serviceId: null,
    capability: 'ACTUAL_COST_COLLECTOR',
    frequencyMs: options.frequencyMs ?? DEFAULTS.frequencyMs,
    staleAfterMs: options.staleAfterMs ?? DEFAULTS.staleAfterMs,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retry: { maxAttemptsPerTick: 1 },
    maxCallsPerDay: options.maxCallsPerDay ?? DEFAULTS.maxCallsPerDay,
    // One OpenRouter account serves every environment; the management key
    // is written only where it should be counted (Infra: dev), which is the
    // real gate — as for Sentry.
    enabledEnvironments: 'all',
    essential: false,
    monitoringCost: {
      model: 'FREE',
      estimatedMonthlyMicros: 0,
      currency: 'USD',
      expectedRequestsPerMonth: 4 * 4 * 30,
      pricingSource:
        'OpenRouter management endpoints /keys and /activity have no documented per-request charge (contract read from @openrouter/sdk 1.5.3; not yet checked against a bill). 1 + N GETs per run, N = keys (about 3).',
      lastPricingReview: '2026-10-22',
    },
    run: async (ctx: CollectorRunContext) => {
      const at = now();
      const sampleCtx = { today: ctx.day, environment: ctx.environment, now: at };
      const keys = await client.keys(ctx.signal);
      // One key's activity failing throws and fails the run, so freshness
      // shows it; nothing is written from a partial read.
      const keyed: OpenRouterKeyActivity[] = [];
      for (const key of keys)
        keyed.push({ key, items: await client.activity(key.hash, ctx.signal) });
      const done = activitySamples(sampleCtx, keyed);
      let written = 0;
      written += await upsertCostSamples(db, [...done.cost, ...todaySamples(sampleCtx, keys)]);
      written += await upsertUsageSamples(db, done.usage);
      return { sourceAsOf: at, samples: written };
    },
  };
}

/**
 * GoGo-BE#709 — the Claude tokens a BYOK key spent on GoGo's own Anthropic
 * key: `anthropic_byok_openrouter` for provider `anthropic`. Same two GETs as
 * `openrouter_activity` (its own run, so its freshness is Anthropic's, not
 * OpenRouter's); the figure is `byok_usage_inference` on items whose model is
 * `anthropic/*` or whose provider is Anthropic, on any key.
 *
 * ACTUAL, MEDIUM: Anthropic bills it, OpenRouter reports it — a third party's
 * figure, not Anthropic's invoice. One row per completed day that has at
 * least one such item carrying the field; an item without it is unknown, not
 * zero, and a day with none gets no row. No today row (`/keys` carries no
 * BYOK split) and no meters (requests and tokens stay on
 * `openrouter.claude_byok`).
 */
export const ANTHROPIC_BYOK_COLLECTOR_ID = 'anthropic_byok_openrouter';
export const ANTHROPIC_BYOK_SERVICE = 'anthropic.claude_byok';

const isAnthropic = (it: OpenRouterActivityItem): boolean =>
  it.model.toLowerCase().startsWith('anthropic/') || /anthropic/i.test(it.providerName ?? '');

/** Pure: every key's `/activity` → one Anthropic cost row per completed day. */
export function anthropicByokSamples(
  ctx: OpenRouterSampleContext,
  keyed: readonly OpenRouterKeyActivity[],
): CostSample[] {
  type Day = {
    usd: number;
    byModel: Record<string, number>;
    keys: Map<string, { name: string; hash: string }>;
  };
  const days = new Map<string, Day>();
  for (const { key, items } of keyed) {
    for (const it of items) {
      if (it.day >= ctx.today || it.byokUsageUsd === null || !isAnthropic(it)) continue;
      const d: Day = days.get(it.day) ?? { usd: 0, byModel: {}, keys: new Map() };
      d.usd += it.byokUsageUsd;
      d.byModel[it.model] = (d.byModel[it.model] ?? 0) + micros(it.byokUsageUsd);
      d.keys.set(key.hash, keyRef(key));
      days.set(it.day, d);
    }
  }
  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, d]) => ({
      ...cost(ctx, day, ANTHROPIC_BYOK_SERVICE, d.usd, 'MEDIUM', {
        from: 'openrouter.activity.byok_usage_inference',
        byModel: d.byModel,
        keys: [...d.keys.values()].sort((x, y) => x.name.localeCompare(y.name)),
      }),
      providerId: 'anthropic',
    }));
}

export function anthropicByokCollector(
  db: Db,
  client: OpenRouterUsagePort,
  options: OpenRouterCollectorOptions = {},
): CollectorDefinition {
  const now = options.now ?? (() => new Date());
  return {
    id: ANTHROPIC_BYOK_COLLECTOR_ID,
    providerId: 'anthropic',
    serviceId: ANTHROPIC_BYOK_SERVICE,
    capability: 'ACTUAL_COST_COLLECTOR',
    frequencyMs: options.frequencyMs ?? DEFAULTS.frequencyMs,
    staleAfterMs: options.staleAfterMs ?? DEFAULTS.staleAfterMs,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retry: { maxAttemptsPerTick: 1 },
    maxCallsPerDay: options.maxCallsPerDay ?? DEFAULTS.maxCallsPerDay,
    enabledEnvironments: 'all',
    essential: false,
    monitoringCost: {
      model: 'FREE',
      estimatedMonthlyMicros: 0,
      currency: 'USD',
      expectedRequestsPerMonth: 4 * 4 * 30,
      pricingSource:
        'The same OpenRouter management endpoints as openrouter_activity (/keys, /activity), no documented per-request charge (@openrouter/sdk 1.5.3; not yet checked against a bill). 1 + N GETs per run.',
      lastPricingReview: '2026-10-22',
    },
    run: async (ctx: CollectorRunContext) => {
      const at = now();
      const keys = await client.keys(ctx.signal);
      const keyed: OpenRouterKeyActivity[] = [];
      for (const key of keys)
        keyed.push({ key, items: await client.activity(key.hash, ctx.signal) });
      const samples = anthropicByokSamples(
        { today: ctx.day, environment: ctx.environment, now: at },
        keyed,
      );
      return { sourceAsOf: at, samples: await upsertCostSamples(db, samples) };
    },
  };
}
