import type { MeterUnit } from './registry';

/**
 * COST-BE-015 (#367) — epic §13–§15, pricing as a separate, versioned subsystem.
 *
 * A pricing rule binds a price to a **billing SKU or usage meter**, never to
 * a request count by assumption (epic §4, §44.23): Routes is priced per matrix
 * element and Places per request because that is what Google's contract says,
 * not because one call is one unit. No formula lives anywhere but here, and
 * generic cost code calls `estimateMicros` with a rule and a quantity.
 *
 * Three facts that must survive every edit:
 *
 * 1. **History is never re-priced.** A rule has `effectiveFrom`/`effectiveTo`;
 *    a price change is a new rule with a new version, and a day is priced with
 *    the rule in force on that day (§14).
 * 2. **An unknown price is `null`, never 0.** `unitPriceMicros: null` says
 *    "verified nothing"; `pricingModel: 'FREE'` says "verified free". Every
 *    consumer keeps them apart (§11 "UNKNOWN → 0" is forbidden).
 * 3. **A free allowance is reporting only.** The budget guard deducts none of
 *    it (ADR-0012); the estimator may, and labels the result ESTIMATED.
 */

export const PRICING_MODELS = [
  'FREE',
  'PER_REQUEST',
  'PER_1K_REQUESTS',
  'PER_MILLION_REQUESTS',
  'PER_OPERATION',
  'PER_GB',
  'PER_GB_MONTH',
  'PER_ACTIVE_USER',
  'PER_CONVERSION',
  'FIXED_MONTHLY',
  'FIXED_ANNUAL',
  'TIERED',
] as const;

export type PricingModel = (typeof PRICING_MODELS)[number];

/** Epic §15. `period` is what resets the allowance; `scope` is what shares it. */
export type FreeAllowance = {
  quantity: number;
  unit: MeterUnit;
  period: 'DAY' | 'MONTH' | 'YEAR';
  scope: 'DAILY' | 'MONTHLY' | 'PROJECT' | 'ACCOUNT' | 'SERVICE' | 'SKU';
};

/** A tier: units up to `upTo` (inclusive; `null` = unbounded) cost `unitPriceMicros` each. */
export type PricingTier = { upTo: number | null; unitPriceMicros: number };

export type PricingRule = {
  /** `<provider>-<sku or meter>-<effectiveFrom>-v<n>` — stable, never reused. */
  id: string;
  providerId: string;
  serviceId: string;
  operationId: string | null;
  usageMetricId: string | null;
  billingSkuId: string | null;
  region: string | null;
  platform: string | null;
  /** UTC date, inclusive. */
  effectiveFrom: string;
  /** UTC date, exclusive. `null` = still in force. */
  effectiveTo: string | null;
  currency: string;
  pricingModel: PricingModel;
  /**
   * Price per **model unit** in currency micros — per request, per 1,000
   * units, per million, per GB, per month… `null` = unknown (never 0).
   * Ignored for `FREE` (0) and `TIERED` (see `tiers`).
   */
  unitPriceMicros: number | null;
  tiers: readonly PricingTier[] | null;
  freeAllowance: FreeAllowance | null;
  /** Bumped with every change to this rule's family. Historical rules keep theirs. */
  version: string;
  sourceReference: string;
  /** UTC date the price was last checked against the provider's page. */
  reviewedAt: string;
};

export type EstimateResult =
  /** Known price. `listMicros` at list; `freeAdjustedMicros` after the allowance. */
  | { known: true; listMicros: number; freeAdjustedMicros: number }
  /** Verified nothing. Callers report a gap, never a zero. */
  | { known: false };

/**
 * List-price cost of `quantity` units under `rule`, and the same after the
 * rule's free allowance given `priorInPeriod` units already consumed in the
 * allowance period. Rounded **up** to the micro (a fraction of a micro is not
 * worth a dispute, and every reader is either a ceiling or an estimate).
 */
