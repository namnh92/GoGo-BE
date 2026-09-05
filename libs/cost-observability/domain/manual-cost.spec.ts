import { describe, expect, it } from 'vitest';
import {
  activeInMonth,
  addDays,
  addMonths,
  anchorDayInMonth,
  chargeDays,
  classifyPeriod,
  daysInYear,
  isCalendarDay,
  isManualCostSource,
  manualCostSource,
  manualSchedule,
  materialiseItem,
  nextChargeDay,
  planManualCosts,
  type ManualCostItemFacts,
} from './manual-cost';

const item = (over: Partial<ManualCostItemFacts> = {}): ManualCostItemFacts => ({
  id: '11111111-1111-4111-8111-111111111111',
  providerId: 'apple',
  serviceId: 'apple.developer_program',
  name: 'Developer Program',
  amountMicros: 99_000_000,
  currency: 'USD',
  period: 'YEARLY',
  effectiveFrom: '2026-01-15',
  effectiveTo: null,
  ...over,
});

describe('manual cost — classification (ADR-0015)', () => {
  it('maps the operator period onto the row vocabulary every cost source shares', () => {
    expect(classifyPeriod('ONE_TIME')).toEqual({ costKind: 'ONE_TIME', billingCadence: null });
    expect(classifyPeriod('MONTHLY')).toEqual({ costKind: 'RECURRING', billingCadence: 'MONTHLY' });
    expect(classifyPeriod('YEARLY')).toEqual({ costKind: 'RECURRING', billingCadence: 'ANNUAL' });
  });
});

describe('manual cost — charge days, not daily shares (epic §27 as amended)', () => {
  it('bills MONTHLY on the anchor day of each month, clamped to shorter months', () => {
    const vps = item({ period: 'MONTHLY', amountMicros: 10_000_000, effectiveFrom: '2026-01-31' });
    expect(chargeDays(vps, { from: '2026-01-01', to: '2026-05-31' })).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
    expect(anchorDayInMonth('2028-02', 31)).toBe('2028-02-29');
    expect(anchorDayInMonth('2026-09', 15)).toBe('2026-09-15');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('bills YEARLY on the renewal date each year, Feb 29 falling back to Feb 28', () => {
    const leap = item({ effectiveFrom: '2028-02-29' });
    expect(chargeDays(leap, { from: '2028-01-01', to: '2032-12-31' })).toEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ]);
    expect(daysInYear(2026)).toBe(365);
    expect(daysInYear(2028)).toBe(366);
    expect(daysInYear(2100)).toBe(365);
    expect(daysInYear(2000)).toBe(366);
  });

  it('bills ONE_TIME once on its day, whatever effectiveTo says', () => {
    const once = item({
      period: 'ONE_TIME',
      effectiveFrom: '2026-03-03',
      effectiveTo: '2026-03-01',
    });
    expect(chargeDays(once, { from: '2026-01-01', to: '2026-12-31' })).toEqual(['2026-03-03']);
    expect(chargeDays(once, { from: '2026-04-01', to: '2026-12-31' })).toEqual([]);
  });

  it('is bounded by the effective range and by the range asked for', () => {
    const ended = item({
      period: 'MONTHLY',
      effectiveFrom: '2026-01-10',
      effectiveTo: '2026-03-09',
    });
    // March 10 is past effectiveTo; January 10 is before the range asked for.
    expect(chargeDays(ended, { from: '2026-02-01', to: '2026-12-31' })).toEqual(['2026-02-10']);
    expect(
      chargeDays(item({ effectiveFrom: '2027-01-01' }), { from: '2026-01-01', to: '2026-12-31' }),
    ).toEqual([]);
    expect(
      chargeDays(item({ effectiveFrom: '2026-09-05', effectiveTo: '2026-09-01' }), {
        from: '2026-01-01',
        to: '2026-12-31',
      }),
    ).toEqual([]);
  });

  it('knows the next charge day and whether an item is active in a month', () => {
    const monthly = item({ period: 'MONTHLY', effectiveFrom: '2026-01-15' });
    expect(nextChargeDay(monthly, '2026-09-10')).toBe('2026-09-15');
    expect(nextChargeDay(monthly, '2026-09-15')).toBe('2026-09-15');
    expect(nextChargeDay(monthly, '2026-09-16')).toBe('2026-10-15');
    expect(nextChargeDay({ ...monthly, effectiveTo: '2026-09-14' }, '2026-09-10')).toBeNull();
    expect(nextChargeDay(item(), '2026-09-10')).toBe('2027-01-15');
    expect(
      nextChargeDay(item({ period: 'ONE_TIME', effectiveFrom: '2026-03-03' }), '2026-09-10'),
    ).toBeNull();
    expect(
      nextChargeDay(item({ period: 'ONE_TIME', effectiveFrom: '2026-09-25' }), '2026-09-10'),
    ).toBe('2026-09-25');

    expect(activeInMonth(item(), '2026-09')).toBe(true);
    expect(activeInMonth(item({ effectiveTo: '2026-08-31' }), '2026-09')).toBe(false);
    expect(activeInMonth(item({ effectiveTo: '2026-09-01' }), '2026-09')).toBe(true);
    expect(activeInMonth(item({ effectiveFrom: '2026-10-01' }), '2026-09')).toBe(false);
    expect(
      activeInMonth(item({ period: 'ONE_TIME', effectiveFrom: '2026-09-05' }), '2026-09'),
    ).toBe(false);
  });
});

