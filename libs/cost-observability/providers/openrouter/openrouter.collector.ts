import type { Db } from '@gogo/database';
import type {
  OpenRouterActivityItem,
  OpenRouterKeyUsage,
  OpenRouterUsagePort,
} from '@gogo/providers';
import type { CollectorDefinition, CollectorRunContext } from '../../domain/collector';
import type { Confidence, CostSample, UsageSample } from '../../ports/collectors.port';
import {
  previousDay,
  upsertCostSamples,
  upsertUsageSamples,
} from '../../application/sample-writer';

/**
 * GoGo-BE#709 — what OpenRouter charged GoGo, per key holder:
 * `openrouter_activity` for the `openrouter` provider.
 *
 * Source: the management API (see `openrouter-usage.adapter.ts`) — `/keys`
 * for every key and its spend so far today, `/activity` per key for the last
 * 30 completed UTC days. 1 + N GETs per run (N = keys, a handful), all free.
 *
 * Keys are routed to a service by their label, the convention GoGo-Infra#241
 * sets when a key is created:
 *
 * | label                 | service                   |
 * | --------------------- | ------------------------- |
 * | `gogo-be-*`           | `openrouter.decisions`    |
 * | `gogo-ai-harness-*`   | `openrouter.dev_tooling`  |
 * | anything else         | `openrouter.other_keys`   |
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
 * completed figure replaces the partial one. Yesterday is always written for
 * every service that holds a key — a zero when `/activity` lists nothing for
 * it — so a partial row from yesterday cannot outlive the day; it stays
 * MEDIUM in that case, because OpenRouter may not have folded the day yet.
 * Older days with no item get **no row** (epic §44.6): absence is not zero.
 *
 * `metadata.byModel` keeps the per-model split, `metadata.keys` the label and
 * an 8-character hash prefix of each contributing key — never a secret.
 * BYOK spend (`byok_usage_inference`) is billed by the other provider, not
 * OpenRouter, so it stays in metadata and out of `amountMicros`.
 */
export const OPENROUTER_SOURCE = 'openrouter_api';
export const OPENROUTER_ACTIVITY_COLLECTOR_ID = 'openrouter_activity';

const PROVIDER = 'openrouter';
export const OPENROUTER_SERVICE = {
  decisions: 'openrouter.decisions',
  devTooling: 'openrouter.dev_tooling',
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

/** A key's label → the service its spend belongs to. */
export function openRouterServiceFor(label: string): OpenRouterServiceId {
  const l = label.trim().toLowerCase();
  if (/^gogo-be(-|$)/.test(l)) return OPENROUTER_SERVICE.decisions;
  if (/^gogo-ai-harness(-|$)/.test(l)) return OPENROUTER_SERVICE.devTooling;
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
const keyRef = (k: OpenRouterKeyUsage) => ({ label: k.label, hash: k.hash.slice(0, 8) });

type Bucket = {
  day: string;
  serviceId: OpenRouterServiceId;
  usd: number;
  byokUsd: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  byModel: Record<string, number>;
  keys: Map<string, { label: string; hash: string }>;
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
 * Pure: every key's `/activity` → completed-day cost and meter rows, plus a
 * yesterday row for each service that holds a key and spent nothing listed.
 * Items dated today or later are ignored (the window is completed days; a
 * stray one would fight today's MEDIUM row).
 */
export function activitySamples(
  ctx: OpenRouterSampleContext,
  keyed: readonly OpenRouterKeyActivity[],
): { cost: CostSample[]; usage: UsageSample[] } {
  const buckets = new Map<string, Bucket>();
  for (const { key, items } of keyed) {
    const serviceId = openRouterServiceFor(key.label);
    for (const it of items) {
      if (it.day >= ctx.today) continue;
      const id = `${it.day}\u0000${serviceId}`;
      let b = buckets.get(id);
      if (!b) {
        b = {
          day: it.day,
          serviceId,
          usd: 0,
          byokUsd: 0,
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
      b.byokUsd += it.byokUsageUsd;
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
        byokUsageMicros: micros(b.byokUsd),
        reasoningTokens: b.reasoningTokens,
        keys: [...b.keys.values()].sort((x, y) => x.label.localeCompare(y.label)),
      }),
    );
    usages.push(
      usage(ctx, b.day, b.serviceId, 'requests', b.requests),
      usage(ctx, b.day, b.serviceId, 'input_tokens', b.promptTokens),
      usage(ctx, b.day, b.serviceId, 'output_tokens', b.completionTokens),
    );
  }

  const yesterday = previousDay(ctx.today);
  const held = new Map<OpenRouterServiceId, OpenRouterKeyUsage[]>();
  for (const { key } of keyed) {
    const s = openRouterServiceFor(key.label);
    held.set(s, [...(held.get(s) ?? []), key]);
  }
  for (const [serviceId, keys] of [...held.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (buckets.has(`${yesterday}\u0000${serviceId}`)) continue;
    costs.push(
      cost(ctx, yesterday, serviceId, 0, 'MEDIUM', {
        from: 'activity',
        note: 'no activity item for the day yet; re-read on the next run',
        keys: keys.map(keyRef).sort((x, y) => x.label.localeCompare(y.label)),
      }),
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
    { usd: number; keys: { label: string; hash: string }[] }
  >();
  for (const k of keys) {
    const s = openRouterServiceFor(k.label);
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
        keys: e.keys.sort((x, y) => x.label.localeCompare(y.label)),
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
