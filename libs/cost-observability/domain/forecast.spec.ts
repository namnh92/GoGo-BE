import { describe, expect, it } from 'vitest';
import type { CostRow } from './budget';
import { EMPTY_SCHEDULE, monthForecast, scopeProjection, type MonthSchedule } from './forecast';
import { manualCostSource, manualSchedule, type ManualCostItemFacts } from './manual-cost';

const MONTH = '2026-09';
const TODAY = '2026-09-10';

const usage = (day: string, amountMicros = 1_000_000, over: Partial<CostRow> = {}): CostRow => ({
  day,
  providerId: 'google',
  serviceId: 'google.places',
  operationId: 'google.details.quality',
  usageMetricId: 'requests',
  billingSkuId: 'places.details.enterprise',
  amountMicros,
  currency: 'USD',
  basis: 'ESTIMATED',
  confidence: 'MEDIUM',
  source: 'estimator',
  costKind: 'USAGE',
  billingCadence: null,
  periodAmountMicros: null,
  ...over,
});

/** The monitoring model: a daily share of a declared monthly amount. */
const monitoring = (day: string, amountMicros = 10_000, periodAmountMicros = 300_000): CostRow => ({
  day,
  providerId: 'gogo',
  serviceId: 'gogo.cost_observability',
  operationId: null,
  usageMetricId: null,
  billingSkuId: null,
  amountMicros,
  currency: 'USD',
  basis: 'FIXED',
  confidence: 'HIGH',
  source: 'monitoring_cost_model',
  costKind: 'RECURRING',
  billingCadence: 'MONTHLY',
  periodAmountMicros,
});

const manualRow = (
  item: ManualCostItemFacts,
  day: string,
  over: Partial<CostRow> = {},
): CostRow => ({
  day,
  providerId: item.providerId,
  serviceId: item.serviceId,
  operationId: null,
  usageMetricId: null,
  billingSkuId: null,
  amountMicros: item.amountMicros,
  currency: item.currency,
  basis: 'MANUAL',
  confidence: 'HIGH',
  source: manualCostSource(item.id),
  costKind: item.period === 'ONE_TIME' ? 'ONE_TIME' : 'RECURRING',
  billingCadence:
    item.period === 'ONE_TIME' ? null : item.period === 'MONTHLY' ? 'MONTHLY' : 'ANNUAL',
  periodAmountMicros: item.period === 'ONE_TIME' ? null : item.amountMicros,
  ...over,
});

const item = (id: string, over: Partial<ManualCostItemFacts>): ManualCostItemFacts => ({
  id: `${id}${id}${id}${id}${id}${id}${id}${id}-${id}${id}${id}${id}-4${id}${id}${id}-8${id}${id}${id}-${id.repeat(12)}`,
  providerId: 'hosting',
  serviceId: 'hosting.vps',
  name: 'VPS',
  amountMicros: 12_000_000,
  currency: 'USD',
  period: 'MONTHLY',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  ...over,
});

const vpsOn1st = item('1', { name: 'VPS (1st)' });
const vpsOn15th = item('2', {
  name: 'VPS (15th)',
  amountMicros: 3_000_000,
  effectiveFrom: '2026-01-15',
});
const apple = item('3', {
  providerId: 'apple',
  serviceId: 'apple.developer_program',
  name: 'Apple',
  period: 'YEARLY',
  amountMicros: 99_000_000,
  effectiveFrom: '2026-01-15',
});
const registrar = item('4', {
  providerId: 'registrar',
  serviceId: 'registrar.domain',
  name: 'gogo.vn',
  period: 'YEARLY',
  amountMicros: 10_000_000,
  effectiveFrom: '2025-09-20',
});
const play = item('5', {
  providerId: 'google',
  serviceId: 'google.play_console',
  name: 'Play Console',
  period: 'ONE_TIME',
  amountMicros: 25_000_000,
  effectiveFrom: '2026-09-03',
});
const laterOneOff = item('6', {
  providerId: 'registrar',
  serviceId: 'registrar.domain',
  name: 'Transfer fee',
  period: 'ONE_TIME',
  amountMicros: 5_000_000,
  effectiveFrom: '2026-09-25',
});
const ITEMS = [vpsOn1st, vpsOn15th, apple, registrar, play, laterOneOff];

const tenDaysOfUsage = () =>
  Array.from({ length: 10 }, (_, i) => usage(`2026-09-${String(i + 1).padStart(2, '0')}`));
const tenDaysOfMonitoring = () =>
  Array.from({ length: 10 }, (_, i) => monitoring(`2026-09-${String(i + 1).padStart(2, '0')}`));

