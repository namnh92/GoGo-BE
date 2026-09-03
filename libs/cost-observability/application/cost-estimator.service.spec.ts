import { describe, expect, it } from 'vitest';
import { PRICING_RULES, type PricingRule } from '../pricing/pricing-rules';
import {
  allowanceWalkStart,
  defaultRecomputeRange,
  planEstimates,
  type MeterUsageRow,
} from './cost-estimator.service';
import { meterRowsFor } from './usage-ledger';

const usage = (over: Partial<MeterUsageRow>): MeterUsageRow => ({
  day: '2026-09-02',
  providerId: 'google',
  serviceId: 'google.places',
  operationId: 'google.details.quality',
  usageMetricId: 'requests',
  billingSkuId: 'places.details.enterprise',
  quantity: 0,
  unit: 'request',
  source: 'ledger',
  ...over,
});

const RANGE = { from: '2026-09-01', to: '2026-09-30' };

describe('planEstimates — pricing usage meters (epic §11, §13, §15)', () => {
  it('prices a billable meter at the rule in force and labels the version', () => {
    const plan = planEstimates([usage({ quantity: 250 })], RANGE);
    // 1,000 free Enterprise Details per month; 250 is inside the allowance.
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      billingSkuId: 'places.details.enterprise',
      billableQuantity: 250,
      amountMicros: 0,
      currency: 'USD',
      pricingVersion: '2026-09-01',
      metadata: { listMicros: 5_000_000, allowancePriorQuantity: 0 },
    });
    expect(plan.unpriced).toEqual([]);
  });

  it('consumes the monthly allowance in date order, so charges start the day the cap is crossed', () => {
    const plan = planEstimates(
      [
        usage({ day: '2026-09-03', quantity: 200 }),
        usage({ day: '2026-09-01', quantity: 900 }),
        usage({ day: '2026-09-02', quantity: 0 }),
      ],
      RANGE,
    );
    const byDay = Object.fromEntries(plan.rows.map((r) => [r.day, r]));
    expect(byDay['2026-09-01']!.amountMicros).toBe(0);
    // 900 already used → 100 free, 100 billable at $20/1k = $2.00.
    expect(byDay['2026-09-03']!.amountMicros).toBe(2_000_000);
    expect(byDay['2026-09-03']!.metadata.allowancePriorQuantity).toBe(900);
    expect(byDay['2026-09-02']).toBeUndefined(); // zero quantity → no row
  });

  it('walks the allowance from the period start even when the range starts mid-month', () => {
    const plan = planEstimates(
      [usage({ day: '2026-09-01', quantity: 1_000 }), usage({ day: '2026-09-15', quantity: 100 })],
      { from: '2026-09-15', to: '2026-09-30' },
    );
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({ day: '2026-09-15', amountMicros: 2_000_000 });
    expect(allowanceWalkStart('2026-09-15')).toBe('2026-09-01');
  });

  it('writes no row for a SKU whose price is unknown, and names it', () => {
    const plan = planEstimates(
      [
        usage({
          serviceId: 'google.routes',
          operationId: 'google.routeMatrix',
          usageMetricId: 'billable_elements',
          billingSkuId: 'routes.computeRouteMatrix',
          unit: 'matrix_element',
          quantity: 50,
        }),
      ],
      RANGE,
    );
    expect(plan.rows).toEqual([]);
    expect(plan.unpriced).toEqual([
      { billingSkuId: 'routes.computeRouteMatrix', day: '2026-09-02' },
    ]);
  });

  it('writes no row for a SKU with no rule at all', () => {
    const plan = planEstimates([usage({ billingSkuId: 'vietmap.search', quantity: 5 })], RANGE);
    expect(plan.rows).toEqual([]);
    expect(plan.unpriced).toEqual([{ billingSkuId: 'vietmap.search', day: '2026-09-02' }]);
  });

  it('keeps two usage sources apart: each is priced as its own view of the month', () => {
    const plan = planEstimates(
      [
        usage({ quantity: 1_100, source: 'ledger' }),
        usage({ quantity: 1_100, source: 'prometheus_backfill' }),
      ],
      RANGE,
    );
    expect(plan.rows).toHaveLength(2);
    for (const row of plan.rows) expect(row.amountMicros).toBe(2_000_000);
  });

  it('prices a day with the rule in force on that day (epic §14)', () => {
    const rules: PricingRule[] = PRICING_RULES.map((r) =>
      r.billingSkuId === 'places.details.enterprise' ? { ...r, effectiveTo: '2026-10-01' } : r,
    );
    rules.push({
      ...rules.find((r) => r.billingSkuId === 'places.details.enterprise')!,
      id: 'google-places.details.enterprise-2026-10-01-v2',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      unitPriceMicros: 30_000_000,
      version: 'google-2026-10-01-v2',
      freeAllowance: null,
    });
    const plan = planEstimates(
      [usage({ day: '2026-09-20', quantity: 2_000 }), usage({ day: '2026-10-02', quantity: 100 })],
      { from: '2026-09-01', to: '2026-10-31' },
      rules,
      '2026-10-01',
    );
    const byDay = Object.fromEntries(plan.rows.map((r) => [r.day, r]));
    expect(byDay['2026-09-20']!.amountMicros).toBe(20_000_000); // 1,000 over cap at $20/1k
    expect(byDay['2026-10-02']!.amountMicros).toBe(3_000_000); // $30/1k, no cap
    expect(byDay['2026-10-02']!.metadata.ruleId).toBe(
      'google-places.details.enterprise-2026-10-01-v2',
    );
  });
});

