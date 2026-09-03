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
  day?: string,
): EstimateResult {
  const qty = Math.max(0, quantity);
  // A `PER_GB_MONTH` rule priced for one day charges 1/D of the monthly price
  // and consumes 1/D of a GB-month of allowance (see `priceAtList`).
  const share = rule.pricingModel === 'PER_GB_MONTH' && day !== undefined ? daysInMonthOf(day) : 1;
  const priced = priceAtList(rule, qty, share);
  if (priced === null) return { known: false };
  const allowance = rule.freeAllowance;
  if (allowance === null) return { known: true, listMicros: priced, freeAdjustedMicros: priced };
  const remaining = Math.max(0, allowance.quantity * share - Math.max(0, priorInPeriod));
  const billable = Math.max(0, qty - remaining);
  const adjusted = priceAtList(rule, billable, share);
  return { known: true, listMicros: priced, freeAdjustedMicros: adjusted ?? priced };
}

/** Days in the UTC month of `day` (`YYYY-MM-DD`). */
function daysInMonthOf(day: string): number {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * List price of `qty` model units. `share` > 1 only for `PER_GB_MONTH` rows
 * that carry one day of a monthly average: a `gb_month` meter is sampled
 * daily as that day's peak GB (Cloudflare R2 bills "the average of the peak
 * storage per day over a billing period"), so one day is worth 1/D of the
 * monthly price. Without a `day` the quantity is taken as whole GB-months.
 */
function priceAtList(rule: PricingRule, qty: number, share = 1): number | null {
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
    case 'PER_GB_MONTH':
      return rule.unitPriceMicros === null ? null : Math.ceil((qty * rule.unitPriceMicros) / share);
    case 'PER_REQUEST':
    case 'PER_OPERATION':
    case 'PER_GB':
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
 * COST-BE-024 (#383) — Cloudflare R2 and Workers, from the pricing pages
 * fetched 2026-09-03 (`developers.cloudflare.com/r2/pricing`,
 * `developers.cloudflare.com/workers/platform/pricing`). Every meter is a
 * service-level meter (no operation), so the rules bind to the SKU and the
 * meter id and leave `operationId` null.
 *
 * R2 free tier (epic §15 allowance, per account per month): 10 GB-month of
 * storage, 1 million Class A, 10 million Class B; egress free. Workers is on
 * the Free plan (Terraform: one script, no paid subscription): 100,000
 * requests per day is a hard cap, not a price, hence `FREE` with the daily
 * allowance recorded for reporting — the rule becomes `PER_MILLION_REQUESTS`
 * at 300,000 micros with a 10M/month allowance the day the plan changes.
 */
const CF_FETCHED =
  'Cloudflare R2 / Workers pricing pages, fetched 2026-09-03 (developers.cloudflare.com/r2/pricing, developers.cloudflare.com/workers/platform/pricing)';
const CLOUDFLARE_VERSION = 'cloudflare-2026-09-03-v1';

function cloudflareRule(
  input: Pick<
    PricingRule,
    | 'serviceId'
    | 'usageMetricId'
    | 'billingSkuId'
    | 'pricingModel'
    | 'unitPriceMicros'
    | 'freeAllowance'
    | 'sourceReference'
  >,
): PricingRule {
  return {
    id: `cloudflare-${input.billingSkuId}-2026-09-01-v1`,
    providerId: 'cloudflare',
    operationId: null,
    region: null,
    platform: null,
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
    currency: 'USD',
    tiers: null,
    version: CLOUDFLARE_VERSION,
    reviewedAt: '2026-09-03',
    ...input,
  };
}

const CLOUDFLARE_RULES: readonly PricingRule[] = [
  cloudflareRule({
    serviceId: 'cloudflare.r2',
    usageMetricId: 'cloudflare.r2/class_a',
    billingSkuId: 'r2.class_a',
    pricingModel: 'PER_MILLION_REQUESTS',
    unitPriceMicros: 4_500_000,
    freeAllowance: { quantity: 1_000_000, unit: 'operation', period: 'MONTH', scope: 'SKU' },
    sourceReference: `${CF_FETCHED}: "Class A operations $4.50 / million requests", "1 million requests / month" free. Writes and lists — PutObject, CopyObject, ListObjects, multipart parts.`,
  }),
  cloudflareRule({
    serviceId: 'cloudflare.r2',
    usageMetricId: 'cloudflare.r2/class_b',
    billingSkuId: 'r2.class_b',
    pricingModel: 'PER_MILLION_REQUESTS',
    unitPriceMicros: 360_000,
    freeAllowance: { quantity: 10_000_000, unit: 'operation', period: 'MONTH', scope: 'SKU' },
    sourceReference: `${CF_FETCHED}: "Class B operations $0.36 / million requests", "10 million requests / month" free. Reads and heads — GetObject, HeadObject, HeadBucket.`,
  }),
  cloudflareRule({
    serviceId: 'cloudflare.r2',
    usageMetricId: 'cloudflare.r2/storage_gb_month',
    billingSkuId: 'r2.storage',
    pricingModel: 'PER_GB_MONTH',
    unitPriceMicros: 15_000,
    freeAllowance: { quantity: 10, unit: 'gb_month', period: 'MONTH', scope: 'SKU' },
    sourceReference: `${CF_FETCHED}: "Storage $0.015 / GB-month", "10 GB-month / month" free; "a GB-month is determined by averaging the peak storage per day over a billing period". The meter row is the day's peak decimal GB; the estimator prorates by days in the month.`,
  }),
  cloudflareRule({
    serviceId: 'cloudflare.workers',
    usageMetricId: 'cloudflare.workers/requests',
    billingSkuId: 'workers.requests',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    freeAllowance: { quantity: 100_000, unit: 'request', period: 'DAY', scope: 'SERVICE' },
    sourceReference: `${CF_FETCHED}: Workers Free plan "100,000 requests per day", "10 milliseconds of CPU time per invocation" — a hard cap on the Free plan, not a price. Paid plan would be $5/month, 10M requests included, then $0.30 per million; CPU 30M ms included, then $0.02 per million ms.`,
  }),
];

/**
 * COST-BE-025 (#384) — Upstash Redis, from the pricing page fetched
 * 2026-09-03 (`upstash.com/pricing/redis`). One billed meter, service-level
 * (no operation): `commands`, pay-as-you-go "$0.2 per 100K commands" with the
 * Free tier's "500K" commands per month recorded as the allowance.
 *
 * Issue #384 and epic §41-P2 quote the older Free tier (10k commands per
 * day, scope DAILY). The page no longer lists a daily figure — the cap the
 * console's "ERR max daily request limit exceeded" refers to is unpublished —
 * so the monthly allowance the page states is what is recorded; a verified
 * daily cap becomes a new rule version, not an edit of this one.
 *
 * Storage ("$0.25 per GB", first 1 GB free) and bandwidth ("$0.03/GB" beyond
 * 200 GB/month) are deliberately unpriced: the meters are bytes and
 * non-billable until a GB rule with an explicit conversion exists.
 */
const UPSTASH_FETCHED =
  'Upstash Redis pricing page, fetched 2026-09-03 (upstash.com/pricing/redis)';
const UPSTASH_VERSION = 'upstash-2026-09-03-v1';
const NEON_FETCHED = 'Neon pricing page, fetched 2026-09-03 (neon.com/pricing)';
const NEON_VERSION = 'neon-2026-09-03-v1';
const GITHUB_FETCHED =
  'GitHub Actions billing page, fetched 2026-09-03 (docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions)';
const GITHUB_VERSION = 'github-2026-09-03-v1';

const UPSTASH_RULES: readonly PricingRule[] = [
  {
    id: 'upstash-redis.commands-2026-09-01-v1',
    providerId: 'upstash',
    serviceId: 'upstash.redis',
    operationId: null,
    usageMetricId: 'upstash.redis/commands',
    billingSkuId: 'redis.commands',
    region: null,
    platform: null,
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
    currency: 'USD',
    // $0.2 per 100K = $0.002 per 1,000 commands = 2,000 micros.
    pricingModel: 'PER_1K_REQUESTS',
    unitPriceMicros: 2_000,
    tiers: null,
    freeAllowance: { quantity: 500_000, unit: 'command', period: 'MONTH', scope: 'SKU' },
    version: UPSTASH_VERSION,
    sourceReference: `${UPSTASH_FETCHED}: pay-as-you-go "$0.2 per 100K commands"; Free tier "500K" commands per month, "256 MB" data, "10 GB" bandwidth per month; "Operational commands like AUTH, HELLO, SELECT, COMMAND, CONFIG, INFO, PING, RESET, and QUIT are not charged." The meter is the day's request total from the Developer API, so this is a ceiling on the billable count. Issue #384's "10k commands/day" is the pre-2024 Free tier and is not on the page.`,
    reviewedAt: '2026-09-03',
  },
  /**
   * Neon (#385) — the plan `gogo-dev` is on is **Free**, so what is in force
   * is a cap, not a price (pricing page fetched 2026-09-03, neon.com/pricing):
   * "100 CU-hours/project", "0.5 GB/project" storage, "5 GB per project per
   * month" public network transfer. The usage-based list prices the issue
   * asks to record are in `sourceReference` and become the v2 rules the day
   * the plan changes: Launch "$0.106/CU-hour" (106,000 micros, PER_OPERATION
   * per compute_hour), "$0.35/GB-month" storage (350,000 micros PER_GB_MONTH),
   * "$0.10/GB" transfer beyond "500 GB per project included" (100,000 micros
   * PER_GB); Scale compute "$0.222/CU-hour". Written data has no price line.
   * Allowances are per project (scope PROJECT), reset monthly.
   */
  {
    id: 'neon-postgres.compute-2026-09-01-v1',
    providerId: 'neon',
    serviceId: 'neon.postgres',
    operationId: null,
    usageMetricId: 'neon.postgres/compute_hours',
    billingSkuId: 'postgres.compute',
    region: null,
    platform: null,
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
    currency: 'USD',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    tiers: null,
    freeAllowance: { quantity: 100, unit: 'compute_hour', period: 'MONTH', scope: 'PROJECT' },
    version: NEON_VERSION,
    sourceReference: `${NEON_FETCHED}: Free plan "100 CU-hours/project" per month, "compute size × hours running = CU-hours"; Launch "$0.106/CU-hour", Scale "$0.222/CU-hour" list. The meter is round(compute_time_seconds / 3600) per day (history) or the floor-telescoped period-to-date delta (project snapshot). Free plan never bills — it suspends at the cap.`,
    reviewedAt: '2026-09-03',
  },
  {
    id: 'neon-postgres.storage-2026-09-01-v1',
    providerId: 'neon',
    serviceId: 'neon.postgres',
    operationId: null,
    usageMetricId: 'neon.postgres/storage_gb_month',
    billingSkuId: 'postgres.storage',
    region: null,
    platform: null,
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
    currency: 'USD',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    tiers: null,
    freeAllowance: { quantity: 0.5, unit: 'gb_month', period: 'MONTH', scope: 'PROJECT' },
    version: NEON_VERSION,
    sourceReference: `${NEON_FETCHED}: Free plan "0.5 GB/project"; Launch and Scale "$0.35/GB-month" list, "1 GB-month = 1 GB stored for 1 month", "metered hourly and summed over the month". The meter row is the day's peak decimal GB of synthetic_storage_size, ceil — a whole-GB row on a 0.5 GB cap reads 1; the exact bytes are the storage_bytes meter.`,
    reviewedAt: '2026-09-03',
  },
  {
    id: 'neon-postgres.data_transfer-2026-09-01-v1',
    providerId: 'neon',
    serviceId: 'neon.postgres',
    operationId: null,
    usageMetricId: 'neon.postgres/data_transfer_gb',
    billingSkuId: 'postgres.data_transfer',
    region: null,
    platform: null,
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
    currency: 'USD',
    pricingModel: 'FREE',
    unitPriceMicros: 0,
    tiers: null,
    freeAllowance: { quantity: 5, unit: 'gb', period: 'MONTH', scope: 'PROJECT' },
    version: NEON_VERSION,
    sourceReference: `${NEON_FETCHED}: Free plan "5 GB per project per month" public network transfer; Launch and Scale "500 GB per project included" then "$0.10/GB" list. The meter is the period-to-date data_transfer_bytes delta from the project endpoint (the history endpoint does not list transfer).`,
    reviewedAt: '2026-09-03',
  },
  /**
   * GitHub Actions (#386). GoGo's five repositories are **private**, so their
   * minutes are billed; public-repository minutes are free and never appear.
   * The page fetched 2026-09-03 prices standard runners per minute by OS —
   * Linux 2-core $0.006, Windows 2-core $0.010, macOS 3/4-core $0.062 — and
   * gives the Free plan "2,000" included minutes a month across the account.
   *
   * One rule, priced at the Linux 2-core rate, because the meter is minutes
   * and CI runs on `ubuntu-latest`; the per-SKU split of every row is in its
   * `metadata.skus`, so a Windows or macOS job is visible rather than hidden
   * behind a blended number. Should another OS become routine, the honest fix
   * is a per-SKU meter and a rule each, not an averaged price here.
   *
   * **Deviation from the issue text:** #386 says "$0.008/phút Linux". The
   * page says $0.006 and publishes no $0.008 rate; the page's figure is what
   * is recorded. The allowance matches the issue at 2,000 minutes a month,
   * scope ACCOUNT.
   *
   * The estimate is a ceiling on what is actually charged: GitHub applies the
   * included minutes itself, and the ACTUAL row from `netAmount` (same
   * collector) is what the Cost Center shows when both exist (epic §12).
   */
  {
    id: 'github-actions.minutes-2026-09-01-v1',
    providerId: 'github',
    serviceId: 'github.actions',
    operationId: null,
    usageMetricId: 'github.actions/minutes',
    billingSkuId: 'actions.minutes',
    region: null,
    platform: null,
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
    currency: 'USD',
    pricingModel: 'PER_OPERATION',
    unitPriceMicros: 6_000,
    tiers: null,
    freeAllowance: { quantity: 2_000, unit: 'minute', period: 'MONTH', scope: 'ACCOUNT' },
    version: GITHUB_VERSION,
    sourceReference: `${GITHUB_FETCHED}: "GitHub Free" includes "2,000" minutes/month for private repositories; standard runners "Linux 2-core (x64) $0.006", "Windows 2-core (x64) $0.010", "macOS 3-core or 4-core $0.062" per minute; "The use of standard GitHub-hosted runners is free: In public repositories". Priced at the Linux rate — CI runs on ubuntu-latest and the meter is minutes; per-SKU quantities are on each row's metadata. Issue #386's "$0.008/phút Linux" is not on the page.`,
    reviewedAt: '2026-09-03',
  },
];

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
    usageMetricId: 'google.expand/calls',
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
    usageMetricId: 'google.sheets.meta/calls',
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
    usageMetricId: 'google.sheets.values/calls',
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
  ...CLOUDFLARE_RULES,
  ...UPSTASH_RULES,
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
