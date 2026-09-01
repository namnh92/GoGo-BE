/**
 * PR2 / COST-BE-002 (#335) — what each provider operation is, what Google
 * bills it as, and what that costs.
 *
 * Source: `Cost-Spec/GOGO_COST_AND_PLACES_EXECUTION_PLAN_v2_DECIDED.md` §2.2,
 * Google list prices fetched 2026-09-01.
 *
 * Three rules hold this file together, and every one of them exists because
 * the opposite has already been shipped somewhere:
 *
 * 1. **An operation is the adapter's own `method` label.** Not the SKU.
 *    `places_provider_requests_total{method}` and
 *    `places_provider_cost_units{sku}` disagree for exactly one operation —
 *    Routes bills as `routes.computeRouteMatrix` while its requests arrive as
 *    `google.routeMatrix` — and #332 already fixed the CMS row that split into
 *    "six calls, no cost" and "cost, no calls". `operationForSku` below is the
 *    one place that fold happens, and both the ledger and the ops API use it.
 *
 * 2. **An unknown price is `null`, never 0.** Routes Essentials is billed per
 *    element and the plan captured no per-element figure; the Maps SDK Dynamic
 *    Maps price is to be verified when telemetry lands. A `0` in either row
 *    would be a claim that those calls are free, which is false. `null`
 *    propagates: an operation with no price has no estimated cost, a provider
 *    containing one is `costComplete: false`, and the budget guard refuses to
 *    reserve it at all (§ `reserve`, below — a cost ceiling cannot bound a
 *    price nobody knows).
 *
 * 3. **An uninstrumented operation is a measurement gap, never a zero.** The
 *    two Maps SDK rows exist here so the CMS can name them. They carry
 *    `instrumented: false` because the SDK runs on the handset and this
 *    process has no telemetry from it; the plan's rejected-list says so in as
 *    many words ("Maps SDK usage reported as zero because telemetry is
 *    absent").
 */

/** Where a row's number came from, so a reviewer can re-derive it. */
export type PricingUnit = 'request' | 'element' | 'map_load';

