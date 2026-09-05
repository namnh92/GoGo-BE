import { upsertCostSamples } from '../../application/sample-writer';
import type { Db } from '@gogo/database';
import type { AwsCostExplorerPort, AwsServiceCost } from '@gogo/providers';
import type { CollectorDefinition, CollectorRunContext } from '../../domain/collector';
import type { CostSample } from '../../ports/collectors.port';
import type { CostRegistry } from '../../domain/registry';
import { ReconciliationService } from '../../application/reconciliation.service';

/**
 * COST-BE-027 (#386) — the AWS Cost Explorer collector on the generic
 * scheduler (epic §19, §20–§22, §26, §41-P2): `aws_cost_explorer` for
 * `aws.aggregate_billing`.
 *
 * This is the first **ACTUAL_COST_COLLECTOR**: it does not measure usage and
 * multiply by a price, it reads what AWS says the bill is. Rows land in
 * `provider_cost_daily` with `basis = 'ACTUAL'` and `source =
 * 'aws_cost_explorer'`, and the estimator never touches them — epic §12 keeps
 * ACTUAL and ESTIMATED apart rather than adding them.
 *
 * **It is also the first collector that costs money: $0.01 per request**
 * (epic §20). Guardrails, all declared rather than assumed:
 *
 * - `maxCallsPerDay: 1`, enforced by the scheduler against `cost_source_freshness`,
 *   which is a table — so the cap survives a worker restart, which an
 *   in-process counter would not.
 * - `frequencyMs` 24h, `monitoringCost.model = 'PER_REQUEST'`,
 *   `estimatedMonthlyMicros` 300,000 (~$0.30/month at ~30 calls). That is
 *   under the epic's $1/collector approval line but still inside the DEV
 *   budget of $1/month, so it is declared and shows up in the internal
 *   provider's "cost of tracking" row.
 * - `essential: false`, so the budget guard can pause it — and the scheduler
 *   already refuses `essential` on anything that is not FREE.
 *
 * **One call covers several days.** `GetCostAndUsage` with `Granularity:
 * DAILY` returns one entry per day in the window, so a single daily request
 * re-reads the last `lookbackDays` days rather than only yesterday. That is
 * not belt-and-braces: Cost Explorer marks recent days `Estimated: true` and
 * restates them, so a day read once and never re-read would keep a figure AWS
 * has since corrected. Re-reading is free — the price is per request, not per
 * day — and the rows are replaced, not added.
 *
 * **Service mapping** is by the registry, not by a literal: the `SERVICE`
 * dimension value is matched against `awsServiceRoute`, which routes Systems
 * Manager to `aws.ssm` and everything else to `aws.aggregate_billing`
 * (epic §44.3 — no `if (provider === 'x')`). A service the registry does not
 * know cannot receive a row, so the fallback is the aggregate bucket and the
 * original AWS name is kept in `metadata.awsService`.
 *
 * After writing, the collector stamps `reconciled_at` on every ESTIMATED row
 * that now has an ACTUAL twin for the same day and meter key (COST-BE-021,
 * epic §26). It computes no variance here; it records that the estimate has
 * been checked against a bill.
 */
export const AWS_SOURCE = 'aws_cost_explorer';
export const AWS_COST_EXPLORER_COLLECTOR_ID = 'aws_cost_explorer';

const PROVIDER = 'aws';
const AGGREGATE = 'aws.aggregate_billing';
const SSM = 'aws.ssm';

/** $0.01 per `GetCostAndUsage` request, in micros. */
export const AWS_CE_REQUEST_MICROS = 10_000;

export type AwsCollectorOptions = {
  frequencyMs?: number;
  staleAfterMs?: number;
  timeoutMs?: number;
  maxCallsPerDay?: number;
  /** How many days back each run re-reads. Default 7. */
  lookbackDays?: number;
  now?: () => Date;
};

const DEFAULTS = {
  frequencyMs: 24 * 60 * 60 * 1000,
  staleAfterMs: 36 * 60 * 60 * 1000,
  timeoutMs: 30_000,
  maxCallsPerDay: 1,
  lookbackDays: 7,
};

/**
 * Which registry service a Cost Explorer `SERVICE` value belongs to. Kept as
 * a list of substrings because AWS renames display names ("AWS Systems
 * Manager", "Amazon Simple Systems Manager") without warning; an unmatched
 * name is aggregate billing, never a dropped row.
 */
const ROUTES: readonly { match: readonly string[]; serviceId: string }[] = [
  { match: ['systems manager', 'ssm'], serviceId: SSM },
];

export function awsServiceRoute(awsService: string, registry: CostRegistry): string {
  const name = awsService.toLowerCase();
  for (const route of ROUTES) {
    if (route.match.some((m) => name.includes(m)) && registry.service(route.serviceId) !== null) {
      return route.serviceId;
    }
  }
  return AGGREGATE;
}

