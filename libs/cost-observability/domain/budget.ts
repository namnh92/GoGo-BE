/**
 * COST-BE-020 (#379) — epic §12 (source precedence), §32 (budget engine),
 * §33 (forecast, as amended by COST-BE-034 / ADR-0015). Pure: rows in,
 * numbers out. Nothing here knows a provider by name; scopes are registry
 * ids and the rows say whose they are.
 */

export type CostBasis = 'ACTUAL' | 'ESTIMATED' | 'FIXED' | 'MANUAL';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * COST-BE-034 (#415, ADR-0015) — what kind of charge a row is. `basis` says
 * how the number is known (an invoice, an estimate, a model, a hand-typed
 * fee); `costKind` says how it is billed, which is what a forecast needs:
 *
 * - `USAGE`: usage × price. The only kind that may be extrapolated from the
 *   part of the period that has elapsed.
 * - `RECURRING`: a subscription, billed every `billingCadence`. The period's
 *   full charge is `periodAmountMicros`; what is still to come is read from
 *   that, never from a daily average.
 * - `ONE_TIME`: paid once. Counted once in the month it lands, never a
 *   run-rate input.
 */
export const COST_KINDS = ['USAGE', 'RECURRING', 'ONE_TIME'] as const;
export type CostKind = (typeof COST_KINDS)[number];

export const BILLING_CADENCES = ['MONTHLY', 'ANNUAL'] as const;
export type BillingCadence = (typeof BILLING_CADENCES)[number];

/** One `provider_cost_daily` row, as the engine needs it. */
export type CostRow = {
  day: string;
  providerId: string;
  serviceId: string;
  operationId: string | null;
  usageMetricId: string | null;
  billingSkuId: string | null;
  amountMicros: number;
  currency: string;
  basis: CostBasis;
  confidence: Confidence;
  source: string;
  costKind: CostKind;
  /** Present exactly when `costKind` is RECURRING. */
  billingCadence: BillingCadence | null;
  /** The full charge of the period a RECURRING row belongs to; `null` otherwise. */
  periodAmountMicros: number | null;
};

export type CostBudgetScope =
  { kind: 'TOTAL'; id: null } | { kind: 'PROVIDER'; id: string } | { kind: 'SERVICE'; id: string };

export function inScope(
  row: Pick<CostRow, 'providerId' | 'serviceId'>,
  scope: CostBudgetScope,
): boolean {
  switch (scope.kind) {
    case 'TOTAL':
      return true;
    case 'PROVIDER':
      return row.providerId === scope.id;
    case 'SERVICE':
      return row.serviceId === scope.id;
  }
}

const CONFIDENCE_RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

const spendKey = (r: CostRow) =>
  `${r.day}|${r.providerId}|${r.serviceId}|${r.operationId ?? ''}|${r.usageMetricId ?? ''}|${r.billingSkuId ?? ''}`;

export type SpendBreakdown = {
  /** Micros after precedence: the one number to report as spend. */
  micros: number;
  /** What the number is made of. Sums to `micros`. */
  byBasis: Record<CostBasis, number>;
  /** The same number split by how it is billed. Sums to `micros`. */
  byKind: Record<CostKind, number>;
  /** ESTIMATED rows that were shadowed by an ACTUAL row for the same key — the reconciliation input, never added. */
  shadowedEstimatedMicros: number;
  currency: string | null;
  /** More than one currency in scope — the number cannot be summed honestly. */
  mixedCurrency: boolean;
};

export const emptyByKind = (): Record<CostKind, number> => ({
  USAGE: 0,
  RECURRING: 0,
  ONE_TIME: 0,
});

/**
 * Epic §12: for the SAME underlying spend (same day and meter key), ACTUAL
 * beats ESTIMATED and the two are never added. Among several rows of the
 * winning basis, the most confident one is taken (ties: source name order),
 * because two estimates of one thing are two views, not two costs.
 *
 * FIXED and MANUAL rows are separate costs (a subscription is not a usage
 * estimate of anything) and are each counted once per (day, key, source).
 */
export function spend(rows: readonly CostRow[]): SpendBreakdown {
  const byBasis: Record<CostBasis, number> = { ACTUAL: 0, ESTIMATED: 0, FIXED: 0, MANUAL: 0 };
  const byKind = emptyByKind();
  let shadowed = 0;
  const currencies = new Set<string>();
  for (const r of rows) currencies.add(r.currency);
  for (const r of winningRows(rows)) {
    byBasis[r.basis] += r.amountMicros;
    byKind[r.costKind] += r.amountMicros;
  }
  for (const r of shadowedRows(rows)) shadowed += r.amountMicros;
  return {
    micros: byBasis.ACTUAL + byBasis.ESTIMATED + byBasis.FIXED + byBasis.MANUAL,
    byBasis,
    byKind,
    shadowedEstimatedMicros: shadowed,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    mixedCurrency: currencies.size > 1,
  };
}

const pick = (candidates: readonly CostRow[]) =>
  [...candidates].sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      a.source.localeCompare(b.source),
  )[0]!;