export function estimateMicros(
  rule: PricingRule,
  quantity: number,
  priorInPeriod = 0,
): EstimateResult {
  const qty = Math.max(0, quantity);
  const priced = priceAtList(rule, qty);
  if (priced === null) return { known: false };
  const allowance = rule.freeAllowance;
  if (allowance === null) return { known: true, listMicros: priced, freeAdjustedMicros: priced };
  const remaining = Math.max(0, allowance.quantity - Math.max(0, priorInPeriod));
  const billable = Math.max(0, qty - remaining);
  const adjusted = priceAtList(rule, billable);
  return { known: true, listMicros: priced, freeAdjustedMicros: adjusted ?? priced };
}

function priceAtList(rule: PricingRule, qty: number): number | null {
  switch (rule.pricingModel) {
    case 'FREE':
      return 0;
    case 'TIERED': {
      if (rule.tiers === null || rule.tiers.length === 0) return null;
      let remaining = qty;
      let lowerBound = 0;
      let total = 0;
      for (const tier of rule.tiers) {
        if (remaining <= 0) break;
        const width = tier.upTo === null ? remaining : Math.max(0, tier.upTo - lowerBound);
        const inTier = Math.min(remaining, width);
        total += inTier * tier.unitPriceMicros;
        remaining -= inTier;
        lowerBound = tier.upTo ?? lowerBound;
      }
      // Units past the last bounded tier with no unbounded tier: unpriced.
      if (remaining > 0) return null;
      return Math.ceil(total);
    }
    case 'FIXED_MONTHLY':
    case 'FIXED_ANNUAL':
      // A subscription costs its price once per period regardless of `qty`;
      // the estimator for FIXED rows runs per period, not per unit.
      return rule.unitPriceMicros;
    case 'PER_1K_REQUESTS':
      return rule.unitPriceMicros === null ? null : Math.ceil((qty * rule.unitPriceMicros) / 1_000);
    case 'PER_MILLION_REQUESTS':
      return rule.unitPriceMicros === null
        ? null
        : Math.ceil((qty * rule.unitPriceMicros) / 1_000_000);
    case 'PER_REQUEST':
    case 'PER_OPERATION':
    case 'PER_GB':
    case 'PER_GB_MONTH':
    case 'PER_ACTIVE_USER':
    case 'PER_CONVERSION':
      return rule.unitPriceMicros === null ? null : Math.ceil(qty * rule.unitPriceMicros);
  }
}

/** The rule in force on `day` for the given key. Exact key match only. */
export function ruleInForce(
  rules: readonly PricingRule[],
  key: { billingSkuId?: string | null; usageMetricId?: string | null; operationId?: string | null },
  day: string,
): PricingRule | null {
  return (
    rules.find(
      (r) =>
        (key.billingSkuId !== undefined
          ? r.billingSkuId === key.billingSkuId
          : key.usageMetricId !== undefined
            ? r.usageMetricId === key.usageMetricId
            : r.operationId === key.operationId) &&
        r.effectiveFrom <= day &&
        (r.effectiveTo === null || day < r.effectiveTo),
    ) ?? null
  );
}

// ── seed: Google, list prices fetched 2026-09-01 ─────────────────────────────

const FETCHED = 'Google Places/Routes pricing pages, fetched 2026-09-01 (plan §2.2, historical)';
const GOOGLE_VERSION = 'google-2026-09-01-v1';

function googleRule(
  input: Omit<
    PricingRule,
    | 'id'
    | 'providerId'
    | 'region'
    | 'platform'
    | 'effectiveTo'
    | 'currency'
    | 'version'
    | 'reviewedAt'
    | 'tiers'
  > &
    Partial<Pick<PricingRule, 'platform' | 'tiers'>>,
): PricingRule {
  return {
    id: `google-${input.billingSkuId ?? input.operationId ?? input.usageMetricId}-${input.effectiveFrom}-v1`,
    providerId: 'google',
    region: null,
    platform: null,
    effectiveTo: null,
    currency: 'USD',
    version: GOOGLE_VERSION,
    reviewedAt: '2026-09-01',
    tiers: null,
    ...input,
  };
}