describe('manual cost — materialise never passes today', () => {
  it('writes one full-amount row per charge day up to today, classified', () => {
    const rows = materialiseItem(
      item({ period: 'MONTHLY', amountMicros: 3_000_000, effectiveFrom: '2026-07-08' }),
      '2026-09-10',
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-07-08', '2026-08-08', '2026-09-08']);
    expect(new Set(rows.map((r) => r.source))).toEqual(
      new Set(['manual_cost_items:11111111-1111-4111-8111-111111111111']),
    );
    expect(rows[0]).toMatchObject({
      providerId: 'apple',
      serviceId: 'apple.developer_program',
      currency: 'USD',
      amountMicros: 3_000_000,
      costKind: 'RECURRING',
      billingCadence: 'MONTHLY',
      periodAmountMicros: 3_000_000,
    });
  });

  it('a yearly fee is one row a year, at the full fee; a one-off is one row with no period amount', () => {
    expect(
      materialiseItem(item({ effectiveFrom: '2024-01-15' }), '2026-09-10').map((r) => r.day),
    ).toEqual(['2024-01-15', '2025-01-15', '2026-01-15']);
    const once = materialiseItem(
      item({ period: 'ONE_TIME', amountMicros: 25_000_000, effectiveFrom: '2026-03-03' }),
      '2026-09-10',
    );
    expect(once).toEqual([
      expect.objectContaining({
        day: '2026-03-03',
        amountMicros: 25_000_000,
        costKind: 'ONE_TIME',
        billingCadence: null,
        periodAmountMicros: null,
      }),
    ]);
  });

  it('has no rows before the item starts, before its first charge day, or for a future one-off', () => {
    expect(materialiseItem(item({ effectiveFrom: '2027-01-01' }), '2026-09-10')).toEqual([]);
    expect(
      materialiseItem(item({ period: 'MONTHLY', effectiveFrom: '2026-09-15' }), '2026-09-10'),
    ).toEqual([]);
    expect(
      materialiseItem(item({ period: 'ONE_TIME', effectiveFrom: '2026-09-11' }), '2026-09-10'),
    ).toEqual([]);
  });
});

describe('manual cost — plan for the whole environment', () => {
  it('plans rows for every item and the exact days each source may keep', () => {
    const live = item({ period: 'MONTHLY', amountMicros: 3_000_000, effectiveFrom: '2026-08-09' });
    const future = item({
      id: '22222222-2222-4222-8222-222222222222',
      effectiveFrom: '2027-01-01',
    });
    const plan = planManualCosts([live, future], '2026-09-10');
    expect(plan.rows.map((r) => r.day)).toEqual(['2026-08-09', '2026-09-09']);
    expect(plan.keep).toEqual([
      {
        source: manualCostSource(live.id),
        providerId: 'apple',
        serviceId: 'apple.developer_program',
        days: ['2026-08-09', '2026-09-09'],
      },
      {
        source: manualCostSource(future.id),
        providerId: 'apple',
        serviceId: 'apple.developer_program',
        days: [],
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

describe('manual cost — the month schedule the forecast reads', () => {
  it('lists the charges billed in the month and the recurring fees active in it', () => {
    const apple = item(); // annual, renews Jan 15: active in September, bills nothing in it
    const registrar = item({
      id: '33333333-3333-4333-8333-333333333333',
      providerId: 'registrar',
      serviceId: 'registrar.domain',
      name: 'gogo.vn',
      amountMicros: 10_000_000,
      effectiveFrom: '2025-09-20',
    }); // annual, renews Sept 20: billed in September
    const vps = item({
      id: '44444444-4444-4444-8444-444444444444',
      providerId: 'hosting',
      serviceId: 'hosting.vps',
      name: 'VPS',
      period: 'MONTHLY',
      amountMicros: 12_000_000,
      effectiveFrom: '2026-03-01',
    });
    const play = item({
      id: '55555555-5555-4555-8555-555555555555',
      providerId: 'google',
      serviceId: 'google.play_console',
      name: 'Play Console',
      period: 'ONE_TIME',
      amountMicros: 25_000_000,
      effectiveFrom: '2026-09-03',
    });
    const ended = item({
      id: '66666666-6666-4666-8666-666666666666',
      period: 'MONTHLY',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-08-31',
    });

    const s = manualSchedule([apple, registrar, vps, play, ended], '2026-09');
    expect(s.charges.map((c) => [c.name, c.kind, c.cadence, c.day, c.amountMicros])).toEqual([
      ['VPS', 'RECURRING', 'MONTHLY', '2026-09-01', 12_000_000],
      ['Play Console', 'ONE_TIME', null, '2026-09-03', 25_000_000],
      ['gogo.vn', 'RECURRING', 'ANNUAL', '2026-09-20', 10_000_000],
    ]);
    expect(s.commitments.map((c) => [c.name, c.cadence, c.periodAmountMicros])).toEqual([
      ['Developer Program', 'ANNUAL', 99_000_000],
      ['gogo.vn', 'ANNUAL', 10_000_000],
      ['VPS', 'MONTHLY', 12_000_000],
    ]);
    expect(s.charges[0]?.key).toBe(manualCostSource(vps.id));
  });
});
