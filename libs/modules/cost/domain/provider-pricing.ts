/**
 * COST-BE-002 (#335) — Google list prices, effective-dated, in code.
 *
 * In code rather than in a table on purpose. A price is a fact about the
 * outside world on a given date; it is reviewed, versioned and rolled back
 * with the deploy that introduced it, and an operator editing a price row at
 * 2am is not a workflow anyone asked for. `PRICING_VERSION` travels in the API
 * response so a number can always be traced to the table that produced it.
 *
 * Everything here is **list price**. Google's free monthly caps and volume
 * discounts pool per billing account per SKU across every linked project, and
 * GoGo has no authoritative view of that pool. Free-cap arithmetic therefore
 * lives in reporting (`estimateCostMicros`), clearly labelled as an estimate,
 * and never in the budget guard.
 *
 * Money is integer USD micros end to end. A price of $17 per 1,000 requests is
 * 17,000 micros per request, which divides exactly; floats do not belong
 * anywhere near a number that ends up next to a currency symbol.
 */

/** What one billable unit *is*, which differs per SKU and changes the maths. */
export type PricingUnit = 'request' | 'element' | 'map_load';

export type PricingRow = {
  /** The billing label, as it appears on `places_provider_cost_units{sku}`. */
  operation: string;
  /** Google's own SKU name, for reconciling against an invoice line. */
  googleSku: string;
  unit: PricingUnit;
  /**
   * USD micros per 1,000 units, or `null` for **price not established**.
   *
   * `null` is not zero and must never render as zero. The Maps SDK rows exist
   * precisely so that an un-instrumented, genuinely billed surface reports
   * UNKNOWN rather than disappearing from the total — an absent row and a
   * zero row look identical in a sum, and only one of them is honest.
   */
  usdPer1000Micros: number | null;
  /** Free units per month, pooled per billing account. 0 = none. */
  freePerMonth: number;
  /** Inclusive, `YYYY-MM-DD` UTC. */
  effectiveFrom: string;
  /** Exclusive. Absent = still in force. */
  effectiveTo?: string;
  source: string;
};

/**
 * Bumped whenever a row changes. Returned on every priced response so a
 * figure in a screenshot can be traced to the table that produced it.
 */
export const PRICING_VERSION = '2026-09-01';

export const PRICING_CURRENCY = 'USD';

const LIST_2026_09_01 = 'Google Maps Platform list price, fetched 2026-09-01';

/**
 * Initial rows, plan §2.2. One row per SKU GoGo can actually emit.
 *
 * Sheets is free and says so with a real 0 — that is a measured zero, not an
 * unknown, and the two must stay distinguishable.
 */
export const PROVIDER_PRICING: readonly PricingRow[] = [
  {
    operation: 'google.searchText',
    googleSku: 'Text Search IDs-Only',
    unit: 'request',
    usdPer1000Micros: 0,
    freePerMonth: 0,
    effectiveFrom: '2026-09-01',
    source: LIST_2026_09_01,
  },
  {
    operation: 'google.details.liveness',
    googleSku: 'Place Details IDs-Only',
    unit: 'request',
    usdPer1000Micros: 0,
    freePerMonth: 0,
    effectiveFrom: '2026-09-01',
    source: LIST_2026_09_01,
  },
  {
    operation: 'google.details.core',
    googleSku: 'Place Details Pro',
    unit: 'request',
    usdPer1000Micros: 17_000_000,
    freePerMonth: 5_000,
    effectiveFrom: '2026-09-01',
    source: LIST_2026_09_01,
  },
  {
    operation: 'google.details.quality',
    googleSku: 'Place Details Enterprise',
    unit: 'request',
    usdPer1000Micros: 20_000_000,
    freePerMonth: 1_000,
    effectiveFrom: '2026-09-01',
    source: LIST_2026_09_01,
  },
  {
    operation: 'google.details.detail',
    googleSku: 'Place Details Enterprise + Atmosphere',
    unit: 'request',
    usdPer1000Micros: 25_000_000,
    freePerMonth: 1_000,
    effectiveFrom: '2026-09-01',
    source: LIST_2026_09_01,
  },
  {
    operation: 'google.autocomplete',
    googleSku: 'Autocomplete Requests',
    unit: 'request',
    usdPer1000Micros: 2_830_000,
    freePerMonth: 10_000,
    effectiveFrom: '2026-09-01',
    source: LIST_2026_09_01,
  },
  {
    operation: 'routes.computeRouteMatrix',
    googleSku: 'Routes Essentials (Compute Route Matrix)',
    unit: 'element',
    usdPer1000Micros: 5_000_000,
    freePerMonth: 10_000,
    effectiveFrom: '2026-09-01',
    source: LIST_2026_09_01,
  },
  {
    operation: 'google.sheets.values',
    googleSku: 'Sheets API',
    unit: 'request',
    // A measured zero, not an unknown: Sheets is free, and the distinction
    // between "costs nothing" and "we have no price" must survive into the API.
    usdPer1000Micros: 0,
    freePerMonth: 0,
    effectiveFrom: '2026-09-01',
    source: 'Google Sheets API is not billed per request',
  },
  {
    operation: 'google.maps_sdk_ios',
    googleSku: 'Dynamic Maps (iOS)',
    unit: 'map_load',
    // MEASUREMENT GAP, plan §0.2 C1. The SDK is billed and GoGo has no
    // telemetry for it, so the row exists with no price. Deleting it would
    // make a billed surface vanish from the report; setting 0 would claim it
    // is free. Both are lies; `null` is the fact.
    usdPer1000Micros: null,
    freePerMonth: 0,
    effectiveFrom: '2026-09-01',
    source: 'Price to be verified when Maps SDK telemetry lands (PR11+)',
  },
  {
    operation: 'google.maps_sdk_android',
    googleSku: 'Dynamic Maps (Android)',
    unit: 'map_load',
    usdPer1000Micros: null,
    freePerMonth: 0,
    effectiveFrom: '2026-09-01',
    source: 'Price to be verified when Maps SDK telemetry lands (PR11+)',
  },
];

