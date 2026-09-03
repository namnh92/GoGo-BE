import { previousDay, upsertUsageSamples } from '../../application/sample-writer';
import type { Db } from '@gogo/database';
import type {
  CloudflareAnalyticsPort,
  CloudflareR2DayUsage,
  CloudflareWorkersDayUsage,
} from '@gogo/providers';
import type {
  CollectorDefinition,
  CollectorRunContext,
  CollectorRunResult,
} from '../../domain/collector';
import type { Confidence, UsageSample } from '../../ports/collectors.port';

/**
 * COST-BE-024 (#383) — two Cloudflare usage collectors on the generic
 * scheduler (epic §19, §41-P2, §42.8–.9): `cloudflare_r2` for
 * `cloudflare.r2` and `cloudflare_workers` for `cloudflare.workers`.
 *
 * Each run reads the day's totals for today and yesterday from the GraphQL
 * Analytics API and **replaces** the matching `provider_usage_meter_daily`
 * rows (`source = 'cloudflare_api'`). Replace, not add: the ledger increments
 * because it sees each call once; this source sees the whole day every time,
 * and yesterday is re-read because adaptive analytics finish settling after
 * midnight. A day with nothing on it is written as `0` — a measured zero the
 * Cost Center can show, not an absent row it must call UNKNOWN (epic §44.6,
 * §44.10).
 *
 * Meters written (registry ids under `cloudflare.r2` / `cloudflare.workers`):
 *
 * | meter              | quantity                                       | unit        |
 * | ------------------ | ---------------------------------------------- | ----------- |
 * | `class_a`          | Class A operations summed over the buckets     | operation   |
 * | `class_b`          | Class B operations summed over the buckets     | operation   |
 * | `storage_gb_month` | peak payload+metadata bytes, ceil to decimal GB | gb_month    |
 * | `requests`         | Workers requests summed over the scripts       | request     |
 *
 * `egress_gb` and `cpu_ms` stay declared and unwritten — the datasets carry
 * neither (see the registry comment). Actions the pricing page does not
 * classify are counted in `metadata.unclassified`, never into a class.
 *
 * Scope: `buckets` / `scripts` narrow the account-wide figures to this
 * environment's resources (Terraform names them `<prefix>-assets`,
 * `<prefix>-share-link`); absent, the rows carry the whole account and say
 * so in `metadata.scope`. The R2 free tier is per account either way, so the
 * estimator's allowance stays MEDIUM confidence (epic §10).
 *
 * FREE and non-essential: the Analytics API has no per-query charge, and
 * nothing downstream needs these rows to keep consumer traffic flowing.
 */
export const CLOUDFLARE_SOURCE = 'cloudflare_api';
export const CLOUDFLARE_R2_COLLECTOR_ID = 'cloudflare_r2';
export const CLOUDFLARE_WORKERS_COLLECTOR_ID = 'cloudflare_workers';

const R2 = 'cloudflare.r2';
const WORKERS = 'cloudflare.workers';
const PROVIDER = 'cloudflare';
const GB = 1_000_000_000;

export type CloudflareCollectorOptions = {
  /** Bucket names to attribute to this environment; empty = whole account. */
  buckets?: readonly string[];
  /** Worker script names to attribute to this environment; empty = whole account. */
  scripts?: readonly string[];
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
  maxCallsPerDay: 8,
};