describe('monthForecast — three numbers, kept apart (ADR-0015)', () => {
  const rows = [
    ...tenDaysOfUsage(),
    ...tenDaysOfMonitoring(),
    manualRow(vpsOn1st, '2026-09-01'),
    manualRow(play, '2026-09-03'),
  ];
  const f = monthForecast({
    month: MONTH,
    today: TODAY,
    rows,
    schedule: manualSchedule(ITEMS, MONTH),
    usageExpected: true,
  });

  it('month actual is what landed, by kind', () => {
    expect(f.actual.micros).toBe(47_100_000);
    expect(f.actual.byKind).toEqual({
      USAGE: 10_000_000,
      RECURRING: 12_100_000,
      ONE_TIME: 25_000_000,
    });
    expect(f.elapsedDays).toBe(10);
    expect(f.daysInMonth).toBe(30);
  });

  it('only usage is extrapolated from the elapsed period', () => {
    expect(f.usage).toEqual({ mtdMicros: 10_000_000, projectedMicros: 30_000_000, reason: null });
  });

  it('recurring: what landed plus what the schedule still bills this month — never an average', () => {
    // Monitoring: 0.10 landed of a declared 0.30 → 0.20 to come.
    // VPS on the 1st landed whole; VPS on the 15th is still ahead; the
    // registrar renews on the 20th (annual, in this month); Apple renews in
    // January and bills nothing in September.
    expect(f.recurring).toEqual({
      landedMicros: 12_100_000,
      scheduledMicros: 13_200_000,
      committedMicros: 25_300_000,
    });
  });

  it('one-time: counted once, whether landed or scheduled', () => {
    expect(f.oneTime).toEqual({ landedMicros: 25_000_000, scheduledMicros: 5_000_000 });
  });

  it("the cash forecast is usage projection + this month's recurring charges + one-offs", () => {
    expect(f.cash).toEqual({ micros: 85_300_000, floorMicros: 55_300_000, partial: false });
    // The old formula (MTD ÷ elapsed × days) would have said 141.30 — a $25
    // one-off multiplied by three and a $12 monthly fee by three.
    expect(f.cash.micros).not.toBe(Math.ceil((47_100_000 / 10) * 30));
  });

  it('the run-rate normalises annual fees to a twelfth and excludes one-offs', () => {
    expect(f.runRate).toEqual({
      micros: 54_383_333,
      usageMicros: 30_000_000,
      recurringMonthlyMicros: 15_300_000,
      annualEquivalentMicros: 8_250_000 + 833_333,
      oneTimeExcludedMicros: 30_000_000,
    });
  });

  it('lists what is still to land this month, soonest first, a spread model last', () => {
    expect(f.scheduled.map((c) => [c.name, c.kind, c.day, c.amountMicros])).toEqual([
      ['VPS (15th)', 'RECURRING', '2026-09-15', 3_000_000],
      ['gogo.vn', 'RECURRING', '2026-09-20', 10_000_000],
      ['Transfer fee', 'ONE_TIME', '2026-09-25', 5_000_000],
      [null, 'RECURRING', null, 200_000],
    ]);
    expect(f.currency).toBe('USD');
    expect(f.mixedCurrency).toBe(false);
    expect(scopeProjection(f)).toEqual({
      cashMicros: 85_300_000,
      cashFloorMicros: 55_300_000,
      runRateMicros: 54_383_333,
    });
  });
});

describe('monthForecast — when the usage half cannot be projected', () => {
  it('under three elapsed days the usage half is null and the cash forecast is a floor', () => {
    const f = monthForecast({
      month: MONTH,
      today: '2026-09-02',
      rows: [usage('2026-09-01'), usage('2026-09-02'), manualRow(vpsOn1st, '2026-09-01')],
      schedule: manualSchedule([vpsOn1st, vpsOn15th], MONTH),
      usageExpected: true,
    });
    expect(f.usage).toEqual({
      mtdMicros: 2_000_000,
      projectedMicros: null,
      reason: 'INSUFFICIENT_HISTORY',
    });
    expect(f.cash).toEqual({ micros: null, floorMicros: 15_000_000, partial: true });
    expect(f.runRate.micros).toBeNull();
    expect(f.runRate.recurringMonthlyMicros).toBe(15_000_000);
    // What landed is still what landed.
    expect(f.actual.micros).toBe(14_000_000);
  });

  it('with usage expected and no rows, the cash forecast stays partial', () => {
    const f = monthForecast({
      month: MONTH,
      today: TODAY,
      rows: [manualRow(vpsOn1st, '2026-09-01')],
      schedule: manualSchedule([vpsOn1st], MONTH),
      usageExpected: true,
    });
    expect(f.usage.reason).toBe('NO_USAGE_ROWS');
    expect(f.cash).toEqual({ micros: null, floorMicros: 12_000_000, partial: true });
  });

  it('a manual-only scope has a known zero usage half and a complete cash forecast', () => {
    const f = monthForecast({
      month: MONTH,
      today: TODAY,
      rows: [manualRow(vpsOn1st, '2026-09-01')],
      schedule: manualSchedule([vpsOn1st, apple], MONTH),
      usageExpected: false,
    });
    expect(f.usage).toEqual({ mtdMicros: 0, projectedMicros: 0, reason: 'NOT_APPLICABLE' });
    expect(f.cash).toEqual({ micros: 12_000_000, floorMicros: 12_000_000, partial: false });
    // Apple's twelfth is run-rate, not cash.
    expect(f.runRate).toMatchObject({ micros: 20_250_000, annualEquivalentMicros: 8_250_000 });
  });
});