/**
 * Request label → billing label.
 *
 * The inverse of `operationForSku` in `cms/domain/ops-metrics.ts`, and needed
 * for the opposite reason. That one folds the SKU onto the request label so
 * one *operation* reads as one row on the ops dashboard. This one folds the
 * request label onto the SKU so one *invoice line* reads as one row in the
 * ledger. Routes is the only operation where the two labels differ.
 */
const BILLING_OPERATION: Readonly<Record<string, string>> = {
  'google.routeMatrix': 'routes.computeRouteMatrix',
};

export function billingOperationOf(method: string): string {
  return BILLING_OPERATION[method] ?? method;
}

/** UTC calendar day, `YYYY-MM-DD` — the key both cost tables are bucketed by. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** UTC month, `YYYY-MM` — the window Google pools free caps over. */
export function utcMonth(day: string): string {
  return day.slice(0, 7);
}

/**
 * The row in force for an operation on a given day.
 *
 * Historical days are priced with the rule that applied then, not with today's
 * — re-pricing the past would make last month's reported spend change every
 * time a price does, and a report nobody can reproduce is not a report.
 */
export function pricingFor(operation: string, day: string): PricingRow | null {
  const candidates = PROVIDER_PRICING.filter(
    (row) =>
      row.operation === operation &&
      row.effectiveFrom <= day &&
      (row.effectiveTo === undefined || day < row.effectiveTo),
  );
  if (candidates.length === 0) return null;
  // Latest effective row wins, so an overlapping correction supersedes.
  return candidates.reduce((best, row) => (row.effectiveFrom > best.effectiveFrom ? row : best));
}

/** Every operation the registry can price on a day — the ops API's vocabulary. */
export function knownOperations(day: string = utcDay()): readonly PricingRow[] {
  return PROVIDER_PRICING.filter(
    (row) => row.effectiveFrom <= day && (row.effectiveTo === undefined || day < row.effectiveTo),
  );
}

/**
 * List cost in USD micros, ignoring free caps. `null` when unpriceable.
 *
 * This is the number the budget guard reserves against: worst case, nothing
 * free, no discount. Unknown price yields `null`, and a caller that cannot
 * price a call must refuse it rather than treat it as free.
 */
export function listCostMicros(operation: string, day: string, units: number): number | null {
  const row = pricingFor(operation, day);
  if (!row || row.usdPer1000Micros === null) return null;
  if (units <= 0) return 0;
  // Integer maths throughout: per-1000 pricing over integer units, rounded up
  // so a fractional micro is never rounded in the spender's favour.
  return Math.ceil((row.usdPer1000Micros * units) / 1000);
}

/**
 * Reporting estimate: list cost with the month's free allowance applied.
 *
 * `freeUnitsAlreadyUsed` is GoGo's own count for the environment, which is not
 * Google's — the real cap pools across every project on the billing account.
 * That makes this an estimate and it is labelled one everywhere it surfaces
 * (`basis: 'ESTIMATED'`, `confidence: 'MEDIUM'`). It is deliberately absent
 * from the budget guard, where an optimistic number authorises real spend.
 */
export function estimateCostMicros(input: {
  operation: string;
  day: string;
  units: number;
  freeUnitsAlreadyUsed: number;
}): number | null {
  const row = pricingFor(input.operation, input.day);
  if (!row || row.usdPer1000Micros === null) return null;
  if (input.units <= 0) return 0;
  const freeRemaining = Math.max(0, row.freePerMonth - Math.max(0, input.freeUnitsAlreadyUsed));
  const billable = Math.max(0, input.units - freeRemaining);
  return Math.ceil((row.usdPer1000Micros * billable) / 1000);
}

/**
 * USD micros → minor units (cents), rounded half-up.
 *
 * The API reports integer minor units + currency, like every other amount in
 * GoGo. Sub-cent precision survives in micros for the arithmetic and is only
 * dropped at the boundary, once.
 */
export function microsToMinorUnits(micros: number): number {
  return Math.round(micros / 10_000);
}
