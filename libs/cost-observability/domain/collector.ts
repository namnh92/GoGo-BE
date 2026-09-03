import type { Capability } from './capabilities';

/**
 * COST-BE-017 (#369) — epic §19 (collector configuration), §20 (cost of cost
 * tracking), §22 (paid-collector guardrails).
 *
 * A collector is a scheduled read of one source for one provider. Its
 * definition is data the scheduler reads: how often, how long it may take,
 * how many times a day it may run, in which environments, and — the epic's
 * distinctive requirement — **what it costs to run**. A collector that cannot
 * say what it costs declares `UNKNOWN`, and unknown is never zero: the
 * cost-of-cost figure that includes it is reported as incomplete.
 */

export const MONITORING_COST_MODELS = [
  'FREE',
  'PER_REQUEST',
  'STORAGE_QUERY',
  'FIXED',
  'UNKNOWN',
] as const;
export type MonitoringCostModel = (typeof MONITORING_COST_MODELS)[number];

export type MonitoringCost = {
  model: MonitoringCostModel;
  /** Micros per month in `currency`; `null` = unknown. `FREE` ⇒ 0. */
  estimatedMonthlyMicros: number | null;
  currency: string;
  expectedRequestsPerMonth: number | null;
  pricingSource: string;
  /** UTC date the collector's own cost was last checked. */
  lastPricingReview: string;
};

export type RetryPolicy = {
  /** Attempts within one tick. 1 = no in-tick retry; backoff happens across ticks. */
  maxAttemptsPerTick: number;
};

export type CollectorRunContext = {
  environment: string;
  now: Date;
  /** UTC day of `now`. */
  day: string;
  signal: AbortSignal;
};

export type CollectorRunResult = {
  /** The provider's own "as of" for what was read, when it has one. */
  sourceAsOf: Date | null;
  /** How many samples/rows the run produced. Zero is a measured zero. */
  samples: number;
};

export type CollectorDefinition = {
  /** Literal id, bounded; also a metric label value. `ledger`, `cloudflare_r2_api`… */
  id: string;
  providerId: string;
  serviceId: string | null;
  capability: Extract<Capability, 'USAGE_COLLECTOR' | 'ACTUAL_COST_COLLECTOR' | 'QUOTA'>;
  frequencyMs: number;
  /** How old the last success may be before the source reads STALE. */
  staleAfterMs: number;
  timeoutMs: number;
  retry: RetryPolicy;
  /** `null` = unlimited (only sane for FREE collectors). */
  maxCallsPerDay: number | null;
  /** `'all'` or the environments it may run in. */
  enabledEnvironments: 'all' | readonly string[];
  /**
   * Essential collectors keep running when the monitoring budget is exceeded;
   * non-essential ones are paused and marked stale (epic §22). Only a FREE
   * collector should be essential.
   */
  essential: boolean;
  monitoringCost: MonitoringCost;
  run(ctx: CollectorRunContext): Promise<CollectorRunResult>;
};

export function isEnabledIn(
  def: Pick<CollectorDefinition, 'enabledEnvironments'>,
  environment: string,
): boolean {
  return def.enabledEnvironments === 'all' || def.enabledEnvironments.includes(environment);
}

export type MonitoringCostSummary = {
  /** Sum of the known monthly estimates, micros. A floor when `unknown` is non-empty. */
  knownMonthlyMicros: number;
  /** Collectors whose cost model is UNKNOWN or whose estimate is null. */
  unknown: string[];
  /** Collectors projected above the per-collector approval line (epic §20). */
  needsApproval: string[];
  currency: string;
};

/** Epic §20: any single collector projected above $1/month needs explicit approval. */
export const PER_COLLECTOR_APPROVAL_LINE_MICROS = 1_000_000;

export function monitoringCostSummary(
  collectors: readonly Pick<CollectorDefinition, 'id' | 'monitoringCost'>[],
): MonitoringCostSummary {
  let known = 0;
  const unknown: string[] = [];
  const needsApproval: string[] = [];
  for (const c of collectors) {
    const est = c.monitoringCost.model === 'FREE' ? 0 : c.monitoringCost.estimatedMonthlyMicros;
    if (c.monitoringCost.model === 'UNKNOWN' || est === null) {
      unknown.push(c.id);
      continue;
    }
    known += est;
    if (est > PER_COLLECTOR_APPROVAL_LINE_MICROS) needsApproval.push(c.id);
  }
  return { knownMonthlyMicros: known, unknown, needsApproval, currency: 'USD' };
}

/** Epic §20 environment budgets for the cost of cost tracking, micros/month. */
export function defaultMonitoringBudgetMicros(environment: string): number {
  return environment === 'prod' || environment === 'production' ? 5_000_000 : 1_000_000;
}
