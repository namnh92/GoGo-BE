import type { Db } from '@gogo/database';
import type { UpstashPoint, UpstashRedisStats, UpstashRedisStatsPort } from '@gogo/providers';
import type { CollectorDefinition, CollectorRunContext } from '../../domain/collector';
import type { Confidence, UsageSample } from '../../ports/collectors.port';
import { previousDay, upsertUsageSamples } from '../../application/sample-writer';

/**
 * COST-BE-025 (#384) — the Upstash Redis usage collector on the generic
 * scheduler (epic §19, §41-P2, §42.7): `upstash_redis` for `upstash.redis`.
 *
 * Each run makes **one** call to the Developer API stats endpoint and
 * **replaces** the matching `provider_usage_meter_daily` rows
 * (`source = 'upstash_api'`) for today and yesterday. Replace, not add: the
 * ledger increments because it sees each call once; this source sees the
 * whole day every time, and yesterday is re-read because the last run of a
 * day happens before midnight. A day inside the charts' window with no point
 * on it is written as `0` — a measured zero the Cost Center can show — while
 * a day outside the window gets no row at all: absent is not zero
 * (epic §44.6, §44.10).
 *
 * Meters written (registry ids under `upstash.redis`):
 *
 * | meter             | quantity                                                 | unit    | confidence |
 * | ----------------- | -------------------------------------------------------- | ------- | ---------- |
 * | `commands`        | the day's `dailyrequests` point (today: `daily_net_commands` as fallback) | command | HIGH; MEDIUM when today's two figures disagree |
 * | `bandwidth_bytes` | today: `dailybandwidth`; other days: the `bandwidths` point | byte    | HIGH today; MEDIUM from the series |
 * | `storage_bytes`   | peak of the day's `diskusage` samples (+ `current_storage` today) | byte    | MEDIUM — point-in-time samples, not a metered figure |
 *
 * Only `commands` is billed (`redis.commands`, $0.2 per 100K, 500K/month
 * free). Storage and bandwidth are collected in bytes and stay non-billable:
 * Upstash prices them per GB beyond a free tier, and a byte meter is not a
 * GB rule — pricing them is a later rule, not a silent conversion.
 *
 * What is not known is said: the `bandwidths` series is documented as bytes
 * but the docs' example disagrees with the `dailybandwidth` scalar, so a
 * series-derived bandwidth row is MEDIUM and names its field in
 * `metadata.from`; the first live run should compare today's two figures.
 *
 * FREE and non-essential: the Developer API has no per-request charge, and
 * nothing downstream needs these rows to keep consumer traffic flowing.
 */
export const UPSTASH_SOURCE = 'upstash_api';
export const UPSTASH_REDIS_COLLECTOR_ID = 'upstash_redis';

const REDIS = 'upstash.redis';
const PROVIDER = 'upstash';

export type UpstashCollectorOptions = {
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

export type RedisSampleContext = {
  /** The day the rows are for. */
  day: string;
  /** The run's UTC day — the day the endpoint's scalars describe. */
  today: string;
  environment: string;
  now: Date;
};

/**
 * Is `day` inside the window the daily charts cover? The window ends today
 * and spans `windowDays` (the length of the endpoint's `days` labels); today
 * is always covered because the scalars describe it.
 */
export function coveredByWindow(day: string, today: string, windowDays: number | null): boolean {
  if (day === today) return true;
  if (windowDays === null || windowDays < 1 || day > today) return false;
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  return day >= start.toISOString().slice(0, 10);
}

/** The last point on `day`, or `null`. */
function pointOn(points: readonly UpstashPoint[], day: string): number | null {
  let value: number | null = null;
  for (const p of points) if (p.day === day) value = p.value;
  return value;
}

const whole = (v: number) => Math.max(0, Math.round(v));

function sample(
  ctx: RedisSampleContext,
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
    serviceId: REDIS,
    operationId: null,
    usageMetricId: metric,
    billingSkuId,
    quantity: whole(quantity),
    unit,
    source: UPSTASH_SOURCE,
    confidence,
    sourceAsOf: ctx.now,
    metadata,
  };
}

/**
 * Pure: one stats answer → the meter rows for `ctx.day`. Up to three rows;
 * a meter the answer says nothing about for that day is omitted, never zeroed.
 */
