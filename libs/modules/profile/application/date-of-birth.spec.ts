import { afterEach, describe, expect, it, vi } from 'vitest';
import { profilePatchSchema } from '../presentation/dtos';
import { isAfterTodayInVietnam, isCalendarDate, todayInVietnam } from './date-of-birth';

describe('date of birth is a calendar date (PROF-BE-013 #573)', () => {
  it('accepts real dates, leap days included', () => {
    for (const value of ['1990-05-17', '2024-02-29', '2000-02-29', '0001-01-01', '1999-12-31']) {
      expect(isCalendarDate(value), value).toBe(true);
    }
  });

  it('refuses dates that do not exist and anything not YYYY-MM-DD', () => {
    for (const value of [
      '2027-02-29',
      '1900-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '1990-04-31',
      '0000-01-01',
      '1990-5-17',
      '17/05/1990',
      '1990-05-17T00:00:00Z',
      ' 1990-05-17',
      '',
      '99999-01-01',
    ]) {
      expect(isCalendarDate(value), value).toBe(false);
    }
  });

  it('reads today in Asia/Ho_Chi_Minh, which turns over at 17:00 UTC', () => {
    expect(todayInVietnam(new Date('2026-09-14T16:59:59.999Z'))).toBe('2026-09-14');
    expect(todayInVietnam(new Date('2026-09-14T17:00:00.000Z'))).toBe('2026-09-15');
    expect(todayInVietnam(new Date('2026-12-31T17:00:00.000Z'))).toBe('2027-01-01');
  });

  it('a date after today there is the future; today itself is not', () => {
    const lateEvening = new Date('2026-09-14T16:30:00.000Z'); // 23:30 in Hanoi
    expect(isAfterTodayInVietnam('2026-09-14', lateEvening)).toBe(false);
    expect(isAfterTodayInVietnam('2026-09-15', lateEvening)).toBe(true);
    const earlyMorning = new Date('2026-09-14T17:30:00.000Z'); // 00:30 the next day there
    expect(isAfterTodayInVietnam('2026-09-15', earlyMorning)).toBe(false);
    expect(isAfterTodayInVietnam('2026-09-16', earlyMorning)).toBe(true);
  });
});

describe('PATCH /me dateOfBirth validation (PROF-BE-013 #573)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const issues = (payload: unknown) => {
    const result = profilePatchSchema.safeParse(payload);
    return result.success ? [] : result.error.issues.map((i) => [i.path.join('.'), i.code]);
  };

  it('omitted keeps, null clears, a real past date sets', () => {
    expect(profilePatchSchema.parse({})).toEqual({});
    expect(profilePatchSchema.parse({ dateOfBirth: null })).toEqual({ dateOfBirth: null });
    expect(profilePatchSchema.parse({ dateOfBirth: '2024-02-29' })).toEqual({
      dateOfBirth: '2024-02-29',
    });
  });

  it('names the reason: invalid_date for a date that does not exist, too_big for the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T17:30:00.000Z')); // 2026-09-15 in Hanoi
    expect(issues({ dateOfBirth: '2027-02-29' })).toEqual([['dateOfBirth', 'invalid_date']]);
    expect(issues({ dateOfBirth: '2026-13-01' })).toEqual([['dateOfBirth', 'invalid_date']]);
    expect(issues({ dateOfBirth: '1990-5-17' })).toEqual([['dateOfBirth', 'invalid_date']]);
    expect(issues({ dateOfBirth: '2026-09-16' })).toEqual([['dateOfBirth', 'too_big']]);
    // UTC already says the 14th, Hanoi says the 15th: the 15th is today, not the future.
    expect(issues({ dateOfBirth: '2026-09-15' })).toEqual([]);
    expect(issues({ dateOfBirth: 19900517 })).toEqual([['dateOfBirth', 'invalid_type']]);
  });
});
