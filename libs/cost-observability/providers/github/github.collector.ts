import type { Db } from '@gogo/database';
import type { GitHubBillingPort, GitHubUsageItem } from '@gogo/providers';
import type { CollectorDefinition, CollectorRunContext } from '../../domain/collector';
import type { Confidence, CostSample, UsageSample } from '../../ports/collectors.port';
import { previousDay, upsertUsageSamples } from '../../application/sample-writer';
import { upsertCostSamples } from '../../application/sample-writer';

/**
 * COST-BE-027 (#386) — the GitHub Actions collector on the generic scheduler
 * (epic §19, §41-P2): `github_actions` for `github.actions`.
 *
 * The source is the enhanced billing platform's usage report, because the
 * endpoint the issue names (`/settings/billing/actions`) was shut down on
 * 2025-09-26 — see `github-billing.adapter.ts`. The replacement is better for
 * this purpose in two ways, and the collector takes both:
 *
 * 1. **`minutes` is a measured daily figure.** Every line item carries its
 *    own `date`, so the day's minutes are read, not derived by differencing a
 *    month-to-date counter across runs. The issue's "quy về delta ngày" is
 *    not needed and would be less accurate.
 * 2. **`netAmount` is GitHub's own money**, so the same call yields an
 *    `ACTUAL` cost row alongside the usage meter. The estimator still prices
 *    `minutes` from the pricing rule; epic §12 keeps ACTUAL ahead of
 *    ESTIMATED for the same spend and never adds the two.
 *
 * Rows written per run, for yesterday and today (`replace`, not add — the
 * report gives the day's total):
 *
 * | table                        | row                                                        |
 * | ---------------------------- | ---------------------------------------------------------- |
 * | `provider_usage_meter_daily` | `minutes` (billed `actions.minutes`), source `github_api`   |
 * | `provider_cost_daily`        | `basis = ACTUAL`, `netAmount` in micros, source `github_api` |
 *
 * Only items whose `product` is `actions` are considered; other products
 * (Packages, Copilot) are counted in `metadata.otherProducts` and left to
 * their own collectors rather than silently folded into Actions. Minutes are
 * summed across SKUs (Linux, Windows, macOS) because the meter is minutes;
 * the per-SKU split rides in `metadata.skus`, since the OS decides the price
 * and a single blended figure would hide that.
 *
 * A day the report does not mention gets **no row** — absent is not zero
 * (epic §44.6, §44.10). The report is authoritative for a day only once that
 * day is over, so today's row is MEDIUM and yesterday's HIGH.
 *
 * FREE and non-essential: the billing endpoint has no per-request charge, and
 * nothing downstream needs these rows to keep consumer traffic flowing.
 */
export const GITHUB_SOURCE = 'github_api';
export const GITHUB_ACTIONS_COLLECTOR_ID = 'github_actions';

const PROVIDER = 'github';
const ACTIONS = 'github.actions';
const ACTIONS_PRODUCT = 'actions';
const MINUTES_SKU = 'actions.minutes';

