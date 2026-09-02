import { describe, expect, it } from 'vitest';
import {
  costBudgetStatus,
  daysInMonth,
  elapsedDays,
  forecastMonthMicros,
  inScope,
  spend,
  type CostRow,
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

  it('counts FIXED and MANUAL rows as separate costs, alongside usage', () => {
    const s = spend([
      row({ amountMicros: 50 }),
      row({
        providerId: 'gogo',
        serviceId: 'gogo.cost_observability',
        operationId: null,
        usageMetricId: null,
        billingSkuId: null,
        amountMicros: 10,
        basis: 'FIXED',
        confidence: 'HIGH',
        source: 'monitoring_cost_model',
      }),
      row({
        providerId: 'apple',
        serviceId: 'apple.developer_program',
        operationId: null,
        usageMetricId: null,
        billingSkuId: null,
        amountMicros: 270,
        basis: 'MANUAL',
        confidence: 'HIGH',
        source: 'manual_cost_items',
      }),
    ]);
    expect(s.micros).toBe(330);
    expect(s.byBasis).toEqual({ ACTUAL: 0, ESTIMATED: 50, FIXED: 10, MANUAL: 270 });
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

describe('forecast (epic §33)', () => {
  it('is MTD daily average × days in month', () => {
    // $3 over 10 elapsed days of September (30 days) → $9.
    expect(forecastMonthMicros(3_000_000, '2026-09', '2026-09-10', true)).toBe(9_000_000);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(elapsedDays('2026-09', '2026-09-10')).toBe(10);
    expect(elapsedDays('2026-08', '2026-09-10')).toBe(31);
    expect(elapsedDays('2026-10', '2026-09-10')).toBe(0);
  });

  it('is null — never 0 — with fewer than three elapsed days or no rows', () => {
    expect(forecastMonthMicros(1, '2026-09', '2026-09-02', true)).toBeNull();
    expect(forecastMonthMicros(0, '2026-09', '2026-09-20', false)).toBeNull();
    expect(forecastMonthMicros(0, '2026-09', '2026-09-20', true)).toBe(0);
  });
});

describe('costBudgetStatus (epic §32)', () => {
  const used = (micros: number) => ({
    micros,
    byBasis: { ACTUAL: 0, ESTIMATED: micros, FIXED: 0, MANUAL: 0 },
    shadowedEstimatedMicros: 0,
    currency: 'USD',
    mixedCurrency: false,
  });

  it('reports ok / warning / projected_exceed / exceeded', () => {
    const scope = { kind: 'TOTAL' as const, id: null };
    expect(costBudgetStatus(scope, 50_000_000, 'USD', used(10_000_000), 30_000_000)).toMatchObject({
      state: 'ok',
      usedPct: 20,
      remainingMicros: 40_000_000,
      projectedPct: 60,
    });
    expect(costBudgetStatus(scope, 50_000_000, 'USD', used(41_000_000), 45_000_000).state).toBe(
      'warning',
    );
    expect(costBudgetStatus(scope, 50_000_000, 'USD', used(10_000_000), 60_000_000).state).toBe(
      'projected_exceed',
    );
    expect(costBudgetStatus(scope, 50_000_000, 'USD', used(51_000_000), null)).toMatchObject({
      state: 'exceeded',
      remainingMicros: 0,
      projectedPct: null,
    });
  });

  it('handles a zero budget without dividing by zero', () => {
    expect(costBudgetStatus({ kind: 'TOTAL', id: null }, 0, 'USD', used(0), null).usedPct).toBe(0);
    expect(costBudgetStatus({ kind: 'TOTAL', id: null }, 0, 'USD', used(1), null).state).toBe(
      'exceeded',
    );
  });
});
