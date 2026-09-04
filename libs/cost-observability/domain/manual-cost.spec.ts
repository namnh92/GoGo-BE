import { describe, expect, it } from 'vitest';
import {
  addDays,
  coveredRange,
  dailyShareMicros,
  daysInYear,
  isCalendarDay,
  isManualCostSource,
  manualCostSource,
  materialiseItem,
  planManualCosts,
  type ManualCostItemFacts,
} from './manual-cost';

const item = (over: Partial<ManualCostItemFacts> = {}): ManualCostItemFacts => ({
  id: '11111111-1111-4111-8111-111111111111',
  providerId: 'apple',
  serviceId: 'apple.developer_program',
  amountMicros: 99_000_000,
  currency: 'USD',
  period: 'YEARLY',
  effectiveFrom: '2026-01-15',
  effectiveTo: null,
  ...over,
});

describe('manual cost — daily share (epic §27)', () => {
  it('spreads MONTHLY over the days of that month, so a month adds up to the fee within rounding', () => {
    const monthly = item({ period: 'MONTHLY', amountMicros: 10_000_000 });
    expect(dailyShareMicros(monthly, '2026-09-10')).toBe(333_333); // 30 days
    expect(dailyShareMicros(monthly, '2026-02-10')).toBe(357_143); // 28 days
    expect(dailyShareMicros(monthly, '2028-02-10')).toBe(344_828); // 29 days
    const september = materialiseItem(
      { ...monthly, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' },
      '2026-12-31',
    );
    expect(september).toHaveLength(30);
    const sum = september.reduce((s, r) => s + r.amountMicros, 0);
    expect(Math.abs(sum - 10_000_000)).toBeLessThanOrEqual(15); // ≤ half a micro a day
  });

  it('spreads YEARLY over that year, leap years included', () => {
    expect(daysInYear(2026)).toBe(365);
    expect(daysInYear(2028)).toBe(366);
    expect(daysInYear(2100)).toBe(365);
    expect(daysInYear(2000)).toBe(366);
    expect(dailyShareMicros(item({ amountMicros: 36_500_000 }), '2026-06-01')).toBe(100_000);
    expect(dailyShareMicros(item({ amountMicros: 36_600_000 }), '2028-06-01')).toBe(100_000);
  });

  it('charges ONE_TIME in full on its one day', () => {
    const once = item({
      period: 'ONE_TIME',
      amountMicros: 25_000_000,
      effectiveFrom: '2026-03-03',
    });
    expect(dailyShareMicros(once, '2026-03-03')).toBe(25_000_000);
    expect(materialiseItem(once, '2026-09-10')).toEqual([
      expect.objectContaining({ day: '2026-03-03', amountMicros: 25_000_000 }),
    ]);
    // effective_to means nothing for a one-off; the day is the day.
    expect(materialiseItem({ ...once, effectiveTo: '2026-03-01' }, '2026-09-10')).toHaveLength(1);
  });
});

describe('manual cost — covered range never passes today', () => {
  it('runs from effective_from to the earlier of effective_to and today', () => {
    expect(coveredRange(item({ effectiveFrom: '2026-09-01' }), '2026-09-10')).toEqual({
      from: '2026-09-01',
      to: '2026-09-10',
    });
    expect(
      coveredRange(item({ effectiveFrom: '2026-09-01', effectiveTo: '2026-09-05' }), '2026-09-10'),
    ).toEqual({ from: '2026-09-01', to: '2026-09-05' });
    expect(
      coveredRange(item({ effectiveFrom: '2026-09-01', effectiveTo: '2026-12-31' }), '2026-09-10'),
    ).toEqual({ from: '2026-09-01', to: '2026-09-10' });
  });

  it('is empty before the item starts, for a one-off in the future, and for an inverted range', () => {
    expect(coveredRange(item({ effectiveFrom: '2026-09-11' }), '2026-09-10')).toBeNull();
    expect(
      coveredRange(item({ period: 'ONE_TIME', effectiveFrom: '2026-09-11' }), '2026-09-10'),
    ).toBeNull();
    expect(
      coveredRange(item({ effectiveFrom: '2026-09-05', effectiveTo: '2026-09-01' }), '2026-09-10'),
    ).toBeNull();
    expect(materialiseItem(item({ effectiveFrom: '2027-01-01' }), '2026-09-10')).toEqual([]);
  });

  it('materialises one row per day, keyed by the item source', () => {
    const rows = materialiseItem(
      item({ period: 'MONTHLY', amountMicros: 3_000_000, effectiveFrom: '2026-09-08' }),
      '2026-09-10',
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-09-08', '2026-09-09', '2026-09-10']);
    expect(new Set(rows.map((r) => r.source))).toEqual(
      new Set(['manual_cost_items:11111111-1111-4111-8111-111111111111']),
    );
    expect(rows[0]).toMatchObject({
      providerId: 'apple',
      serviceId: 'apple.developer_program',
      currency: 'USD',
      amountMicros: 100_000,
    });
  });
});

describe('manual cost — plan for the whole environment', () => {
  it('plans rows for every item and a keep-range per item, null for one with nothing yet', () => {
    const live = item({ period: 'MONTHLY', amountMicros: 3_000_000, effectiveFrom: '2026-09-09' });
    const future = item({
      id: '22222222-2222-4222-8222-222222222222',
      effectiveFrom: '2027-01-01',
    });
    const plan = planManualCosts([live, future], '2026-09-10');
    expect(plan.rows).toHaveLength(2);
    expect(plan.keep).toEqual([
      {
        source: manualCostSource(live.id),
        providerId: 'apple',
        serviceId: 'apple.developer_program',
        range: { from: '2026-09-09', to: '2026-09-10' },
      },
      {
        source: manualCostSource(future.id),
        providerId: 'apple',
        serviceId: 'apple.developer_program',
        range: null,
      },
    ]);
  });

  it('names its source family and validates calendar days', () => {
    expect(isManualCostSource('manual_cost_items:abc')).toBe(true);
    expect(isManualCostSource('manual_cost_items')).toBe(false);
    expect(isManualCostSource('estimator')).toBe(false);
    expect(isCalendarDay('2026-02-28')).toBe(true);
    expect(isCalendarDay('2026-02-30')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('26-01-01')).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
