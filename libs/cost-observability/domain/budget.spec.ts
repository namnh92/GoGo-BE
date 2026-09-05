import { describe, expect, it } from 'vitest';
import {
  costBudgetStatus,
  daysInMonth,
  elapsedDays,
  inScope,
  spend,
  usageProjectionMicros,
  winningRows,
  type CostRow,
  type SpendBreakdown,
} from './budget';

const row = (over: Partial<CostRow>): CostRow => ({
  day: '2026-09-02',
  providerId: 'google',
  serviceId: 'google.places',
  operationId: 'google.details.quality',
  usageMetricId: 'requests',
  billingSkuId: 'places.details.enterprise',
  amountMicros: 0,
  currency: 'USD',
  basis: 'ESTIMATED',
  confidence: 'MEDIUM',
  source: 'estimator',
  costKind: 'USAGE',
  billingCadence: null,
  periodAmountMicros: null,
  ...over,
});

const fixed = (over: Partial<CostRow> = {}): CostRow =>
  row({
    providerId: 'gogo',
    serviceId: 'gogo.cost_observability',
    operationId: null,
    usageMetricId: null,
    billingSkuId: null,
    basis: 'FIXED',
    confidence: 'HIGH',
    source: 'monitoring_cost_model',
    costKind: 'RECURRING',
    billingCadence: 'MONTHLY',
    periodAmountMicros: 300,
    ...over,
  });

const manual = (over: Partial<CostRow> = {}): CostRow =>
  row({
    providerId: 'apple',
    serviceId: 'apple.developer_program',
    operationId: null,
    usageMetricId: null,
    billingSkuId: null,
    basis: 'MANUAL',
    confidence: 'HIGH',
    source: 'manual_cost_items:x',
    costKind: 'ONE_TIME',
    ...over,
  });

describe('spend — precedence (epic §12)', () => {
  it('takes ACTUAL over ESTIMATED for the same spend and never adds them', () => {
    const s = spend([
      row({ amountMicros: 8_200_000, basis: 'ESTIMATED' }),
      row({
        amountMicros: 8_310_000,
        basis: 'ACTUAL',
        confidence: 'HIGH',
        source: 'gcp_billing_export',
      }),
    ]);
    expect(s.micros).toBe(8_310_000);
    expect(s.byBasis).toEqual({ ACTUAL: 8_310_000, ESTIMATED: 0, FIXED: 0, MANUAL: 0 });
    expect(s.byKind).toEqual({ USAGE: 8_310_000, RECURRING: 0, ONE_TIME: 0 });
    expect(s.shadowedEstimatedMicros).toBe(8_200_000);
  });

  it('takes the most confident of several estimates for one spend — two views, not two costs', () => {
    const s = spend([
      row({
        amountMicros: 100,
        basis: 'ESTIMATED',
        confidence: 'LOW',
        source: 'prometheus_backfill',
      }),
      row({ amountMicros: 90, basis: 'ESTIMATED', confidence: 'MEDIUM', source: 'estimator' }),
    ]);
    expect(s.micros).toBe(90);
  });

  it('counts FIXED and MANUAL rows as separate costs, alongside usage, and splits them by kind', () => {
    const s = spend([
      row({ amountMicros: 50 }),
      fixed({ amountMicros: 10 }),
      manual({ amountMicros: 270 }),
    ]);
    expect(s.micros).toBe(330);
    expect(s.byBasis).toEqual({ ACTUAL: 0, ESTIMATED: 50, FIXED: 10, MANUAL: 270 });
    // The same 330, by how it is billed (ADR-0015) — the split a forecast reads.
    expect(s.byKind).toEqual({ USAGE: 50, RECURRING: 10, ONE_TIME: 270 });
  });

  it('keeps different days and different meters apart', () => {
    const s = spend([
      row({ day: '2026-09-01', amountMicros: 1 }),
      row({ day: '2026-09-02', amountMicros: 2 }),
      row({ day: '2026-09-02', billingSkuId: 'places.details.pro', amountMicros: 4 }),
    ]);
    expect(s.micros).toBe(7);
  });

  it('flags mixed currencies instead of summing them', () => {
    const s = spend([
      row({ amountMicros: 1 }),
      row({ amountMicros: 1, currency: 'VND', day: '2026-09-03' }),
    ]);
    expect(s.mixedCurrency).toBe(true);
    expect(s.currency).toBeNull();
  });
});

describe('scope', () => {
  it('TOTAL includes everything; PROVIDER and SERVICE filter by registry id', () => {
    const r = row({});
    expect(inScope(r, { kind: 'TOTAL', id: null })).toBe(true);
    expect(inScope(r, { kind: 'PROVIDER', id: 'google' })).toBe(true);
    expect(inScope(r, { kind: 'PROVIDER', id: 'upstash' })).toBe(false);
    expect(inScope(r, { kind: 'SERVICE', id: 'google.places' })).toBe(true);
    expect(inScope(r, { kind: 'SERVICE', id: 'google.routes' })).toBe(false);
  });
});