export function redisSamples(ctx: RedisSampleContext, stats: UpstashRedisStats): UsageSample[] {
  const isToday = ctx.day === ctx.today;
  const covered = coveredByWindow(ctx.day, ctx.today, stats.windowDays);
  const out: UsageSample[] = [];

  // commands — the day's chart point; today falls back to the live counter.
  const seriesCommands = pointOn(stats.dailyRequests, ctx.day);
  const liveCommands = isToday ? stats.dailyNetCommands : null;
  const commands = seriesCommands ?? liveCommands ?? (covered ? 0 : null);
  if (commands !== null) {
    const disagree =
      seriesCommands !== null && liveCommands !== null && seriesCommands !== liveCommands;
    out.push(
      sample(ctx, 'commands', 'redis.commands', 'command', commands, disagree ? 'MEDIUM' : 'HIGH', {
        from:
          seriesCommands !== null
            ? 'dailyrequests'
            : liveCommands !== null
              ? 'daily_net_commands'
              : 'window_zero',
        windowDays: stats.windowDays,
        ...(isToday
          ? {
              dailyNetCommands: stats.dailyNetCommands,
              totalMonthlyRequests: stats.totalMonthlyRequests,
            }
          : {}),
      }),
    );
  }

  // bandwidth — today's scalar is the documented daily total; other days come
  // from the series, whose unit the docs' example leaves in doubt.
  const seriesBandwidth = pointOn(stats.dailyBandwidth, ctx.day);
  const scalarBandwidth = isToday ? stats.dailyBandwidthBytes : null;
  const bandwidth = scalarBandwidth ?? seriesBandwidth ?? (covered ? 0 : null);
  if (bandwidth !== null) {
    const from =
      scalarBandwidth !== null
        ? 'dailybandwidth'
        : seriesBandwidth !== null
          ? 'bandwidths'
          : 'window_zero';
    out.push(
      sample(
        ctx,
        'bandwidth_bytes',
        null,
        'byte',
        bandwidth,
        from === 'bandwidths' ? 'MEDIUM' : 'HIGH',
        {
          from,
          windowDays: stats.windowDays,
          ...(isToday
            ? {
                seriesBandwidthBytes: seriesBandwidth,
                totalMonthlyBandwidthBytes: stats.totalMonthlyBandwidthBytes,
              }
            : {}),
        },
      ),
    );
  }

  // storage — the peak of what was sampled on the day. No sample, no row.
  const samples = stats.diskUsage.filter((p) => p.day === ctx.day).map((p) => p.value);
  if (isToday && stats.currentStorageBytes !== null) samples.push(stats.currentStorageBytes);
  if (samples.length > 0) {
    out.push(
      sample(ctx, 'storage_bytes', null, 'byte', Math.max(...samples), 'MEDIUM', {
        definition: 'peak of point-in-time samples',
        samples: samples.length,
        ...(isToday
          ? {
              currentStorageBytes: stats.currentStorageBytes,
              totalMonthlyStorageBytes: stats.totalMonthlyStorageBytes,
            }
          : {}),
      }),
    );
  }
  return out;
}

/**
 * The definition, ready for `CollectorSchedulerService.register`. Build only
 * when credentials exist (`upstashDeveloperApiFromEnv` returned a client);
 * with none, register nothing and the provider reads UNKNOWN.
 */
export function upstashRedisCollector(
  db: Db,
  client: UpstashRedisStatsPort,
  options: UpstashCollectorOptions = {},
): CollectorDefinition {
  const now = options.now ?? (() => new Date());
  return {
    id: UPSTASH_REDIS_COLLECTOR_ID,
    providerId: PROVIDER,
    serviceId: REDIS,
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
      expectedRequestsPerMonth: 4 * 30,
      pricingSource:
        'Upstash Developer API has no per-request charge and no published rate limit (upstash.com/docs/devops/developer-api, checked 2026-09-03). One GET per run, four runs a day.',
      lastPricingReview: '2026-09-03',
    },
    run: async (ctx: CollectorRunContext) => {
      const at = now();
      const stats = await client.stats({ signal: ctx.signal });
      let samples = 0;
      for (const day of [previousDay(ctx.day), ctx.day]) {
        samples += await upsertUsageSamples(
          db,
          redisSamples({ day, today: ctx.day, environment: ctx.environment, now: at }, stats),
        );
      }
      return { sourceAsOf: at, samples };
    },
  };
}