export type PricingRow = {
  /** The adapter `method` label. One operation, one row per effective period. */
  operation: string;
  /** Google's billing SKU, or `null` where the call is not a billed SKU. */
  googleSku: string | null;
  unit: PricingUnit;
  /**
   * USD micros per 1,000 units, or `null` for UNKNOWN.
   *
   * Micros per thousand rather than per unit because every Google list price
   * is quoted per 1,000 and several are not whole cents ($2.83/1k). Integer
   * arithmetic all the way through: `$17/1k` is `17_000_000`.
   *
   * `0` means *known free* — Google publishes the SKU at no charge. It is a
   * different fact from `null`, and the difference is load-bearing.
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

const FETCHED = 'Google Places/Routes pricing pages, fetched 2026-09-01 (plan §2.2)';

/**
 * Bumped whenever a row changes. `pricingVersion` on the ops API is this
 * string, so a number on a dashboard can be traced to a price list.
 *
 * `provider-pricing.spec.ts` asserts it equals the newest `effectiveFrom` in
 * the registry — adding a row without bumping the version fails CI rather than
 * silently re-pricing history under the old label.
 */
export const PRICING_VERSION = '2026-09-01';

export const PRICING_CURRENCY = 'USD';

/**
 * The registry. Effective-dated: a historical day is priced with the rule that
 * was in force on that day, never with today's.
 */
export const PROVIDER_PRICING: readonly PricingRow[] = [
  {
    operation: 'google.searchText',
    googleSku: 'Places API (New) — Text Search Essentials IDs Only',
    unit: 'request',
    usdPer1000Micros: 0,
    freePerMonth: null,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source: `${FETCHED}. The adapter sends field mask \`places.id\` (google-places.adapter.ts), which is what makes it the IDs-Only SKU — widening that mask changes the price of every search.`,
  },
  {
    operation: 'google.details.liveness',
    googleSku: 'Places API (New) — Place Details Essentials IDs Only',
    unit: 'request',
    usdPer1000Micros: 0,
    freePerMonth: null,
    effectiveFrom: '2026-09-01',
    // The tier itself lands in PR5. The price list is not the caller.
    instrumented: true,
    source: `${FETCHED}. Tier added in PR5 (#338); the row exists now so the refresh budget can reserve against a known price rather than an absent one.`,
  },
  {
    operation: 'google.details.core',
    googleSku: 'Places API (New) — Place Details Pro',
    unit: 'request',
    usdPer1000Micros: 17_000_000,
    freePerMonth: 5_000,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source: `${FETCHED}. Mask is \`PLACE_FIELD_MASKS.core\`; \`businessStatus\` is a Pro field, which is why there is no cheaper "status" tier.`,
  },
  {
    operation: 'google.details.quality',
    googleSku: 'Places API (New) — Place Details Enterprise',
    unit: 'request',
    usdPer1000Micros: 20_000_000,
    freePerMonth: 1_000,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source: `${FETCHED}. Mask is \`PLACE_FIELD_MASKS.quality\` — rating, review count, hours, price level.`,
  },
  {
    operation: 'google.details.detail',
    googleSku: 'Places API (New) — Place Details Enterprise + Atmosphere',
    unit: 'request',
    usdPer1000Micros: 25_000_000,
    freePerMonth: 1_000,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source: `${FETCHED}. Mask is \`PLACE_FIELD_MASKS.detail\` — adds \`reviews\`, which is the Atmosphere field.`,
  },
  {
    operation: 'google.autocomplete',
    googleSku: 'Places API (New) — Autocomplete Requests',
    unit: 'request',
    usdPer1000Micros: 2_830_000,
    freePerMonth: 10_000,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source: `${FETCHED}. Area autocomplete only (\`AREA_AUTOCOMPLETE\`); billed per request.`,
  },
  {
    operation: 'google.routeMatrix',
    googleSku: 'Routes API — Compute Route Matrix Essentials',
    unit: 'element',
    // UNKNOWN, deliberately. The plan (§2.2) records the SKU and the free cap
    // and no per-element figure, so there is no verified price to put here.
    // Reporting it as 0 would say Routes is free; it is not.
    usdPer1000Micros: null,
    freePerMonth: 10_000,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source: `${FETCHED} records the SKU and the free cap but no per-element list price. UNKNOWN until one is verified — units are measured exactly, the money is not. Billed per matrix element, which is why the adapter increments by \`destinations.length\` and not by one.`,
  },
  {
    operation: 'google.expand',
    googleSku: null,
    unit: 'request',
    // Known free: a `maps.app.goo.gl` HEAD that follows redirects. No API key
    // rides on it and no Google Cloud SKU covers it.
    usdPer1000Micros: 0,
    freePerMonth: null,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source:
      'Short-link expansion — an unauthenticated HEAD to `maps.app.goo.gl` that follows redirects. Not a Google Cloud SKU, so known-free rather than unknown. Instrumented in this PR (#335): it was the one provider call emitting no counter, and baseline scenario C2 counts it.',
  },
  {
    operation: 'google.sheets.meta',
    googleSku: null,
    unit: 'request',
    usdPer1000Micros: 0,
    freePerMonth: null,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source:
      'Sheets API is quota-limited, not billed per call. Known free — which is why the adapter emits requests and latency but deliberately no `places_provider_cost_units`.',
  },
  {
    operation: 'google.sheets.values',
    googleSku: null,
    unit: 'request',
    usdPer1000Micros: 0,
    freePerMonth: null,
    effectiveFrom: '2026-09-01',
    instrumented: true,
    source: 'Sheets API is quota-limited, not billed per call. Known free.',
  },
  {
    operation: 'google.maps_sdk_ios',
    googleSku: 'Maps SDK for iOS — Dynamic Maps',
    unit: 'map_load',
    usdPer1000Micros: null,
    freePerMonth: null,
    effectiveFrom: '2026-09-01',
    instrumented: false,
    source:
      'MEASUREMENT GAP. The SDK renders on the handset; this process sees no map load, so there is no unit count to price and no price verified. Reported as a gap, never as zero usage or zero cost (plan §6, ADR-0004 amendment).',
  },
  {
    operation: 'google.maps_sdk_android',
    googleSku: 'Maps SDK for Android — Dynamic Maps',
    unit: 'map_load',
    usdPer1000Micros: null,
    freePerMonth: null,
    effectiveFrom: '2026-09-01',
    instrumented: false,
    source:
      'MEASUREMENT GAP. Same as iOS: client-side rendering, no server-side telemetry, no verified Dynamic Maps price. Never zero.',
  },
];

/**
 * The one place a billed SKU label folds onto the operation that spent it.
 *
 * For Places the two strings are identical — `places_provider_cost_units` is
 * labelled with the operation name. Routes is the exception and the reason
 * this function exists (#332).
 */
const SKU_OPERATION: Readonly<Record<string, string>> = {
  'routes.computeRouteMatrix': 'google.routeMatrix',
};

export function operationForSku(sku: string): string {
  return SKU_OPERATION[sku] ?? sku;
}

/** UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The row in force for `operation` on `day`, or `null` if the operation is not
 * in the registry at all.
 *
 * An operation nobody priced is not free — it is unknown, and every caller
 * treats the `null` that way.
 */
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

/**
 * List-price cost of `units`, in USD micros, or `null` when the price is
 * unknown.
 *
 * Rounded **up**. A fraction of a micro is not worth an argument, and every
 * consumer of this number is either a safety ceiling (where over-stating is
 * the safe direction) or an estimate already labelled as one.
 */
export function listCostMicros(operation: string, day: string, units: number): number | null {
  const row = pricingFor(operation, day);
  if (row === null || row.usdPer1000Micros === null) return null;
  if (units <= 0) return 0;
  return Math.ceil((units * row.usdPer1000Micros) / 1000);
}

/**
 * USD micros → integer minor units (cents), for `formatMoney` on the console.
 *
 * Never rounds a real charge down to nothing. Half a cent spent is not zero
 * spent, and a dashboard that prints `$0.00` beside a hundred billed calls is
 * the same 0-versus-unknown failure this whole surface exists to avoid — the
 * codebase already made this call once, for `roundCount` on request counts.
 * The exact figure travels alongside as `estimatedCostMicros`; nothing is
 * lost, and the rounding is presentation only.
 */
export function microsToMinorUnits(micros: number): number {
  if (micros <= 0) return 0;
  return Math.max(1, Math.round(micros / 10_000));
}

/**
 * Free-cap-adjusted cost for one day's units — **reporting only**.
 *
 * `estimatedCost(day, operation) = max(0, units − freeRemaining(month, sku)) ×
 * price(effective on day)` (plan §2.2).
 *
 * `unitsEarlierInMonth` is this environment's own month-to-date total for the
 * same SKU before `day`. Google applies free caps per *billing account* per
 * SKU across every linked project, and GoGo has no authoritative view of that,
 * so this is an approximation and is labelled `basis: ESTIMATED, confidence:
 * MEDIUM` wherever it surfaces.
 *
 * It must never reach the budget guard. An over-generous free-tier guess would
 * authorise a paid call, and "may the scheduler spend money" is a safety
 * property, not an estimate (plan §2.2, §6).
 */
export function freeCapAdjustedCostMicros(
  operation: string,
  day: string,
  units: number,
  unitsEarlierInMonth: number,
): number | null {
  const row = pricingFor(operation, day);
  if (row === null || row.usdPer1000Micros === null) return null;
  if (row.freePerMonth === null) return listCostMicros(operation, day, units);
  const freeRemaining = Math.max(0, row.freePerMonth - Math.max(0, unitsEarlierInMonth));
  const billable = Math.max(0, units - freeRemaining);
  return listCostMicros(operation, day, billable);
}

/** Every operation the registry knows, whether or not anything emits it. */
export function knownOperations(day: string = utcDay()): readonly PricingRow[] {
  return PROVIDER_PRICING.filter(
    (row) => row.effectiveFrom <= day && (row.effectiveTo === undefined || day < row.effectiveTo),
  );
}

// ── provider taxonomy ──────────────────────────────────────────────────────

/**
 * The services an operation can belong to.
 *
 * `maps_sdk` joined the list in PR2 (#335) and carries no measurement at all:
 * the SDK renders on the handset and this process never sees a map load. It is
 * here precisely so the console can print "chưa đo" against a named provider
 * instead of leaving it out — an absent row and a zero row read the same to
 * anyone who is not holding the spec.
 */
export const OPS_PROVIDERS = ['places', 'routes', 'sheets', 'maps_sdk'] as const;
export type OpsProvider = (typeof OPS_PROVIDERS)[number];

/**
 * Which service an adapter operation belongs to, derived from the `method`
 * label rather than from a new one — the label set is already bounded, and a
 * producer change for a grouping the reader can do is a bad trade.
 *
 * Order matters: `google.sheets.`, `google.maps_sdk_` and the Routes pair are
 * matched before the bare `google.` prefix, which would otherwise swallow all
 * four.
 */
export function providerOf(method: string): OpsProvider | null {
  if (method.startsWith('google.sheets.')) return 'sheets';
  if (method.startsWith('google.maps_sdk_')) return 'maps_sdk';
  if (method === 'google.routeMatrix') return 'routes';
  // Backstop. `operationForSku` folds `routes.computeRouteMatrix` onto
  // `google.routeMatrix` before this is reached, so nothing should arrive here
  // under a SKU name — but a SKU nobody remembered to map must land on the
  // right provider rather than vanish, because vanishing means a billed
  // provider reports `null` spend and `null` renders as "chưa đo".
  if (method.startsWith('routes.')) return 'routes';
  if (method.startsWith('google.')) return 'places';
  return null;
}

/**
 * Why a number is missing. Two different absences, never merged.
 *
 * - `not_instrumented` — nobody counted it. The units are unknown, so the cost
 *   is unknown, and no amount of pricing work fixes it.
 * - `price_unknown` — the units are counted exactly; the list price has not
 *   been verified. Fixed by putting a number in the registry.
 *
 * Both render as "chưa đo"-class states in the console, but an operator
 * chasing one of them does something completely different from an operator
 * chasing the other.
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
 * Gaps that exist regardless of traffic — the registry rows that can never
 * produce a number until something outside this repo changes.
 */
export function staticCostGaps(day: string = utcDay()): CostGap[] {
  return knownOperations(day)
    .filter((row) => !row.instrumented || row.usdPer1000Micros === null)
    .map((row) => ({
      key: row.operation,
      provider: providerOf(row.operation),
      kind: (!row.instrumented ? 'not_instrumented' : 'price_unknown') as CostGapKind,
      detail: row.source,
    }));
}
