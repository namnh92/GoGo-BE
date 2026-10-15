import type { Db } from '@gogo/database';
import type { SentryDayStats, SentryProject, SentryStatsPort } from '@gogo/providers';
import { SENTRY_OUTCOMES } from '@gogo/providers';
import type { CollectorDefinition, CollectorRunContext } from '../../domain/collector';
import type { Confidence, UsageSample } from '../../ports/collectors.port';
import { previousDay, upsertUsageSamples } from '../../application/sample-writer';

/**
 * BE#696 (ADR-0011 D-14, shape `sa-shape-sentry-cost-center.fable.md` D-4) —
 * the Sentry error-events collector on the generic scheduler:
 * `sentry_events` for `sentry.errors`.
 *
 * Source: the org's `stats_v2`, category `error` (see
 * `sentry-stats.adapter.ts`). Grouping by project returns one total per
 * query, so each run asks once per day (yesterday, today) plus once for the
 * project list — three GETs, all free.
 *
 * Rows written per run, for yesterday and today (`replace`, not add — the
 * figure is the day's total):
 *
 * | table                        | row                                                          |
 * | ---------------------------- | ------------------------------------------------------------ |
 * | `provider_usage_meter_daily` | `events` (billed `errors.events`), Σ accepted, `sentry_api`   |
 *
 * `metadata.byProject` gives every known project's accepted count (0 when
 * Sentry returned no group for it — stats_v2 omits empty groups), and
 * `metadata.dropped` what Sentry refused per outcome: that is where spike
 * protection and rate limits show up on the CMS. A project id missing from
 * the list is kept as `project:<id>` rather than folded away.
 *
 * A day whose query fails gets **no row** (epic §44.6); a 200 with no groups
 * is a measured zero. Today's row is MEDIUM (the day is still open),
 * yesterday's HIGH. No cost row: the money is estimated from the PAYG rule
 * (`errors.events`, #695) and the plan itself is a manual item.
 */
export const SENTRY_SOURCE = 'sentry_api';
export const SENTRY_EVENTS_COLLECTOR_ID = 'sentry_events';

const PROVIDER = 'sentry';
const ERRORS = 'sentry.errors';
const EVENTS_SKU = 'errors.events';
const ACCEPTED = 'accepted';

export type SentryCollectorOptions = {
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

export type SentrySampleContext = {
  /** The run's UTC day. */
  today: string;
  environment: string;
  now: Date;
};

/** Pure: one day's stats + the project list → that day's meter row. */
export function eventsSamples(
  ctx: SentrySampleContext,
  stats: SentryDayStats,
  projects: readonly SentryProject[],
): UsageSample[] {
  const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
  const byProject: Record<string, number> = {};
  for (const p of projects) byProject[p.slug] = 0;
  const dropped: Record<string, number> = {};
  for (const o of SENTRY_OUTCOMES) if (o !== ACCEPTED) dropped[o] = 0;

  let accepted = 0;
  for (const t of stats.totals) {
    if (t.outcome === ACCEPTED) {
      const slug = slugOf.get(t.projectId) ?? `project:${t.projectId}`;
      byProject[slug] = (byProject[slug] ?? 0) + t.quantity;
      accepted += t.quantity;
    } else {
      dropped[t.outcome] = (dropped[t.outcome] ?? 0) + t.quantity;
    }
  }

  const confidence: Confidence = stats.day === ctx.today ? 'MEDIUM' : 'HIGH';
  return [
    {
      day: stats.day,
      environment: ctx.environment,
      providerId: PROVIDER,
      serviceId: ERRORS,
      operationId: null,
      usageMetricId: 'events',
      billingSkuId: EVENTS_SKU,
      quantity: Math.max(0, Math.round(accepted)),
      unit: 'event',
      source: SENTRY_SOURCE,
      confidence,
      sourceAsOf: ctx.now,
      metadata: {
        from: 'stats_v2',
        definition: 'sum of accepted error events across the org’s projects',
        byProject,
        dropped,
      },
    },
  ];
}

/**
 * The definition, ready for `CollectorSchedulerService.register`. Build only
 * when `sentryStatsFromEnv` returned a client; with none, register nothing
 * and the provider reads UNKNOWN.
 */
export function sentryEventsCollector(
  db: Db,
  client: SentryStatsPort,
  options: SentryCollectorOptions = {},
): CollectorDefinition {
  const now = options.now ?? (() => new Date());
  return {
    id: SENTRY_EVENTS_COLLECTOR_ID,
    providerId: PROVIDER,
    serviceId: ERRORS,
    capability: 'USAGE_COLLECTOR',
    frequencyMs: options.frequencyMs ?? DEFAULTS.frequencyMs,
    staleAfterMs: options.staleAfterMs ?? DEFAULTS.staleAfterMs,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retry: { maxAttemptsPerTick: 1 },
    maxCallsPerDay: options.maxCallsPerDay ?? DEFAULTS.maxCallsPerDay,
    // Sentry is one org for every environment; the token is written only
    // where it should be counted (Infra: dev), which is the real gate.
    enabledEnvironments: 'all',
    essential: false,
    monitoringCost: {
      model: 'FREE',
      estimatedMonthlyMicros: 0,
      currency: 'USD',
      expectedRequestsPerMonth: 3 * 4 * 30,
      pricingSource:
        'Sentry’s org stats_v2 and projects endpoints have no per-request charge. Three GETs per run (one stats_v2 per day — grouping by project returns one total per query — plus the project list).',
      lastPricingReview: '2026-10-15',
    },
    run: async (ctx: CollectorRunContext) => {
      const at = now();
      const projects = await client.projects(ctx.signal);
      let written = 0;
      // Each day is its own query; one failing throws and fails the run, so
      // freshness shows it — the other day's row is not written alone.
      const days = [previousDay(ctx.day), ctx.day];
      const stats: SentryDayStats[] = [];
      for (const day of days) stats.push(await client.errorsForDay({ day, signal: ctx.signal }));
      for (const s of stats) {
        written += await upsertUsageSamples(
          db,
          eventsSamples({ today: ctx.day, environment: ctx.environment, now: at }, s, projects),
        );
      }
      return { sourceAsOf: at, samples: written };
    },
  };
}
