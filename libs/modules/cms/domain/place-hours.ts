/**
 * BE-CMS-PE-001 (#425) — what a week of opening hours may say.
 *
 * The old contract was one flat array of spans with no notion of a day's
 * *state*, which left three different facts sharing one encoding:
 *
 *   - a day with no row meant "closed" or "we have no data", indistinguishably;
 *   - "open around the clock" had no encoding at all, because the column check
 *     stops at minute 1439 and `00:00–23:59` shuts the place for a minute every
 *     night;
 *   - two rows for the same day were accepted but nothing said whether they
 *     were a lunch and a dinner service or a mistake.
 *
 * So a day now carries a kind. `interval` rows are spans and a day may hold
 * several; `closed` and `open_24h` are whole-day assertions and must be the
 * only row for their day. **Unknown stays the absence of a row** — a fourth
 * kind would be a row asserting that nothing is known, which is not a fact
 * about the place.
 */

export const HOURS_ENTRY_KINDS = ['interval', 'closed', 'open_24h'] as const;
export type HoursEntryKind = (typeof HOURS_ENTRY_KINDS)[number];

export type HoursEntry = {
  dayOfWeek: number;
  kind: HoursEntryKind;
  openMinute: number;
  closeMinute: number;
  isOvernight: boolean;
};

export type HoursIssue = { field: string; code: string; message: string };

/** A day may hold a morning, an afternoon and an evening service, and a spare. */
export const MAX_INTERVALS_PER_DAY = 4;

export const MINUTES_PER_DAY = 1440;

const DAY_NAMES = [
  'Chủ nhật',
  'Thứ hai',
  'Thứ ba',
  'Thứ tư',
  'Thứ năm',
  'Thứ sáu',
  'Thứ bảy',
] as const;

function dayName(day: number): string {
  return DAY_NAMES[day] ?? `Ngày ${day}`;
}

/**
 * An interval placed on an absolute minute-of-week line, so an overnight span
 * on Saturday and an early span on Sunday are comparable numbers rather than
 * two different special cases. The week wraps: Saturday 22:00 → 02:00 becomes
 * [9720, 10200) where the whole week is [0, 10080), and the caller normalizes
 * the wrap when it compares.
 */
export type WeekSpan = { index: number; start: number; end: number };

export function weekSpans(entries: HoursEntry[]): WeekSpan[] {
  const spans: WeekSpan[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'closed') return;
    if (entry.kind === 'open_24h') {
      const start = entry.dayOfWeek * MINUTES_PER_DAY;
      spans.push({ index, start, end: start + MINUTES_PER_DAY });
      return;
    }
    const start = entry.dayOfWeek * MINUTES_PER_DAY + entry.openMinute;
    const length = entry.isOvernight
      ? MINUTES_PER_DAY - entry.openMinute + entry.closeMinute
      : entry.closeMinute - entry.openMinute;
    spans.push({ index, start, end: start + length });
  });
  return spans;
}

const WEEK_MINUTES = 7 * MINUTES_PER_DAY;

/** Two spans on the wrapped week line share at least one minute. */
function overlaps(a: WeekSpan, b: WeekSpan): boolean {
  // Compare each span against the other in both the same-week and the
  // wrapped-week position, because a Saturday-night span runs past the end of
  // the line and lands back at Sunday 00:00.
  for (const shift of [-WEEK_MINUTES, 0, WEEK_MINUTES]) {
    if (a.start < b.end + shift && b.start + shift < a.end) return true;
  }
  return false;
}

/**
 * Every reason a week is not writable, as field errors that name the row the
 * editor has to go and fix. Returns [] when the week is valid; an empty week
 * is valid and means "no day is known".
 */
export function validateWeek(entries: HoursEntry[]): HoursIssue[] {
  const issues: HoursIssue[] = [];
  const byDay = new Map<number, number[]>();

  entries.forEach((entry, index) => {
    const field = `hours.${index}`;

    if (!Number.isInteger(entry.dayOfWeek) || entry.dayOfWeek < 0 || entry.dayOfWeek > 6) {
      issues.push({
        field: `${field}.dayOfWeek`,
        code: 'out_of_range',
        message: 'Ngày không hợp lệ',
      });
      return;
    }
    byDay.set(entry.dayOfWeek, [...(byDay.get(entry.dayOfWeek) ?? []), index]);

    if (entry.kind !== 'interval') {
      // The column check would reject these anyway; rejecting them here means
      // the editor gets a field path instead of a constraint-violation 500.
      if (entry.openMinute !== 0 || entry.closeMinute !== 0 || entry.isOvernight) {
        issues.push({
          field: `${field}.kind`,
          code: 'minutes_not_allowed',
          message:
            entry.kind === 'closed'
              ? 'Ngày đóng cửa không kèm khung giờ'
              : 'Mở cả ngày không kèm khung giờ',
        });
      }
      return;
    }

    for (const [name, value] of [
      ['openMinute', entry.openMinute],
      ['closeMinute', entry.closeMinute],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > MINUTES_PER_DAY - 1) {
        issues.push({
          field: `${field}.${name}`,
          code: 'out_of_range',
          message: 'Giờ phải trong khoảng 00:00–23:59',
        });
      }
    }

    if (entry.isOvernight) {
      // A span the editor called overnight but that ends later the same day is
      // not overnight — accepting it would store a wrap that is not there.
      if (entry.closeMinute > entry.openMinute) {
        issues.push({
          field: `${field}.isOvernight`,
          code: 'not_overnight',
          message: 'Khung giờ kết thúc trong ngày, bỏ đánh dấu qua đêm',
        });
      }
    } else if (entry.closeMinute <= entry.openMinute) {
      issues.push({
        field: `${field}.closeMinute`,
        code: 'not_after_open',
        message: 'Giờ đóng phải sau giờ mở, hoặc đánh dấu qua đêm',
      });
    }
  });

  for (const [day, indexes] of byDay) {
    const wholeDay = indexes.filter((i) => entries[i]!.kind !== 'interval');
    if (wholeDay.length > 0 && indexes.length > 1) {
      issues.push({
        field: `hours.${wholeDay[0]}.kind`,
        code: 'conflicting_day',
        message: `${dayName(day)} vừa có khung giờ vừa có trạng thái cả ngày`,
      });
    }
    if (indexes.length > MAX_INTERVALS_PER_DAY) {
      issues.push({
        field: `hours.${indexes[MAX_INTERVALS_PER_DAY]}`,
        code: 'too_many_intervals',
        message: `${dayName(day)} có quá ${MAX_INTERVALS_PER_DAY} ca`,
      });
    }
  }

  // Overlap is checked only when every row is individually sound: comparing
  // spans derived from a reversed or out-of-range interval produces confusing
  // extra errors on top of the real one.
  if (issues.length === 0) {
    const spans = weekSpans(entries);
    for (let i = 0; i < spans.length; i += 1) {
      for (let j = i + 1; j < spans.length; j += 1) {
        if (overlaps(spans[i]!, spans[j]!)) {
          const later = Math.max(spans[i]!.index, spans[j]!.index);
          issues.push({
            field: `hours.${later}`,
            code: 'overlapping',
            message: `${dayName(entries[later]!.dayOfWeek)} có hai ca trùng giờ`,
          });
        }
      }
    }
  }

  return issues;
}
