import type { MeterUnit } from '../domain/registry';
import type { PricingRule } from '../pricing/pricing-rules';

/**
 * COST-BE-015 (#367) — epic §7, the small ports.
 *
 * Five narrow interfaces instead of one `ProviderCostAdapter`: a provider
 * implements only the ones it can honour (epic §6), and generic code asks the
 * adapter registry for "every usage collector" rather than switching on a
 * provider name. Nothing here performs I/O; these are the shapes a collector
 * returns and the context it is given.
 *
 * The sample types mirror the canonical tables the epic names (§9 usage, §11
 * cost) so that a collector's output is persistable without translation. The
 * tables themselves land in COST-BE-016 (#368); until then the ledger is the
 * only usage source and it does not go through these ports.
 */

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Epic §11 basis. `ESTIMATED` is produced by the estimator, never collected. */
export type CostBasis = 'ACTUAL' | 'ESTIMATED' | 'FIXED' | 'MANUAL';

export type CollectContext = {
  /** `dev` | `staging` | `prod`. */
  environment: string;
  /** UTC day the collection is for. */
  day: string;
  now: Date;
};

/** One row of epic §9 `provider_usage_daily`, before persistence. */
export type UsageSample = {
  day: string;
  environment: string;
  providerId: string;
  serviceId: string;
  operationId: string | null;
  /** The meter's short `metric` — `calls`, `billable_elements`, `commands`. */
  usageMetricId: string;
  billingSkuId: string | null;
  /** Integer. Extrapolated values are not accounting (epic §10). */
  quantity: number;
  unit: MeterUnit;
  /** Which collector produced it — `ledger`, `cloudflare_api`, `prometheus`… */
  source: string;
  confidence: Confidence;
  /** The provider's own "as of" for the figure, when it has one. */
  sourceAsOf: Date | null;
  metadata?: Record<string, unknown>;
};

/** One row of epic §11 `provider_cost_daily` from a collector (ACTUAL/FIXED/MANUAL). */
export type CostSample = {
  day: string;
  environment: string;
  providerId: string;
  serviceId: string;
  operationId: string | null;
  usageMetricId: string | null;
  billingSkuId: string | null;
  billableQuantity: number | null;
  billableUnit: MeterUnit | null;
  /** Original billing currency, never converted (epic §17). */
  amountMicros: number;
  currency: string;
  basis: Exclude<CostBasis, 'ESTIMATED'>;
  confidence: Confidence;
  source: string;
  sourceAsOf: Date | null;
  metadata?: Record<string, unknown>;
};

/** What the estimator returns for one usage sample under one rule. */
export type CostEstimate = {
  usage: UsageSample;
  rule: PricingRule;
  basis: 'ESTIMATED';
  confidence: Confidence;
  listMicros: number;
  freeAdjustedMicros: number;
  currency: string;
  pricingVersion: string;
};

export type QuotaSnapshot = {
  providerId: string;
  serviceId: string;
  usageMetricId: string | null;
  limit: number | null;
  used: number | null;
  unit: MeterUnit;
  period: 'DAY' | 'MONTH' | 'ACCOUNT';
  asOf: Date;
  source: string;
};

export type FixedCostItem = {
  providerId: string;
  serviceId: string;
  name: string;
  amountMicros: number;
  currency: string;
  period: 'ONE_TIME' | 'MONTHLY' | 'YEARLY';
  effectiveFrom: string;
  effectiveTo: string | null;
};

export interface UsageCollector {
  readonly providerId: string;
  readonly serviceId: string;
  collectUsage(ctx: CollectContext): Promise<UsageSample[]>;
}

export interface ActualCostCollector {
  readonly providerId: string;
  collectActualCost(ctx: CollectContext): Promise<CostSample[]>;
}

export interface CostEstimator {
  estimate(usage: readonly UsageSample[], rules: readonly PricingRule[]): Promise<CostEstimate[]>;
}

export interface QuotaCollector {
  readonly providerId: string;
  collectQuota(ctx: CollectContext): Promise<QuotaSnapshot[]>;
}

export interface FixedCostProvider {
  readonly providerId: string;
  getFixedCosts(ctx: CollectContext): Promise<FixedCostItem[]>;
}