describe('ledger → canonical meter rows (epic §9)', () => {
  it('splits a Places call into calls (not billed) and requests (billed under its SKU)', () => {
    const rows = meterRowsFor('2026-09-02', 'dev', 'google.details.quality', {
      attempted: 3,
      succeeded: 2,
      units: 2,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        metric: 'calls',
        quantity: 3,
        billingSkuId: null,
        unit: 'request',
      }),
      expect.objectContaining({
        metric: 'requests',
        quantity: 2,
        billingSkuId: 'places.details.enterprise',
        unit: 'request',
      }),
    ]);
  });

  it('splits a Routes call into calls and matrix elements — one call, N billable units', () => {
    const rows = meterRowsFor('2026-09-02', 'dev', 'google.routeMatrix', {
      attempted: 1,
      succeeded: 1,
      units: 14,
    });
    expect(rows.map((r) => [r.metric, r.quantity, r.unit, r.billingSkuId])).toEqual([
      ['calls', 1, 'request', null],
      ['billable_elements', 14, 'matrix_element', 'routes.computeRouteMatrix'],
    ]);
    expect(rows[0]!.serviceId).toBe('google.routes');
  });

  it('records a known-free operation as calls only', () => {
    const rows = meterRowsFor('2026-09-02', 'dev', 'google.expand', {
      attempted: 2,
      succeeded: 0,
      units: 0,
    });
    expect(rows.map((r) => r.metric)).toEqual(['calls']);
  });

  it('attributes an unregistered label by prefix rather than dropping it', () => {
    const rows = meterRowsFor('2026-09-02', 'dev', 'google.details.somethingNew', {
      attempted: 1,
      succeeded: 1,
      units: 1,
    });
    expect(rows).toEqual([
      expect.objectContaining({ serviceId: 'google.places', metric: 'calls', quantity: 1 }),
    ]);
  });

  it('drops a label no service claims', () => {
    expect(
      meterRowsFor('2026-09-02', 'dev', 'vietmap.search', { attempted: 1, succeeded: 1, units: 1 }),
    ).toEqual([]);
  });
});

describe('defaultRecomputeRange', () => {
  it('covers this month and the previous one, UTC', () => {
    expect(defaultRecomputeRange(new Date('2026-09-02T23:30:00Z'))).toEqual({
      from: '2026-08-01',
      to: '2026-09-02',
    });
    expect(defaultRecomputeRange(new Date('2026-01-01T00:00:00Z'))).toEqual({
      from: '2025-12-01',
      to: '2026-01-01',
    });
  });
});
