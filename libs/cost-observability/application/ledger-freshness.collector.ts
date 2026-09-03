import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type {
  CollectorDefinition,
  CollectorRunContext,
  CollectorRunResult,
} from '../domain/collector';

/**
 * COST-BE-017 (#369) — the first registered collector: the in-process usage
 * ledger, as a *source* with freshness.
 *
 * The ledger does not need collecting — it writes itself from the metrics
 * port (#335). What it lacks is a freshness row: without one, a ledger that
 * stopped flushing (worker down, `COST_LEDGER_ENABLED=false`, a database the
 * flush cannot reach) is indistinguishable from a quiet day, and the Cost
 * Center would print last week's total as if it were today's. Each successful
 * run here means "the worker is alive and the ledger tables are reachable";
 * `sourceAsOf` is the newest ledger write for the environment, which is what
 * the ops screen shows as "cập nhật lần cuối".
 *
 * FREE and essential: it costs one indexed query and it is the collector that
 * keeps running when the monitoring budget pauses the paid ones.
 */
export function ledgerFreshnessCollector(
  db: Db,
  options?: { frequencyMs?: number; staleAfterMs?: number },
): CollectorDefinition {
  return {
    id: 'ledger',
    providerId: 'google',
    serviceId: null,
    capability: 'USAGE_COLLECTOR',
    frequencyMs: options?.frequencyMs ?? 5 * 60 * 1000,
    // A day: the ledger is written whenever there is traffic and the freshness
    // run itself succeeds every tick, so anything older means the worker has
    // not ticked in 24h — which is the fact worth surfacing.
    staleAfterMs: options?.staleAfterMs ?? 24 * 60 * 60 * 1000,
    timeoutMs: 10_000,
    retry: { maxAttemptsPerTick: 1 },
    maxCallsPerDay: null,
    enabledEnvironments: 'all',
    essential: true,
    monitoringCost: {
      model: 'FREE',
      estimatedMonthlyMicros: 0,
      currency: 'USD',
      expectedRequestsPerMonth: null,
      pricingSource: 'One indexed SELECT on provider_usage_daily per run; no provider call.',
      lastPricingReview: '2026-09-02',
    },
    async run(ctx: CollectorRunContext): Promise<CollectorRunResult> {
      const { rows } = await db.execute(sql`
        select max(updated_at) as as_of, count(*)::int as n
        from provider_usage_daily
        where environment = ${ctx.environment}
      `);
      const row = rows[0] as { as_of: Date | string | null; n: number } | undefined;
      return {
        sourceAsOf: row?.as_of ? new Date(row.as_of) : null,
        samples: Number(row?.n ?? 0),
      };
    },
  };
}