/** `2026-09-03` − n days, UTC. */
export function daysBefore(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure: Cost Explorer entries → ACTUAL cost rows. Several AWS services can
 * map to one registry service, so entries are merged per (day, serviceId,
 * currency) and the AWS names they came from are listed in
 * `metadata.awsServices` — a row that hid which services it summed would be
 * unauditable.
 *
 * Confidence follows AWS's own `Estimated` flag: a day AWS may still restate
 * is MEDIUM, a settled day HIGH. The basis stays ACTUAL either way — it is
 * the provider's own figure, not ours.
 */
export function awsCostSamples(
  ctx: { environment: string; now: Date },
  costs: readonly AwsServiceCost[],
  registry: CostRegistry,
): CostSample[] {
  type Bucket = {
    day: string;
    serviceId: string;
    currency: string;
    unblendedMicros: number;
    amortizedMicros: number | null;
    estimated: boolean;
    awsServices: string[];
  };
  const buckets = new Map<string, Bucket>();
  for (const c of costs) {
    const serviceId = awsServiceRoute(c.service, registry);
    const key = `${c.day}|${serviceId}|${c.currency}`;
    const prev = buckets.get(key);
    if (prev === undefined) {
      buckets.set(key, {
        day: c.day,
        serviceId,
        currency: c.currency,
        unblendedMicros: c.unblendedMicros,
        amortizedMicros: c.amortizedMicros,
        estimated: c.estimated,
        awsServices: [c.service],
      });
      continue;
    }
    prev.unblendedMicros += c.unblendedMicros;
    prev.amortizedMicros =
      prev.amortizedMicros === null || c.amortizedMicros === null
        ? null
        : prev.amortizedMicros + c.amortizedMicros;
    prev.estimated = prev.estimated || c.estimated;
    if (!prev.awsServices.includes(c.service)) prev.awsServices.push(c.service);
  }
  return [...buckets.values()]
    .sort((a, b) => a.day.localeCompare(b.day) || a.serviceId.localeCompare(b.serviceId))
    .map((b) => ({
      day: b.day,
      environment: ctx.environment,
      providerId: PROVIDER,
      serviceId: b.serviceId,
      operationId: null,
      usageMetricId: null,
      billingSkuId: null,
      billableQuantity: null,
      billableUnit: null,
      amountMicros: b.unblendedMicros,
      currency: b.currency,
      basis: 'ACTUAL' as const,
      confidence: b.estimated ? ('MEDIUM' as const) : ('HIGH' as const),
      source: AWS_SOURCE,
      // Cost Explorer's UnblendedCost is metered spend per day (ADR-0015).
      costKind: 'USAGE' as const,
      sourceAsOf: ctx.now,
      metadata: {
        metric: 'UnblendedCost',
        amortizedMicros: b.amortizedMicros,
        awsEstimated: b.estimated,
        awsServices: b.awsServices.sort(),
      },
    }));
}

/** The `YYYY-MM` months a set of days falls in, ascending. */
export function monthsOf(days: readonly string[]): string[] {
  return [...new Set(days.map((d) => d.slice(0, 7)))].sort();
}

/**
 * The definition, ready for `CollectorSchedulerService.register`. Build only
 * when credentials exist (`awsCostExplorerFromEnv` returned a client); with
 * none, register nothing and the provider reads UNKNOWN — and, importantly
 * for a paid collector, spends nothing.
 */
export function awsCostExplorerCollector(
  db: Db,
  client: AwsCostExplorerPort,
  registry: CostRegistry,
  options: AwsCollectorOptions = {},
): CollectorDefinition {
  const now = options.now ?? (() => new Date());
  const lookbackDays = Math.max(1, options.lookbackDays ?? DEFAULTS.lookbackDays);
  return {
    id: AWS_COST_EXPLORER_COLLECTOR_ID,
    providerId: PROVIDER,
    serviceId: AGGREGATE,
    capability: 'ACTUAL_COST_COLLECTOR',
    frequencyMs: options.frequencyMs ?? DEFAULTS.frequencyMs,
    staleAfterMs: options.staleAfterMs ?? DEFAULTS.staleAfterMs,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retry: { maxAttemptsPerTick: 1 },
    maxCallsPerDay: options.maxCallsPerDay ?? DEFAULTS.maxCallsPerDay,
    enabledEnvironments: 'all',
    essential: false,
    monitoringCost: {
      model: 'PER_REQUEST',
      estimatedMonthlyMicros: AWS_CE_REQUEST_MICROS * 30,
      currency: 'USD',
      expectedRequestsPerMonth: 30,
      pricingSource:
        'AWS Cost Explorer API is $0.01 per request (aws.amazon.com/aws-cost-management/pricing, checked 2026-09-03). One paginated GetCostAndUsage per day; the daily window covers several days in that one request.',
      lastPricingReview: '2026-09-03',
    },
    run: async (ctx: CollectorRunContext) => {
      const at = now();
      const from = daysBefore(ctx.day, lookbackDays - 1);
      const costs = await client.costsByService({ from, to: ctx.day, signal: ctx.signal });
      const samples = awsCostSamples({ environment: ctx.environment, now: at }, costs, registry);
      const written = await upsertCostSamples(db, samples);
      // Epic §26 — an estimate that now has a bill beside it is marked as
      // checked. Only the months the run actually wrote into are touched.
      const reconciliation = new ReconciliationService(db, { environment: ctx.environment });
      for (const month of monthsOf(samples.map((s) => s.day))) {
        await reconciliation.markReconciled(month, at);
      }
      return { sourceAsOf: at, samples: written };
    },
  };
}
