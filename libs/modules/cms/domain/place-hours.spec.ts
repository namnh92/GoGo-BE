import { describe, expect, it } from 'vitest';
import { validateWeek, weekSpans, type HoursEntry } from './place-hours';

const interval = (
  dayOfWeek: number,
  openMinute: number,
  closeMinute: number,
  isOvernight = false,
): HoursEntry => ({ dayOfWeek, kind: 'interval', openMinute, closeMinute, isOvernight });

const wholeDay = (dayOfWeek: number, kind: 'closed' | 'open_24h'): HoursEntry => ({
  dayOfWeek,
  kind,
  openMinute: 0,
  closeMinute: 0,
  isOvernight: false,
});

describe('validateWeek', () => {
  it('accepts an empty week — no day is known', () => {
    expect(validateWeek([])).toEqual([]);
  });

  it('accepts one span applied to all seven days', () => {
    const week = [0, 1, 2, 3, 4, 5, 6].map((day) => interval(day, 8 * 60, 22 * 60));
    expect(validateWeek(week)).toEqual([]);
  });

  it('accepts two services on the same day', () => {
    expect(validateWeek([interval(1, 11 * 60, 14 * 60), interval(1, 17 * 60, 22 * 60)])).toEqual(
      [],
    );
  });

  it('accepts an overnight span and the next morning as separate rows', () => {
    // Fri 18:00 → Sat 02:00, then Sat 09:00 → 12:00. The overnight span lands
    // on Saturday's early minutes, which the morning span does not touch.
    expect(
      validateWeek([interval(5, 18 * 60, 2 * 60, true), interval(6, 9 * 60, 12 * 60)]),
    ).toEqual([]);
  });

  it('rejects a second span that starts inside the first', () => {
    const issues = validateWeek([interval(1, 8 * 60, 14 * 60), interval(1, 13 * 60, 20 * 60)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'hours.1', code: 'overlapping' });
  });

  it('rejects an overnight span colliding with the next day', () => {
    // Sat 22:00 → 03:00 runs into Sunday 01:00 → 05:00 across the week wrap.
    const issues = validateWeek([interval(6, 22 * 60, 3 * 60, true), interval(0, 60, 5 * 60)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'overlapping' });
  });

  it('rejects a close time that is not after the open time', () => {
    const issues = validateWeek([interval(2, 20 * 60, 9 * 60)]);
    expect(issues).toEqual([
      expect.objectContaining({ field: 'hours.0.closeMinute', code: 'not_after_open' }),
    ]);
  });

  it('rejects a same-day span flagged as overnight', () => {
    const issues = validateWeek([interval(2, 9 * 60, 17 * 60, true)]);
    expect(issues).toEqual([
      expect.objectContaining({ field: 'hours.0.isOvernight', code: 'not_overnight' }),
    ]);
  });

  it('accepts closed and open-around-the-clock days', () => {
    expect(validateWeek([wholeDay(0, 'closed'), wholeDay(6, 'open_24h')])).toEqual([]);
  });

  it('rejects a whole-day row that also carries minutes', () => {
    const issues = validateWeek([{ ...wholeDay(3, 'closed'), openMinute: 8 * 60 }]);
    expect(issues).toEqual([
      expect.objectContaining({ field: 'hours.0.kind', code: 'minutes_not_allowed' }),
    ]);
  });

  it('rejects a day that is both closed and open for a span', () => {
    const issues = validateWeek([wholeDay(4, 'closed'), interval(4, 9 * 60, 17 * 60)]);
    expect(issues).toEqual([
      expect.objectContaining({ field: 'hours.0.kind', code: 'conflicting_day' }),
    ]);
  });

  it('rejects an open-24h day that also carries a span', () => {
    const issues = validateWeek([wholeDay(4, 'open_24h'), interval(4, 9 * 60, 17 * 60)]);
    expect(issues).toEqual([expect.objectContaining({ code: 'conflicting_day' })]);
  });

  it('rejects a fifth service on one day', () => {
    const issues = validateWeek([
      interval(1, 60, 120),
      interval(1, 180, 240),
      interval(1, 300, 360),
      interval(1, 420, 480),
      interval(1, 540, 600),
    ]);
    expect(issues).toEqual([
      expect.objectContaining({ field: 'hours.4', code: 'too_many_intervals' }),
    ]);
  });

  it('rejects a minute outside the day', () => {
    const issues = validateWeek([interval(1, 0, 1440)]);
    expect(issues).toEqual([
      expect.objectContaining({ field: 'hours.0.closeMinute', code: 'out_of_range' }),
    ]);
  });

  it('rejects a day index outside 0..6', () => {
    const issues = validateWeek([interval(7, 60, 120)]);
    expect(issues).toEqual([
      expect.objectContaining({ field: 'hours.0.dayOfWeek', code: 'out_of_range' }),
    ]);
  });
});

describe('weekSpans', () => {
  it('places an open-24h day as a full day and drops closed days', () => {
    expect(weekSpans([wholeDay(1, 'open_24h'), wholeDay(2, 'closed')])).toEqual([
      { index: 0, start: 1440, end: 2880 },
    ]);
  });

  it('extends an overnight span past the end of its day', () => {
    // Sat (day 6) 23:00 → 01:00 = start 6*1440+1380, length 60 + 60.
    expect(weekSpans([interval(6, 23 * 60, 60, true)])).toEqual([
      { index: 0, start: 6 * 1440 + 1380, end: 6 * 1440 + 1380 + 120 },
    ]);
  });
});
