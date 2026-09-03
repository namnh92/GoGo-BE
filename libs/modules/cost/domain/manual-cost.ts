import { daysInMonth } from './budget';

/**
 * COST-BE-023 (#382) — epic §27, manual / fixed costs.
 *
 * A manual cost item is a fee somebody typed into the CMS — Apple Developer,
 * a domain, a VPS — with a period and an effective range. It is not usage
 * and no collector reads it back; what makes it part of the canonical model
 * (epic §44.18) is that it is *materialised* into `provider_cost_daily` as
 * MANUAL rows, one per covered day, so every reader (`spend()`, budgets,
 * the Cost API) sees it beside estimated and actual spend without a special
 * case. Per-test deltas never see it: they are usage deltas, and a
 * subscription has no usage (epic §27, "excluded by default").
 *
 * Everything here is pure. The service around it owns the tables.
 */

export const MANUAL_COST_PERIODS = ['ONE_TIME', 'MONTHLY', 'YEARLY'] as const;
export type ManualCostPeriod = (typeof MANUAL_COST_PERIODS)[number];

/**
 * The `source` family on `provider_cost_daily`. One item is one source
 * (`manual_cost_items:<id>`), because the table's key has no other column
 * that can tell two items under the same service apart, and two domains
 * under `registrar.domain` are two costs, not one.
 */
export const MANUAL_COST_SOURCE = 'manual_cost_items';
export const MANUAL_COST_SOURCE_PREFIX = `${MANUAL_COST_SOURCE}:`;

export function manualCostSource(itemId: string): string {
  return `${MANUAL_COST_SOURCE_PREFIX}${itemId}`;
}

export function isManualCostSource(source: string): boolean {
  return source.startsWith(MANUAL_COST_SOURCE_PREFIX);
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
  /** `YYYY-MM-DD`, inclusive. */
  effectiveFrom: string;
  /** `YYYY-MM-DD`, inclusive; `null` = open-ended. Ignored for ONE_TIME. */
  effectiveTo: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
};

export type ManualCostItemFacts = Pick<
  ManualCostItem,
  'id' | 'providerId' | 'serviceId' | 'amountMicros' | 'currency' | 'period' | 'effectiveFrom'
> & { effectiveTo: string | null };

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

/**
 * What one covered day of the item costs. MONTHLY spreads the amount over
 * the days of *that* day's month, YEARLY over that day's year, so a month's
 * rows add up to the monthly fee (within rounding: at most half a micro per
 * day). ONE_TIME is the whole amount on its one day.
 */
export function dailyShareMicros(
  item: Pick<ManualCostItemFacts, 'amountMicros' | 'period'>,
  day: string,
): number {
  switch (item.period) {
    case 'ONE_TIME':
      return item.amountMicros;
    case 'MONTHLY':
      return Math.round(item.amountMicros / daysInMonth(day.slice(0, 7)));
    case 'YEARLY':
      return Math.round(item.amountMicros / daysInYear(Number(day.slice(0, 4))));
  }
}

export type DayRange = { from: string; to: string };

/**
 * The days an item has rows for as of `today`, inclusive both ends, or
 * `null` when it has none yet (it starts in the future) or none at all (an
 * end before its start — refused at write, tolerated here). Nothing is ever
 * materialised past `today`: a month-to-date figure that already contained
 * the rest of the month would not be month-to-date.
 */
export function coveredRange(
  item: Pick<ManualCostItemFacts, 'period' | 'effectiveFrom' | 'effectiveTo'>,
  today: string,
): DayRange | null {
  if (item.effectiveFrom > today) return null;
  if (item.period === 'ONE_TIME') return { from: item.effectiveFrom, to: item.effectiveFrom };
  const to = item.effectiveTo !== null && item.effectiveTo < today ? item.effectiveTo : today;
  return item.effectiveFrom > to ? null : { from: item.effectiveFrom, to };
}

export function* eachDay(range: DayRange): Generator<string> {
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) yield day;
}

export type ManualCostRowPlan = {
  day: string;
  providerId: string;
  serviceId: string;
  amountMicros: number;
  currency: string;
  source: string;
  itemId: string;
};

/**
 * Every row one item should have as of `today`. Idempotent by construction:
 * the same item and day always plan the same row, keyed by
 * (day, provider, service, source).
 */
export function materialiseItem(item: ManualCostItemFacts, today: string): ManualCostRowPlan[] {
  const range = coveredRange(item, today);
  if (range === null) return [];
  const source = manualCostSource(item.id);
  const rows: ManualCostRowPlan[] = [];
  for (const day of eachDay(range)) {
    rows.push({
      day,
      providerId: item.providerId,
      serviceId: item.serviceId,
      amountMicros: dailyShareMicros(item, day),
      currency: item.currency,
      source,
      itemId: item.id,
    });
  }
  return rows;
}

export type ManualCostPlan = {
  rows: ManualCostRowPlan[];
  /**
   * Per live item, the only rows it may keep: its current provider/service
   * and covered range. Rows of that source outside this are stale — the item
   * moved, shrank, or ended — and are deleted. An item with no range keeps
   * nothing.
   */
  keep: { source: string; providerId: string; serviceId: string; range: DayRange | null }[];
};

export function planManualCosts(
  items: readonly ManualCostItemFacts[],
  today: string,
): ManualCostPlan {
  const rows: ManualCostRowPlan[] = [];
  const keep: ManualCostPlan['keep'] = [];
  for (const item of items) {
    rows.push(...materialiseItem(item, today));
    keep.push({
      source: manualCostSource(item.id),
      providerId: item.providerId,
      serviceId: item.serviceId,
      range: coveredRange(item, today),
    });
  }
  return { rows, keep };
}