describe('usage projection (epic §33 as amended by ADR-0015)', () => {
  it('is the USAGE month-to-date daily average × days in month', () => {
    // $3 of usage over 10 elapsed days of September (30 days) → $9.
    expect(usageProjectionMicros(3_000_000, '2026-09', '2026-09-10', true)).toBe(9_000_000);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(elapsedDays('2026-09', '2026-09-10')).toBe(10);
    expect(elapsedDays('2026-08', '2026-09-10')).toBe(31);
    expect(elapsedDays('2026-10', '2026-09-10')).toBe(0);
  });

  it('is null — never 0 — with fewer than three elapsed days or no usage rows', () => {
    expect(usageProjectionMicros(1, '2026-09', '2026-09-02', true)).toBeNull();
    expect(usageProjectionMicros(0, '2026-09', '2026-09-20', false)).toBeNull();
    expect(usageProjectionMicros(0, '2026-09', '2026-09-20', true)).toBe(0);
  });
});

describe('costBudgetStatus (epic §32)', () => {
  const used = (micros: number): SpendBreakdown => ({
    micros,
    byBasis: { ACTUAL: 0, ESTIMATED: micros, FIXED: 0, MANUAL: 0 },
    byKind: { USAGE: micros, RECURRING: 0, ONE_TIME: 0 },
    shadowedEstimatedMicros: 0,
    currency: 'USD',
    mixedCurrency: false,
  });
  const projection = (
    cashMicros: number | null,
    cashFloorMicros = 0,
    runRateMicros = cashMicros,
  ) => ({
    cashMicros,
    cashFloorMicros,
    runRateMicros,
  });
  const scope = { kind: 'TOTAL' as const, id: null };

  it('reports ok / warning / projected_exceed / exceeded against the cash forecast', () => {
    expect(
      costBudgetStatus(scope, 50_000_000, 'USD', used(10_000_000), projection(30_000_000)),
    ).toMatchObject({
      state: 'ok',
      usedPct: 20,
      remainingMicros: 40_000_000,
      projectedMicros: 30_000_000,
      projectedPct: 60,
      runRateMicros: 30_000_000,
    });
    expect(
      costBudgetStatus(scope, 50_000_000, 'USD', used(41_000_000), projection(45_000_000)).state,
    ).toBe('warning');
    expect(
      costBudgetStatus(scope, 50_000_000, 'USD', used(10_000_000), projection(60_000_000)).state,
    ).toBe('projected_exceed');
    expect(
      costBudgetStatus(scope, 50_000_000, 'USD', used(51_000_000), projection(null)),
    ).toMatchObject({
      state: 'exceeded',
      remainingMicros: 0,
      projectedMicros: null,
      projectedPct: null,
    });
  });

  it('a known floor above the budget is a projected exceedance even before usage can be projected', () => {
    // Usage cannot be projected yet (null), but $60 of subscriptions and
    // one-offs are already committed for the month against a $50 budget.
    const s = costBudgetStatus(
      scope,
      50_000_000,
      'USD',
      used(5_000_000),
      projection(null, 60_000_000, null),
    );
    expect(s.state).toBe('projected_exceed');
    expect(s.projectedMicros).toBeNull();
    expect(s.projectedFloorMicros).toBe(60_000_000);
  });

  it('handles a zero budget without dividing by zero', () => {
    expect(costBudgetStatus(scope, 0, 'USD', used(0), projection(null)).usedPct).toBe(0);
    expect(costBudgetStatus(scope, 0, 'USD', used(1), projection(null)).state).toBe('exceeded');
  });
});

describe('winningRows — the rows spend() counts (#381)', () => {
  it('returns the ACTUAL winner, drops the shadowed estimate, keeps every FIXED/MANUAL row', () => {
    const rows = [
      row({ amountMicros: 8_200_000 }),
      row({
        amountMicros: 8_310_000,
        basis: 'ACTUAL',
        confidence: 'HIGH',
        source: 'gcp_billing_export',
      }),
      row({ day: '2026-09-03', amountMicros: 1_000_000 }),
      fixed({ amountMicros: 10_000 }),
      fixed({ amountMicros: 10_000, source: 'another_model' }),
    ];
    const winners = winningRows(rows);
    expect(winners.map((r) => [r.basis, r.amountMicros])).toEqual([
      ['FIXED', 10_000],
      ['FIXED', 10_000],
      ['ACTUAL', 8_310_000],
      ['ESTIMATED', 1_000_000],
    ]);
    // The same rows, the same total: winningRows is spend()'s selection, not a second rule.
    expect(winners.reduce((n, r) => n + r.amountMicros, 0)).toBe(spend(rows).micros);
  });

  it('among several rows of one basis takes the most confident, then the first source by name', () => {
    const winners = winningRows([
      row({ amountMicros: 1, confidence: 'LOW', source: 'b' }),
      row({ amountMicros: 2, confidence: 'MEDIUM', source: 'z' }),
      row({ amountMicros: 3, confidence: 'MEDIUM', source: 'a' }),
    ]);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ amountMicros: 3, source: 'a' });
  });
});
