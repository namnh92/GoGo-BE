import { daysInMonth, type BillingCadence, type CostKind } from './budget';
import type { Commitment, MonthSchedule, ScheduledCharge } from './forecast';

export {
  MANUAL_COST_SOURCE,
  MANUAL_COST_SOURCE_PREFIX,
  isManualCostSource,
  manualCostSource,
} from './manual-cost-source';
import { manualCostSource } from './manual-cost-source';

/**
 * COST-BE-023 (#382) — epic §27, manual / fixed costs — as amended by
 * COST-BE-034 (#415, ADR-0015): billing semantics.
 *
 * A manual cost item is a fee somebody typed into the CMS — Apple Developer,
 * a domain, a VPS — with a period and an effective range. It is not usage
 * and no collector reads it back; what makes it part of the canonical model
 * (epic §44.18) is that it is *materialised* into `provider_cost_daily` as
 * MANUAL rows, so every reader (`spend()`, budgets, the Cost API) sees it
 * beside estimated and actual spend without a special case. Per-test deltas
 * never see it: they are usage deltas, and a subscription has no usage
 * (epic §27, "excluded by default").
 *
 * **A row is a charge, on the day it is billed.** A MONTHLY fee lands once a
 * month on its anchor day (the day-of-month of `effectiveFrom`, clamped to
 * shorter months); a YEARLY fee lands once a year on its renewal date; a
 * ONE_TIME fee lands once. Nothing is spread over days: a daily share of an
 * annual fee would put money into a month that never invoices it, and a
 * forecast that averaged it back up would be extrapolating a subscription
 * from a calendar. What has not landed yet is the item's *schedule*
 * (`manualSchedule`), which the forecast reads directly.
 *
 * Everything here is pure. The service around it owns the tables.
 */

export const MANUAL_COST_PERIODS = ['ONE_TIME', 'MONTHLY', 'YEARLY'] as const;
export type ManualCostPeriod = (typeof MANUAL_COST_PERIODS)[number];

/** The item's period, in the row vocabulary every cost source shares (ADR-0015). */
export function classifyPeriod(period: ManualCostPeriod): {
  costKind: Exclude<CostKind, 'USAGE'>;
  billingCadence: BillingCadence | null;
} {
  switch (period) {
    case 'ONE_TIME':
      return { costKind: 'ONE_TIME', billingCadence: null };
    case 'MONTHLY':
      return { costKind: 'RECURRING', billingCadence: 'MONTHLY' };
    case 'YEARLY':
      return { costKind: 'RECURRING', billingCadence: 'ANNUAL' };
  }
}

export type ManualCostItem = {
  id: string;
  environment: string;
  providerId: string;
  serviceId: string;
  name: string;
  /** Micros of `currency`; the amount per period, never per day. */
  amountMicros: number;
  currency: string;
  period: ManualCostPeriod;
  /** Derived from `period` — the classification every cost source carries. */
  costKind: Exclude<CostKind, 'USAGE'>;
  billingCadence: BillingCadence | null;
  /** `YYYY-MM-DD`, inclusive. Also the billing anchor: its day-of-month (MONTHLY) or its month-day (YEARLY). */
  effectiveFrom: string;
  /** `YYYY-MM-DD`, inclusive; `null` = open-ended. Ignored for ONE_TIME. */
  effectiveTo: string | null;
  /** The first charge day on or after today; `null` when no charge is ahead. */
  nextChargeDay: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
};

export type ManualCostItemFacts = Pick<
  ManualCostItem,
  'id' | 'providerId' | 'serviceId' | 'amountMicros' | 'currency' | 'period' | 'effectiveFrom'