describe('monthForecast — annual fees', () => {
  it('enter the cash forecast only in their renewal month, and the run-rate as a twelfth always', () => {
    const january = monthForecast({
      month: '2026-01',
      today: '2026-01-10',
      rows: [],
      schedule: manualSchedule([apple], '2026-01'),
      usageExpected: false,
    });
    expect(january.cash.micros).toBe(99_000_000);
    expect(january.scheduled.map((c) => [c.name, c.day])).toEqual([['Apple', '2026-01-15']]);
    expect(january.runRate.annualEquivalentMicros).toBe(8_250_000);

    const february = monthForecast({
      month: '2026-02',
      today: '2026-02-10',
      rows: [],
      schedule: manualSchedule([apple], '2026-02'),
      usageExpected: false,
    });
    expect(february.cash.micros).toBe(0);
    expect(february.scheduled).toEqual([]);
    expect(february.runRate.annualEquivalentMicros).toBe(8_250_000);

    // Landed in its renewal month: still counted once.
    const landed = monthForecast({
      month: '2026-01',
      today: '2026-01-20',
      rows: [manualRow(apple, '2026-01-15')],
      schedule: manualSchedule([apple], '2026-01'),
      usageExpected: false,
    });
    expect(landed.actual.byKind.RECURRING).toBe(99_000_000);
    expect(landed.recurring).toEqual({
      landedMicros: 99_000_000,
      scheduledMicros: 0,
      committedMicros: 99_000_000,
    });
    expect(landed.cash.micros).toBe(99_000_000);
  });
});

describe('monthForecast — rows the schedule does not describe', () => {
  it('a manual row whose item bills nothing this month counts as landed and declares no commitment', () => {
    // A pre-ADR-0015 daily share of Apple's annual fee, not yet rebuilt.
    const stale = manualRow(apple, '2026-09-01', { amountMicros: 271_233 });
    const f = monthForecast({
      month: MONTH,
      today: TODAY,
      rows: [stale],
      schedule: manualSchedule([apple], MONTH),
      usageExpected: false,
    });
    expect(f.recurring).toEqual({
      landedMicros: 271_233,
      scheduledMicros: 0,
      committedMicros: 271_233,
    });
    expect(f.scheduled).toEqual([]);
    expect(f.runRate.annualEquivalentMicros).toBe(8_250_000);
  });

  it('a recurring source with no schedule declares its own period amount on the row', () => {
    const f = monthForecast({
      month: MONTH,
      today: TODAY,
      rows: tenDaysOfMonitoring(),
      schedule: EMPTY_SCHEDULE,
      usageExpected: false,
    });
    expect(f.recurring).toEqual({
      landedMicros: 100_000,
      scheduledMicros: 200_000,
      committedMicros: 300_000,
    });
    expect(f.runRate.recurringMonthlyMicros).toBe(300_000);
    // The declared amount can change mid-month; the latest row wins.
    const bumped = monthForecast({
      month: MONTH,
      today: TODAY,
      rows: [...tenDaysOfMonitoring().slice(0, 9), monitoring('2026-09-10', 20_000, 600_000)],
      schedule: EMPTY_SCHEDULE,
      usageExpected: false,
    });
    expect(bumped.recurring.committedMicros).toBe(600_000);
  });

  it('ignores rows outside the month and the epic §12 precedence still applies inside it', () => {
    const f = monthForecast({
      month: MONTH,
      today: TODAY,
      rows: [
        ...tenDaysOfUsage(),
        usage('2026-08-31', 9_000_000),
        usage('2026-09-03', 1_100_000, {
          basis: 'ACTUAL',
          confidence: 'HIGH',
          source: 'gcp_billing_export',
        }),
      ],
      schedule: EMPTY_SCHEDULE,
      usageExpected: true,
    });
    expect(f.usage.mtdMicros).toBe(10_100_000);
    expect(f.usage.projectedMicros).toBe(30_300_000);
  });

  it('refuses to total two currencies, but still lists the parts', () => {
    const schedule: MonthSchedule = manualSchedule(
      [
        vpsOn1st,
        item('7', {
          name: 'VND item',
          currency: 'VND',
          amountMicros: 5_000_000,
          effectiveFrom: '2026-09-20',
        }),
      ],
      MONTH,
    );
    const f = monthForecast({
      month: MONTH,
      today: TODAY,
      rows: tenDaysOfUsage(),
      schedule,
      usageExpected: true,
    });
    expect(f.mixedCurrency).toBe(true);
    expect(f.currency).toBeNull();
    expect(f.cash.micros).toBeNull();
    expect(f.runRate.micros).toBeNull();
    expect(f.scheduled).toHaveLength(2);
  });
});