/** `CLOUDFLARE_R2_BUCKETS=a,b` → `['a', 'b']`; unset or blank → `undefined`. */
export function listFromEnv(value: string | undefined): string[] | undefined {
  const items = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

export function cloudflareCollectorOptionsFromEnv(
  env: Record<string, string | undefined>,
): Pick<CloudflareCollectorOptions, 'buckets' | 'scripts'> {
  const buckets = listFromEnv(env.CLOUDFLARE_R2_BUCKETS);
  const scripts = listFromEnv(env.CLOUDFLARE_WORKER_SCRIPTS);
  return { ...(buckets ? { buckets } : {}), ...(scripts ? { scripts } : {}) };
}

type SampleContext = {
  day: string;
  environment: string;
  now: Date;
  scope: 'account' | 'filtered';
};

function sample(
  ctx: SampleContext,
  serviceId: string,
  metric: string,
  billingSkuId: string | null,
  unit: UsageSample['unit'],
  quantity: number,
  confidence: Confidence,
  metadata: Record<string, unknown>,
): UsageSample {
  return {
    day: ctx.day,
    environment: ctx.environment,
    providerId: PROVIDER,
    serviceId,
    operationId: null,
    usageMetricId: metric,
    billingSkuId,
    quantity,
    unit,
    source: CLOUDFLARE_SOURCE,
    confidence,
    sourceAsOf: ctx.now,
    metadata: { scope: ctx.scope, ...metadata },
  };
}

/** Pure: one day of R2 usage → the three meter rows. Always three, zeros included. */
export function r2Samples(
  ctx: SampleContext,
  usage: readonly CloudflareR2DayUsage[],
): UsageSample[] {
  const classA = usage.reduce((n, b) => n + b.classA, 0);
  const classB = usage.reduce((n, b) => n + b.classB, 0);
  const unclassified = usage.reduce((n, b) => n + b.unclassified, 0);
  const peakBytes = usage.reduce((n, b) => n + b.peakBytes, 0);
  const peakObjects = usage.reduce((n, b) => n + b.peakObjects, 0);
  const buckets = usage.map((b) => b.bucketName);
  const byAction: Record<string, number> = {};
  for (const b of usage) {
    for (const [action, n] of Object.entries(b.byAction)) {
      byAction[action] = (byAction[action] ?? 0) + n;
    }
  }
  // An unclassified action is a pricing-page drift, not a rounding error:
  // the class counts are exact for what they cover, but the day's total is
  // not fully priced, and the row says so.
  const opsConfidence: Confidence = unclassified > 0 ? 'MEDIUM' : 'HIGH';
  const ops = { buckets, byAction, unclassified };
  return [
    sample(ctx, R2, 'class_a', 'r2.class_a', 'operation', classA, opsConfidence, ops),
    sample(ctx, R2, 'class_b', 'r2.class_b', 'operation', classB, opsConfidence, ops),
    sample(
      ctx,
      R2,
      'storage_gb_month',
      'r2.storage',
      'gb_month',
      Math.ceil(peakBytes / GB),
      'HIGH',
      { buckets, peakBytes, peakObjects, gbDefinition: 'decimal (1e9 bytes), ceil' },
    ),
  ];
}

/** Pure: one day of Workers usage → the requests row. */
export function workersSamples(
  ctx: SampleContext,
  usage: readonly CloudflareWorkersDayUsage[],
): UsageSample[] {
  const requests = usage.reduce((n, s) => n + s.requests, 0);
  const errors = usage.reduce((n, s) => n + s.errors, 0);
  const subrequests = usage.reduce((n, s) => n + s.subrequests, 0);
  return [
    sample(ctx, WORKERS, 'requests', 'workers.requests', 'request', requests, 'HIGH', {
      scripts: usage.map((s) => s.scriptName),
      errors,
      subrequests,
    }),
  ];
}

function definition(
  id: string,
  serviceId: string,
  options: CloudflareCollectorOptions,
  run: (ctx: CollectorRunContext) => Promise<CollectorRunResult>,
): CollectorDefinition {
  return {
    id,
    providerId: PROVIDER,
    serviceId,
    capability: 'USAGE_COLLECTOR',
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
      expectedRequestsPerMonth: 4 * 2 * 30,
      pricingSource:
        'Cloudflare GraphQL Analytics API is included in every plan with no per-query charge (developers.cloudflare.com/analytics/graphql-api, checked 2026-09-03). Two POSTs per run, four runs a day.',
      lastPricingReview: '2026-09-03',
    },
    run,
  };
}

/**
 * The two definitions, ready for `CollectorSchedulerService.register`. Build
 * only when credentials exist (`cloudflareAnalyticsFromEnv` returned a
 * client); with none, register nothing and the provider reads UNKNOWN.
 */
export function cloudflareCollectors(
  db: Db,
  client: CloudflareAnalyticsPort,
  options: CloudflareCollectorOptions = {},
): CollectorDefinition[] {
  const days = (ctx: CollectorRunContext) => [previousDay(ctx.day), ctx.day];
  const now = options.now ?? (() => new Date());

  const r2 = definition(CLOUDFLARE_R2_COLLECTOR_ID, R2, options, async (ctx) => {
    const at = now();
    let samples = 0;
    for (const day of days(ctx)) {
      const usage = await client.r2Usage({
        day,
        ...(options.buckets ? { buckets: options.buckets } : {}),
        signal: ctx.signal,
      });
      samples += await upsertUsageSamples(
        db,
        r2Samples(
          {
            day,
            environment: ctx.environment,
            now: at,
            scope: options.buckets ? 'filtered' : 'account',
          },
          usage,
        ),
      );
    }
    return { sourceAsOf: at, samples };
  });

  const workers = definition(CLOUDFLARE_WORKERS_COLLECTOR_ID, WORKERS, options, async (ctx) => {
    const at = now();
    let samples = 0;
    for (const day of days(ctx)) {
      const usage = await client.workersUsage({
        day,
        ...(options.scripts ? { scripts: options.scripts } : {}),
        signal: ctx.signal,
      });
      samples += await upsertUsageSamples(
        db,
        workersSamples(
          {
            day,
            environment: ctx.environment,
            now: at,
            scope: options.scripts ? 'filtered' : 'account',
          },
          usage,
        ),
      );
    }
    return { sourceAsOf: at, samples };
  });

  return [r2, workers];
}
