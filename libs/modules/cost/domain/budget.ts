/**
 * COST-BE-020 (#379) — epic §12 (source precedence), §32 (budget engine),
 * §33 (forecast). Pure: rows in, numbers out. Nothing here knows a provider
 * by name; scopes are registry ids and the rows say whose they are.
 */

export type CostBasis = 'ACTUAL' | 'ESTIMATED' | 'FIXED' | 'MANUAL';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

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
  /** ESTIMATED rows that were shadowed by an ACTUAL row for the same key — the reconciliation input, never added. */
  shadowedEstimatedMicros: number;
  currency: string | null;
  /** More than one currency in scope — the number cannot be summed honestly. */
  mixedCurrency: boolean;
};

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
  let shadowed = 0;
  const currencies = new Set<string>();
  const usageGroups = new Map<string, CostRow[]>();
  for (const r of rows) {
    currencies.add(r.currency);
    if (r.basis === 'FIXED' || r.basis === 'MANUAL') {
      byBasis[r.basis] += r.amountMicros;
      continue;
    }
    const k = spendKey(r);
    const g = usageGroups.get(k);
    if (g) g.push(r);
    else usageGroups.set(k, [r]);
  }
  for (const group of usageGroups.values()) {
    const actual = group.filter((r) => r.basis === 'ACTUAL');
    const estimated = group.filter((r) => r.basis === 'ESTIMATED');
    const pick = (candidates: CostRow[]) =>
      [...candidates].sort(
        (a, b) =>
          CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
          a.source.localeCompare(b.source),
      )[0]!;
    if (actual.length > 0) {
      byBasis.ACTUAL += pick(actual).amountMicros;
      if (estimated.length > 0) shadowed += pick(estimated).amountMicros;
    } else if (estimated.length > 0) {
      byBasis.ESTIMATED += pick(estimated).amountMicros;
    }
  }
  return {
    micros: byBasis.ACTUAL + byBasis.ESTIMATED + byBasis.FIXED + byBasis.MANUAL,
    byBasis,
    shadowedEstimatedMicros: shadowed,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    mixedCurrency: currencies.size > 1,
  };
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
 * Epic §33: MTD daily average × days in the billing month. `null` — not 0 —
 * when there is nothing to average: fewer than three elapsed days, or no
 * spend rows at all. No smoothing, no ML.
 */
export function forecastMonthMicros(
  mtdMicros: number,
  month: string,
  today: string,
  hasRows: boolean,
): number | null {
  const elapsed = elapsedDays(month, today);
  if (!hasRows || elapsed < FORECAST_MIN_ELAPSED_DAYS) return null;
  return Math.ceil((mtdMicros / elapsed) * daysInMonth(month));
}

export type CostBudgetState = 'ok' | 'warning' | 'exceeded' | 'projected_exceed';

export type CostBudgetStatus = {
  scope: CostBudgetScope;
  monthMicros: number;
  usedMicros: number;
  remainingMicros: number;
  /** 0..∞, two decimals. */
  usedPct: number;
  projectedMicros: number | null;
  projectedPct: number | null;
  state: CostBudgetState;
  currency: string;
};

export const WARNING_PCT = 80;

export function costBudgetStatus(
  scope: CostBudgetScope,
  monthMicros: number,
  currency: string,
  used: SpendBreakdown,
  projectedMicros: number | null,
): CostBudgetStatus {
  const usedMicros = used.micros;
  const usedPct =
    monthMicros === 0 ? (usedMicros > 0 ? Infinity : 0) : round2((usedMicros / monthMicros) * 100);
  const projectedPct =
    projectedMicros === null
      ? null
      : monthMicros === 0
        ? projectedMicros > 0
          ? Infinity
          : 0
        : round2((projectedMicros / monthMicros) * 100);
  let state: CostBudgetState = 'ok';
  if (usedMicros > monthMicros) state = 'exceeded';
  else if (projectedMicros !== null && projectedMicros > monthMicros) state = 'projected_exceed';
  else if (usedPct >= WARNING_PCT) state = 'warning';
  return {
    scope,
    monthMicros,
    usedMicros,
    remainingMicros: Math.max(0, monthMicros - usedMicros),
    usedPct,
    projectedMicros,
    projectedPct,
    state,
    currency,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