export type GitHubCollectorOptions = {
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

export type GitHubSampleContext = {
  /** The day the rows are for. */
  day: string;
  /** The run's UTC day. */
  today: string;
  environment: string;
  now: Date;
};

/** Money as GitHub reports it (a JSON number of dollars) → integer micros. */
const toMicros = (amount: number) => Math.round(amount * 1_000_000);

/**
 * Pure: the report's items → one day's usage and cost rows. Returns both
 * lists so the caller writes each to its own table in one pass.
 */
export function actionsSamples(
  ctx: GitHubSampleContext,
  items: readonly GitHubUsageItem[],
): { usage: UsageSample[]; costs: CostSample[] } {
  const onDay = items.filter((i) => i.day === ctx.day);
  if (onDay.length === 0) return { usage: [], costs: [] };
  const actions = onDay.filter((i) => i.product === ACTIONS_PRODUCT);
  const otherProducts = [
    ...new Set(onDay.filter((i) => i.product !== ACTIONS_PRODUCT).map((i) => i.product)),
  ].sort();
  if (actions.length === 0) return { usage: [], costs: [] };

  const confidence: Confidence = ctx.day === ctx.today ? 'MEDIUM' : 'HIGH';
  // Minutes are the minute-typed lines; a line reported in another unit is
  // not silently converted, only recorded.
  const minuteItems = actions.filter((i) => i.unitType === null || i.unitType.startsWith('minute'));
  const otherUnits = [
    ...new Set(actions.filter((i) => !minuteItems.includes(i)).map((i) => i.unitType ?? 'unknown')),
  ].sort();
  const minutes = minuteItems.reduce((sum, i) => sum + i.quantity, 0);

  const skus = actions
    .map((i) => ({
      sku: i.sku,
      quantity: i.quantity,
      unitType: i.unitType,
      pricePerUnit: i.pricePerUnit,
      netAmount: i.netAmount,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  const repositories = [
    ...new Set(actions.map((i) => i.repositoryName).filter((r): r is string => r !== null)),
  ].sort();
  const common = {
    from: 'billing_usage_report',
    skus,
    ...(repositories.length > 0 ? { repositories } : {}),
    ...(otherProducts.length > 0 ? { otherProducts } : {}),
    ...(otherUnits.length > 0 ? { otherUnits } : {}),
  };

  const usage: UsageSample[] = [
    {
      day: ctx.day,
      environment: ctx.environment,
      providerId: PROVIDER,
      serviceId: ACTIONS,
      operationId: null,
      usageMetricId: 'minutes',
      billingSkuId: MINUTES_SKU,
      quantity: Math.max(0, Math.round(minutes)),
      unit: 'minute',
      source: GITHUB_SOURCE,
      confidence,
      sourceAsOf: ctx.now,
      metadata: { ...common, definition: 'sum of minute-typed Actions line items' },
    },
  ];

  // `netAmount` is what GitHub charges after the included allowance; a report
  // where no line carries one gives no cost row rather than a zero.
  const priced = actions.filter((i) => i.netAmount !== null);
  const costs: CostSample[] =
    priced.length === 0
      ? []
      : [
          {
            day: ctx.day,
            environment: ctx.environment,
            providerId: PROVIDER,
            serviceId: ACTIONS,
            operationId: null,
            // The same meter key the estimator writes. Epic §12's precedence
            // groups on (day, provider, service, operation, meter, sku), so an
            // ACTUAL row that left this null would not shadow its own
            // estimate — the Cost Center would add the two and double the
            // spend instead of preferring the bill.
            usageMetricId: 'minutes',
            billingSkuId: MINUTES_SKU,
            billableQuantity: Math.max(0, Math.round(minutes)),
            billableUnit: 'minute',
            amountMicros: toMicros(priced.reduce((sum, i) => sum + (i.netAmount ?? 0), 0)),
            currency: 'USD',
            basis: 'ACTUAL',
            confidence,
            source: GITHUB_SOURCE,
            // Minutes × price: metered, so USAGE (ADR-0015).
            costKind: 'USAGE',
            sourceAsOf: ctx.now,
            metadata: {
              ...common,
              definition: 'sum of netAmount over the day’s Actions line items',
              grossMicros: toMicros(actions.reduce((sum, i) => sum + (i.grossAmount ?? 0), 0)),
              discountMicros: toMicros(
                actions.reduce((sum, i) => sum + (i.discountAmount ?? 0), 0),
              ),
            },
          },
        ];
  return { usage, costs };
}

/** The `{ year, month }` pairs covering two adjacent days. */
export function monthsFor(days: readonly string[]): { year: number; month: number }[] {
  const seen = new Set<string>();
  const out: { year: number; month: number }[] = [];
  for (const d of days) {
    const key = d.slice(0, 7);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) });
  }
  return out.sort((a, b) => a.year - b.year || a.month - b.month);
}

/**
 * The definition, ready for `CollectorSchedulerService.register`. Build only
 * when credentials exist (`githubBillingFromEnv` returned a client); with
 * none, register nothing and the provider reads UNKNOWN.
 */
export function githubActionsCollector(
  db: Db,
  client: GitHubBillingPort,
  options: GitHubCollectorOptions = {},
): CollectorDefinition {
  const now = options.now ?? (() => new Date());
  return {
    id: GITHUB_ACTIONS_COLLECTOR_ID,
    providerId: PROVIDER,
    serviceId: ACTIONS,
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
        'The GitHub billing usage endpoint has no per-request charge (docs.github.com/en/rest/billing/usage, checked 2026-09-03). One GET per run, two on the days either side of a month boundary.',
      lastPricingReview: '2026-09-03',
    },
    run: async (ctx: CollectorRunContext) => {
      const at = now();
      const yesterday = previousDay(ctx.day);
      // One report per month covers both days, except across a boundary.
      const items: GitHubUsageItem[] = [];
      for (const { year, month } of monthsFor([yesterday, ctx.day])) {
        items.push(...(await client.usage({ year, month, signal: ctx.signal })));
      }
      let written = 0;
      for (const day of [yesterday, ctx.day]) {
        const { usage, costs } = actionsSamples(
          { day, today: ctx.day, environment: ctx.environment, now: at },
          items,
        );
        written += await upsertUsageSamples(db, usage);
        written += await upsertCostSamples(db, costs);
      }
      return { sourceAsOf: at, samples: written };
    },
  };
}
