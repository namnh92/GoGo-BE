/**
 * PROF-BE-013 (#573) — an optional date of birth is a calendar date, not an
 * instant. It is compared as `YYYY-MM-DD` text and never passed through a
 * `Date` in a local time zone, so no offset can move it by a day.
 */

/** The calendar "today" is read in. UTC+7 all year, no daylight saving. */
export const DATE_OF_BIRTH_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True for a date that exists: `2024-02-29` yes, `2027-02-29`, `2026-13-01`
 * and `1990-04-31` no. Year 0000 is refused because PostgreSQL `date` has no
 * year zero; nothing else bounds the past, since no age rule applies.
 */
export function isCalendarDate(value: string): boolean {
  const match = SHAPE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(0);
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0–99 onto 1900–1999.
  probe.setUTCFullYear(year, month - 1, day);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Today's calendar date in Asia/Ho_Chi_Minh, as `YYYY-MM-DD`. */
export function todayInVietnam(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DATE_OF_BIRTH_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

/**
 * True when a calendar date is after today in Asia/Ho_Chi_Minh. Today itself
 * is accepted. Both sides are zero-padded `YYYY-MM-DD`, so text order is
 * calendar order.
 */
export function isAfterTodayInVietnam(value: string, now: Date = new Date()): boolean {
  return value > todayInVietnam(now);
}