function usageGroups(rows: readonly CostRow[]): { fixed: CostRow[]; groups: CostRow[][] } {
  const fixed: CostRow[] = [];
  const groups = new Map<string, CostRow[]>();
  for (const r of rows) {
    if (r.basis === 'FIXED' || r.basis === 'MANUAL') {
      fixed.push(r);
      continue;
    }
    const k = spendKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return { fixed, groups: [...groups.values()] };
}

/**
 * #381 — the rows `spend()` counts, for callers that need to say *which*
 * basis and confidence a number came from rather than only the number. Same
 * precedence, same tie-break: one winner per usage key, every FIXED/MANUAL
 * row. A shadowed estimate is not here; `spend().shadowedEstimatedMicros`
 * reports it.
 */
export function winningRows(rows: readonly CostRow[]): CostRow[] {
  const { fixed, groups } = usageGroups(rows);
  const out: CostRow[] = [...fixed];
  for (const group of groups) {
    const actual = group.filter((r) => r.basis === 'ACTUAL');
    const estimated = group.filter((r) => r.basis === 'ESTIMATED');
    if (actual.length > 0) out.push(pick(actual));
    else if (estimated.length > 0) out.push(pick(estimated));
  }
  return out;
}

/** The best estimate per key that an ACTUAL row displaced. */
function shadowedRows(rows: readonly CostRow[]): CostRow[] {
  const out: CostRow[] = [];
  for (const group of usageGroups(rows).groups) {
    const actual = group.some((r) => r.basis === 'ACTUAL');
    const estimated = group.filter((r) => r.basis === 'ESTIMATED');
    if (actual && estimated.length > 0) out.push(pick(estimated));
  }
  return out;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Days of `month` elapsed up to and including `today` (UTC day). 0 when `today` is before the month. */
export function elapsedDays(month: string, today: string): number {
  if (!today.startsWith(month)) return today > month ? daysInMonth(month) : 0;
  return Number(today.slice(8, 10));
}

export const FORECAST_MIN_ELAPSED_DAYS = 3;

/**
 * Epic §33 as amended (ADR-0015): the **usage** month-to-date daily average
 * × days in the billing month. Only USAGE spend goes in here — a
 * subscription or a one-off fee is never "so far this month" divided by the
 * days behind us. `null` — not 0 — when there is nothing to average: fewer
 * than three elapsed days, or no usage rows at all. No smoothing, no ML.
 */
export function usageProjectionMicros(
  usageMtdMicros: number,
  month: string,
  today: string,
  hasUsageRows: boolean,
): number | null {
  const elapsed = elapsedDays(month, today);
  if (!hasUsageRows || elapsed < FORECAST_MIN_ELAPSED_DAYS) return null;
  return Math.ceil((usageMtdMicros / elapsed) * daysInMonth(month));
}

export type CostBudgetState = 'ok' | 'warning' | 'exceeded' | 'projected_exceed';

/** What the budget engine needs from a scope's forecast (see `domain/forecast.ts`). */
export type ScopeProjection = {
  /** End-of-month cash forecast; `null` when the usage component cannot be projected yet. */
  cashMicros: number | null;
  /** The part of the cash forecast that is already known: recurring + one-time charges of the month. */
  cashFloorMicros: number;
  /** Normalised monthly run-rate; `null` under the same condition as `cashMicros`. */
  runRateMicros: number | null;
};

export type CostBudgetStatus = {
  scope: CostBudgetScope;
  monthMicros: number;
  usedMicros: number;
  remainingMicros: number;
  /** 0..∞, two decimals. */
  usedPct: number;
  /** End-of-month cash forecast for the scope (ADR-0015); `null` under the usage minimum. */
  projectedMicros: number | null;
  projectedPct: number | null;
  /** Recurring + one-time charges already known for the month — a floor under `projectedMicros`. */
  projectedFloorMicros: number;
  /** Normalised monthly run-rate for the scope; annual fees ÷ 12, one-offs excluded. */
  runRateMicros: number | null;
  state: CostBudgetState;
  currency: string;
};

export const WARNING_PCT = 80;

export function costBudgetStatus(
  scope: CostBudgetScope,
  monthMicros: number,
  currency: string,
  used: SpendBreakdown,
  projection: ScopeProjection,
): CostBudgetStatus {
  const usedMicros = used.micros;
  const pct = (n: number): number =>
    monthMicros === 0 ? (n > 0 ? Infinity : 0) : round2((n / monthMicros) * 100);
  const projectedMicros = projection.cashMicros;
  const projectedPct = projectedMicros === null ? null : pct(projectedMicros);
  // A floor that already exceeds the budget is an exceedance whether or not
  // the usage half can be projected yet.
  const heading = projectedMicros ?? projection.cashFloorMicros;
  let state: CostBudgetState = 'ok';
  if (usedMicros > monthMicros) state = 'exceeded';
  else if (heading > monthMicros) state = 'projected_exceed';
  else if (pct(usedMicros) >= WARNING_PCT) state = 'warning';
  return {
    scope,
    monthMicros,
    usedMicros,
    remainingMicros: Math.max(0, monthMicros - usedMicros),
    usedPct: pct(usedMicros),
    projectedMicros,
    projectedPct,
    projectedFloorMicros: projection.cashFloorMicros,
    runRateMicros: projection.runRateMicros,
    state,
    currency,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