const monthlySku = (quantity: number, unit: MeterUnit): FreeAllowance => ({
  quantity,
  unit,
  period: 'MONTH',
  scope: 'SKU',
});

/**
 * The registry. Read through `PRICING_RULES`; add a rule by appending, never
 * by editing a row that a past day was priced with.
 */
export const PRICING_RULES: readonly PricingRule[] = [
  googleRule({
    serviceId: 'google.places',
    operationId: 'google.searchText',
    usageMetricId: 'google.searchText/requests',
    billingSkuId: 'places.textSearch.idsOnly',
    effectiveFrom: '2026-09-01',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    freeAllowance: null,
    sourceReference: `${FETCHED}. The adapter sends field mask \`places.id\` (google-places.adapter.ts), which is what makes it the IDs-Only SKU — widening that mask changes the price of every search.`,
  }),
  googleRule({
    serviceId: 'google.places',
    operationId: 'google.details.liveness',
    usageMetricId: 'google.details.liveness/requests',
    billingSkuId: 'places.details.idsOnly',
    effectiveFrom: '2026-09-01',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    freeAllowance: null,
    sourceReference: `${FETCHED}. Tier added in PR5 (#338); the row exists so the refresh budget can reserve against a known price rather than an absent one.`,
  }),
  googleRule({
    serviceId: 'google.places',
    operationId: 'google.details.core',
    usageMetricId: 'google.details.core/requests',
    billingSkuId: 'places.details.pro',
    effectiveFrom: '2026-09-01',
    pricingModel: 'PER_1K_REQUESTS',
    unitPriceMicros: 17_000_000,
    freeAllowance: monthlySku(5_000, 'request'),
    sourceReference: `${FETCHED}. Mask is \`PLACE_FIELD_MASKS.core\`; \`businessStatus\` is a Pro field, which is why there is no cheaper "status" tier.`,
  }),
  googleRule({
    serviceId: 'google.places',
    operationId: 'google.details.quality',
    usageMetricId: 'google.details.quality/requests',
    billingSkuId: 'places.details.enterprise',
    effectiveFrom: '2026-09-01',
    pricingModel: 'PER_1K_REQUESTS',
    unitPriceMicros: 20_000_000,
    freeAllowance: monthlySku(1_000, 'request'),
    sourceReference: `${FETCHED}. Mask is \`PLACE_FIELD_MASKS.quality\` — rating, review count, hours, price level.`,
  }),
  googleRule({
    serviceId: 'google.places',
    operationId: 'google.details.detail',
    usageMetricId: 'google.details.detail/requests',
    billingSkuId: 'places.details.enterpriseAtmosphere',
    effectiveFrom: '2026-09-01',
    pricingModel: 'PER_1K_REQUESTS',
    unitPriceMicros: 25_000_000,
    freeAllowance: monthlySku(1_000, 'request'),
    sourceReference: `${FETCHED}. Mask is \`PLACE_FIELD_MASKS.detail\` — adds \`reviews\`, which is the Atmosphere field.`,
  }),
  googleRule({
    serviceId: 'google.places',
    operationId: 'google.autocomplete',
    usageMetricId: 'google.autocomplete/requests',
    billingSkuId: 'places.autocomplete.requests',
    effectiveFrom: '2026-09-01',
    pricingModel: 'PER_1K_REQUESTS',
    unitPriceMicros: 2_830_000,
    freeAllowance: monthlySku(10_000, 'request'),
    sourceReference: `${FETCHED}. Area autocomplete only (\`AREA_AUTOCOMPLETE\`); billed per request.`,
  }),
  googleRule({
    serviceId: 'google.routes',
    operationId: 'google.routeMatrix',
    usageMetricId: 'google.routeMatrix/billable_elements',
    billingSkuId: 'routes.computeRouteMatrix',
    effectiveFrom: '2026-09-01',
    // Per 1,000 matrix elements — the model name says "requests" because the
    // epic's list does; the meter's unit says what is counted.
    pricingModel: 'PER_1K_REQUESTS',
    // UNKNOWN, deliberately: the source records the SKU and the free cap and
    // no per-element figure. 0 would say Routes is free; it is not.
    unitPriceMicros: null,
    freeAllowance: monthlySku(10_000, 'matrix_element'),
    sourceReference: `${FETCHED} records the SKU and the free cap but no per-element list price. UNKNOWN until one is verified — units are measured exactly, the money is not. Billed per matrix element, which is why the adapter increments by \`destinations.length\` and not by one.`,
  }),
  googleRule({
    serviceId: 'google.places',
    operationId: 'google.expand',
    usageMetricId: 'google.expand/requests',
    billingSkuId: null,
    effectiveFrom: '2026-09-01',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    freeAllowance: null,
    sourceReference:
      'Short-link expansion — an unauthenticated HEAD to `maps.app.goo.gl` that follows redirects. Not a Google Cloud SKU, so known-free rather than unknown. Instrumented in #335: it was the one provider call emitting no counter, and baseline scenario C2 counts it.',
  }),
  googleRule({
    serviceId: 'google.sheets',
    operationId: 'google.sheets.meta',
    usageMetricId: 'google.sheets.meta/requests',
    billingSkuId: null,
    effectiveFrom: '2026-09-01',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    freeAllowance: null,
    sourceReference:
      'Sheets API is quota-limited, not billed per call. Known free — which is why the adapter emits requests and latency but deliberately no `places_provider_cost_units`.',
  }),
  googleRule({
    serviceId: 'google.sheets',
    operationId: 'google.sheets.values',
    usageMetricId: 'google.sheets.values/requests',
    billingSkuId: null,
    effectiveFrom: '2026-09-01',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    freeAllowance: null,
    sourceReference: 'Sheets API is quota-limited, not billed per call. Known free.',
  }),
  googleRule({
    serviceId: 'google.maps_sdk_ios',
    operationId: 'google.maps_sdk_ios',
    usageMetricId: 'google.maps_sdk_ios/map_loads',
    billingSkuId: 'maps.dynamic.ios',
    platform: 'ios',
    effectiveFrom: '2026-09-01',
    pricingModel: 'PER_1K_REQUESTS',
    unitPriceMicros: null,
    freeAllowance: null,
    sourceReference:
      'MEASUREMENT GAP. The SDK renders on the handset; this process sees no map load, so there is no unit count to price and no price verified. Reported as a gap, never as zero usage or zero cost (epic §18, ADR-0004 amendment).',
  }),
  googleRule({
    serviceId: 'google.maps_sdk_android',
    operationId: 'google.maps_sdk_android',
    usageMetricId: 'google.maps_sdk_android/map_loads',
    billingSkuId: 'maps.dynamic.android',
    platform: 'android',
    effectiveFrom: '2026-09-01',
    pricingModel: 'PER_1K_REQUESTS',
    unitPriceMicros: null,
    freeAllowance: null,
    sourceReference:
      'MEASUREMENT GAP. Same as iOS: client-side rendering, no server-side telemetry, no verified Dynamic Maps price. Never zero.',
  }),
];

/**
 * The newest `effectiveFrom` in the registry, which is what a report labels
 * its numbers with. `provider-pricing.spec.ts` pins `PRICING_VERSION` to it,
 * so a rule added without a version bump fails CI.
 */
export function newestEffectiveFrom(rules: readonly PricingRule[] = PRICING_RULES): string {
  return rules
    .map((r) => r.effectiveFrom)
    .sort()
    .at(-1)!;
}
