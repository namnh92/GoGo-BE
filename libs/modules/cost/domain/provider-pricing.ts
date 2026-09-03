import { COST_REGISTRY, type CostRegistry, type MeterUnit } from './registry';
import {
  PRICING_RULES,
  estimateMicros,
  newestEffectiveFrom,
  ruleInForce,
  type PricingRule,
} from './pricing-rules';

/**
 * PR2 / COST-BE-002 (#335), reshaped by COST-BE-015 (#367).
 *
 * This file used to *be* the registry: one Google-only list of rows with a
 * price per thousand. It is now a **compatibility view** over the two things
 * the epic separates — the definitions registry (`registry.ts`: what
 * providers, services, operations and meters exist) and the pricing rules
 * (`pricing-rules.ts`: what a meter costs, versioned). Every export below
 * keeps its signature so the ops API, the budget guard, the baseline runner
 * and the CMS ops taxonomy behave exactly as before; new code should read the
 * registry and the rules directly.
 *
 * Three rules that still hold, and are now enforced by the sources:
 *
 * 1. **An operation is the adapter's own `method` label.** The registry keys
 *    operations by it; `operationForSku` is the registry's SKU→operation fold.
 * 2. **An unknown price is `null`, never 0.** A rule with `unitPriceMicros:
 *    null` projects to `usdPer1000Micros: null`; a `FREE` rule projects to 0.
 * 3. **An uninstrumented operation is a measurement gap, never a zero.**
 *    `instrumented` is a property of the operation definition.
 */

export type PricingUnit = 'request' | 'element' | 'map_load';

export type PricingRow = {
  /** The adapter `method` label. One operation, one row per effective period. */
  operation: string;
  /** Google's billing SKU display name, or `null` where the call is not a billed SKU. */
  googleSku: string | null;
  unit: PricingUnit;
  /**
   * USD micros per 1,000 units, or `null` for UNKNOWN. `0` means *known free*
   * — a different fact from `null`, and the difference is load-bearing.
   */
  usdPer1000Micros: number | null;
  /** Free units per billing account per SKU per month. `null` = no free cap. */
  freePerMonth: number | null;
  /** UTC date, inclusive. */
  effectiveFrom: string;
  /** UTC date, exclusive. Absent = still in force. */
  effectiveTo?: string;
  /** False = this process emits no metric for it. Reported as a gap. */
  instrumented: boolean;
  source: string;
};

/**
 * Bumped whenever a rule changes. `pricingVersion` on the ops API is this
 * string; `provider-pricing.spec.ts` asserts it equals the newest
 * `effectiveFrom` in the rules, so a rule added without a bump fails CI.
 */
export const PRICING_VERSION = newestEffectiveFrom();

export const PRICING_CURRENCY = 'USD';

function compatUnit(unit: MeterUnit): PricingUnit {
  switch (unit) {
    case 'matrix_element':
      return 'element';
    case 'map_load':
      return 'map_load';
    default:
      return 'request';
  }
}

/** A rule's price expressed per 1,000 meter units, the shape the old rows used. */
function per1000Micros(rule: PricingRule): number | null {
  switch (rule.pricingModel) {
    case 'FREE':
      return 0;
    case 'PER_1K_REQUESTS':
      return rule.unitPriceMicros;
    case 'PER_REQUEST':
    case 'PER_OPERATION':
      return rule.unitPriceMicros === null ? null : rule.unitPriceMicros * 1_000;
    case 'PER_MILLION_REQUESTS':
      return rule.unitPriceMicros === null ? null : Math.ceil(rule.unitPriceMicros / 1_000);
    default:
      // Not expressible per thousand; the compat view has no such rows today.
      return null;
  }
}

function toRow(rule: PricingRule, registry: CostRegistry): PricingRow | null {
  if (rule.operationId === null) return null;
  const operation = registry.operation(rule.operationId);
  const meter = rule.usageMetricId === null ? null : registry.meter(rule.usageMetricId);
  if (operation === null || meter === null) return null;
  const sku = rule.billingSkuId === null ? null : registry.billingSku(rule.billingSkuId);
  return {
    operation: operation.id,
    googleSku: sku?.displayName ?? null,
    unit: compatUnit(meter.unit),
    usdPer1000Micros: per1000Micros(rule),
    freePerMonth: rule.freeAllowance?.period === 'MONTH' ? rule.freeAllowance.quantity : null,
    effectiveFrom: rule.effectiveFrom,
    ...(rule.effectiveTo === null ? {} : { effectiveTo: rule.effectiveTo }),
    instrumented: operation.instrumented,
    source: rule.sourceReference,
  };
}

/**
 * The registry, projected. Effective-dated: a historical day is priced with
 * the rule that was in force on that day, never with today's.
 */
export const PROVIDER_PRICING: readonly PricingRow[] = PRICING_RULES.map((rule) =>
  toRow(rule, COST_REGISTRY),
).filter((row): row is PricingRow => row !== null);

/**
 * The one place a billed SKU label folds onto the operation that spent it —
 * now the registry's fold (#332, epic §44.24).
 */
export function operationForSku(sku: string): string {
  return COST_REGISTRY.operationForBillingSku(sku);
}

/** UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** The rule in force for `operation` on `day`, projected; `null` if unregistered. */
export function pricingFor(operation: string, day: string): PricingRow | null {
  return (
    PROVIDER_PRICING.find(
      (row) =>
        row.operation === operation &&
        row.effectiveFrom <= day &&
        (row.effectiveTo === undefined || day < row.effectiveTo),
    ) ?? null
  );
}

function ruleFor(operation: string, day: string): PricingRule | null {
  return ruleInForce(PRICING_RULES, { operationId: operation }, day);
}

/**
 * List-price cost of `units`, in USD micros, or `null` when the price is
 * unknown. Rounded up — every consumer is a ceiling or a labelled estimate.
 */
export function listCostMicros(operation: string, day: string, units: number): number | null {
  const rule = ruleFor(operation, day);
  if (rule === null) return null;
  if (units <= 0) return 0;
  const estimate = estimateMicros(rule, units);
  return estimate.known ? estimate.listMicros : null;
}

/**
 * USD micros → integer minor units (cents), for `formatMoney` on the console.
 * Never rounds a real charge down to nothing.
 */
export function microsToMinorUnits(micros: number): number {
  if (micros <= 0) return 0;
  return Math.max(1, Math.round(micros / 10_000));
}

/**
 * Free-cap-adjusted cost for one day's units — **reporting only**. Must never
 * reach the budget guard (ADR-0012).
 */
export function freeCapAdjustedCostMicros(
  operation: string,
  day: string,
  units: number,
  unitsEarlierInMonth: number,
): number | null {
  const rule = ruleFor(operation, day);
  if (rule === null) return null;
  const estimate = estimateMicros(rule, units, unitsEarlierInMonth);
  return estimate.known ? estimate.freeAdjustedMicros : null;
}

/** Every operation the rules know, whether or not anything emits it. */
export function knownOperations(day: string = utcDay()): readonly PricingRow[] {
  return PROVIDER_PRICING.filter(
    (row) => row.effectiveFrom <= day && (row.effectiveTo === undefined || day < row.effectiveTo),
  );
}

// ── ops-console grouping (compat) ────────────────────────────────────────────

/**
 * The four groups the CMS ops console renders and the OpenAPI enum names.
 * They are a *presentation* grouping of Google services kept for contract
 * stability: `maps_sdk` merges the two SDK services the registry keeps apart.
 * The generic Cost Center (COST-BE-016+) reports by registry ids; this
 * grouping retires when the CMS API moves to them (epic §34–§36).
 */
export const OPS_PROVIDERS = ['places', 'routes', 'sheets', 'maps_sdk'] as const;
export type OpsProvider = (typeof OPS_PROVIDERS)[number];

/** Data, not a switch: which registry service renders under which console group. */
const OPS_GROUP_BY_SERVICE: Readonly<Record<string, OpsProvider>> = {
  'google.places': 'places',
  'google.routes': 'routes',
  'google.sheets': 'sheets',
  'google.maps_sdk_ios': 'maps_sdk',
  'google.maps_sdk_android': 'maps_sdk',
};

/**
 * Which console group an operation label belongs to. Exact registry match,
 * then the longest registered prefix (data on the service definition), so a
 * SKU nobody folded still lands on a provider row instead of vanishing.
 */
export function providerOf(method: string): OpsProvider | null {
  const service = COST_REGISTRY.serviceForOperation(operationForSku(method));
  return service ? (OPS_GROUP_BY_SERVICE[service.id] ?? null) : null;
}

/**
 * Why a number is missing. Two different absences, never merged.
 *
 * - `not_instrumented` — nobody counted it.
 * - `price_unknown` — the units are counted exactly; the price is unverified.
 */
export type CostGapKind = 'not_instrumented' | 'price_unknown';

export type CostGap = {
  /** The operation, or the provider when a whole provider is uninstrumented. */
  key: string;
  provider: OpsProvider | null;
  kind: CostGapKind;
  detail: string;
};

/**
 * COST-BE-028 (#387) — operations whose count arrives from a client rather
 * than from this process. Read from the registry, so nothing here names a
 * provider or a platform.
 */
const CLIENT_REPORTED_OPERATIONS = COST_REGISTRY.clientReportedOperations();

export type CostGapOptions = {
  /**
   * Whether `POST /v1/telemetry/provider-usage` is accepting client-reported
   * usage (`mobile_provider_usage.enabled`). While it is off, a client-reported
   * operation is exactly as uncounted as it was before #387 and keeps saying
   * so; while it is on, the units are measured and the only thing that can
   * still be missing is the price.
   */
  clientTelemetryEnabled?: boolean;
};

/** Whether `operation` is counted at all, given the client-telemetry state. */
function isInstrumented(row: PricingRow, options: CostGapOptions): boolean {
  if (row.instrumented) return true;
  return options.clientTelemetryEnabled === true && CLIENT_REPORTED_OPERATIONS.has(row.operation);
}

/** Gaps that exist regardless of traffic. */
export function staticCostGaps(day: string = utcDay(), options: CostGapOptions = {}): CostGap[] {
  return knownOperations(day)
    .map((row) => ({ row, instrumented: isInstrumented(row, options) }))
    .filter(({ row, instrumented }) => !instrumented || row.usdPer1000Micros === null)
    .map(({ row, instrumented }) => ({
      key: row.operation,
      provider: providerOf(row.operation),
      kind: (!instrumented ? 'not_instrumented' : 'price_unknown') as CostGapKind,
      detail: row.source,
    }));
}