> & { effectiveTo: string | null; name?: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `true` for a real calendar day written `YYYY-MM-DD`. */
export function isCalendarDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM` + `n` months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** The anchor day-of-month inside `month`, clamped to the month's length (31 → 30, 29 → 28). */
export function anchorDayInMonth(month: string, dayOfMonth: number): string {
  return `${month}-${pad(Math.min(dayOfMonth, daysInMonth(month)))}`;
}

export type DayRange = { from: string; to: string };

/**
 * The days the item is billed inside `range` (inclusive both ends), in
 * order. Bounded by the item's own effective range; a ONE_TIME item has one
 * day whatever `effectiveTo` says. Empty when nothing is billed in range.
 */
export function chargeDays(
  item: Pick<ManualCostItemFacts, 'period' | 'effectiveFrom' | 'effectiveTo'>,
  range: DayRange,
): string[] {
  if (item.period === 'ONE_TIME') {
    const d = item.effectiveFrom;
    return d >= range.from && d <= range.to ? [d] : [];
  }
  const from = item.effectiveFrom > range.from ? item.effectiveFrom : range.from;
  const to = item.effectiveTo !== null && item.effectiveTo < range.to ? item.effectiveTo : range.to;
  if (from > to) return [];
  const out: string[] = [];
  if (item.period === 'MONTHLY') {
    const anchor = Number(item.effectiveFrom.slice(8, 10));
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(m, 1)) {
      const day = anchorDayInMonth(m, anchor);
      if (day >= from && day <= to) out.push(day);
    }
    return out;
  }
  // YEARLY: the renewal date each year, Feb 29 falling back to Feb 28.
  const monthDay = item.effectiveFrom.slice(5, 7);
  const anchor = Number(item.effectiveFrom.slice(8, 10));
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
    const day = anchorDayInMonth(`${y}-${monthDay}`, anchor);
    if (day >= from && day <= to) out.push(day);
  }
  return out;
}

/** The first charge day on or after `today`, or `null` when the item has none ahead. */
export function nextChargeDay(
  item: Pick<ManualCostItemFacts, 'period' | 'effectiveFrom' | 'effectiveTo'>,
  today: string,
): string | null {
  if (item.period === 'ONE_TIME') return item.effectiveFrom >= today ? item.effectiveFrom : null;
  if (item.effectiveTo !== null && item.effectiveTo < today) return null;
  // Two periods ahead is always enough to contain the next charge.
  const horizon = item.period === 'MONTHLY' ? addDays(today, 62) : addDays(today, 2 * 366);
  return chargeDays(item, { from: today, to: horizon })[0] ?? null;
}

/** `true` when a recurring item is in force on any day of `month`. */
export function activeInMonth(
  item: Pick<ManualCostItemFacts, 'period' | 'effectiveFrom' | 'effectiveTo'>,
  month: string,
): boolean {
  if (item.period === 'ONE_TIME') return false;
  const monthEnd = `${month}-${pad(daysInMonth(month))}`;
  return (
    item.effectiveFrom <= monthEnd &&
    (item.effectiveTo === null || item.effectiveTo >= `${month}-01`)
  );
}

export type ManualCostRowPlan = {
  day: string;
  providerId: string;
  serviceId: string;
  amountMicros: number;
  currency: string;
  source: string;
  itemId: string;
  costKind: Exclude<CostKind, 'USAGE'>;
  billingCadence: BillingCadence | null;
  /** The period's full charge for a RECURRING row; `null` for ONE_TIME. */
  periodAmountMicros: number | null;
};

/**
 * Every row one item should have as of `today`: one per charge day from
 * `effectiveFrom` up to and including today, at the full amount. Nothing is
 * ever materialised past `today`: a month-to-date figure that already
 * contained a charge not yet billed would not be month-to-date. Idempotent
 * by construction: the same item and day always plan the same row.
 */
export function materialiseItem(item: ManualCostItemFacts, today: string): ManualCostRowPlan[] {
  if (item.effectiveFrom > today) return [];
  const { costKind, billingCadence } = classifyPeriod(item.period);
  const source = manualCostSource(item.id);
  return chargeDays(item, { from: item.effectiveFrom, to: today }).map((day) => ({
    day,
    providerId: item.providerId,
    serviceId: item.serviceId,
    amountMicros: item.amountMicros,
    currency: item.currency,
    source,
    itemId: item.id,
    costKind,
    billingCadence,
    periodAmountMicros: costKind === 'RECURRING' ? item.amountMicros : null,
  }));
}

export type ManualCostPlan = {
  rows: ManualCostRowPlan[];
  /**
   * Per live item, the only rows it may keep: its current provider/service
   * and its charge days so far. Rows of that source on any other day, or
   * under another service, are stale — the item moved, its anchor changed,
   * it ended, or they predate charge-day recognition — and are deleted. An
   * item with no charge yet keeps nothing.
   */
  keep: { source: string; providerId: string; serviceId: string; days: string[] }[];
};

export function planManualCosts(
  items: readonly ManualCostItemFacts[],
  today: string,
): ManualCostPlan {
  const rows: ManualCostRowPlan[] = [];
  const keep: ManualCostPlan['keep'] = [];
  for (const item of items) {
    const planned = materialiseItem(item, today);
    rows.push(...planned);
    keep.push({
      source: manualCostSource(item.id),
      providerId: item.providerId,
      serviceId: item.serviceId,
      days: planned.map((r) => r.day),
    });
  }
  return { rows, keep };
}

/**
 * What the items say about `month`, for the forecast: every charge whose
 * billing date falls in the month (landed or not — the engine tells them
 * apart by the rows), and every recurring item active in the month (the
 * run-rate input, whatever its billing date).
 */
export function manualSchedule(
  items: readonly ManualCostItemFacts[],
  month: string,
): MonthSchedule {
  const charges: ScheduledCharge[] = [];
  const commitments: Commitment[] = [];
  const range = { from: `${month}-01`, to: `${month}-${pad(daysInMonth(month))}` };
  for (const item of items) {
    const { costKind, billingCadence } = classifyPeriod(item.period);
    const key = manualCostSource(item.id);
    for (const day of chargeDays(item, range)) {
      charges.push({
        key,
        providerId: item.providerId,
        serviceId: item.serviceId,
        name: item.name ?? null,
        kind: costKind,
        cadence: billingCadence,
        day,
        amountMicros: item.amountMicros,
        currency: item.currency,
      });
    }
    if (billingCadence !== null && activeInMonth(item, month)) {
      commitments.push({
        key,
        providerId: item.providerId,
        serviceId: item.serviceId,
        name: item.name ?? null,
        cadence: billingCadence,
        periodAmountMicros: item.amountMicros,
        currency: item.currency,
      });
    }
  }
  charges.sort((a, b) => a.day!.localeCompare(b.day!) || a.key.localeCompare(b.key));
  return { charges, commitments };
}
