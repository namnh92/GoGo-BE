import { describe, expect, it } from 'vitest';
import { quietHoursEnd, validTimezone } from './quiet-hours';
import { reminderDueAt } from '../../shared/reminder-schedule';

const end = (instant: string, timezone = 'Asia/Ho_Chi_Minh', enabled = true) =>
  quietHoursEnd(new Date(instant), { enabled, timezone })?.toISOString() ?? null;

describe('fixed opt-in local quiet window', () => {
  it('is off by default and never infers an absent timezone', () => {
    expect(end('2026-11-09T16:00:00Z', undefined, false)).toBeNull();
    expect(quietHoursEnd(new Date(), { enabled: false, timezone: null })).toBeNull();
  });
  it.each([
    ['2026-11-09T15:59:59.999Z', null],
    ['2026-11-09T16:00:00Z', '2026-11-10T00:00:00.000Z'],
    ['2026-11-09T23:59:59.999Z', '2026-11-10T00:00:00.000Z'],
    ['2026-11-10T00:00:00Z', null],
    ['2026-11-10T15:59:59Z', null],
  ])('VN boundary %s -> %s', (now, expected) => expect(end(now)).toBe(expected));
  it('crosses DST spring forward in seven real hours', () => {
    expect(end('2026-03-08T04:00:00Z', 'America/New_York')).toBe('2026-03-08T11:00:00.000Z');
  });
  it('crosses DST fall back in nine real hours, including both repeated hours', () => {
    for (const now of ['2026-11-01T03:00:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'])
      expect(end(now, 'America/New_York')).toBe('2026-11-01T12:00:00.000Z');
  });
  it('handles fractional-hour zones, UTC and date boundaries', () => {
    expect(end('2026-11-09T18:00:00Z', 'Asia/Kathmandu')).toBe('2026-11-10T01:15:00.000Z');
    expect(end('2026-11-09T23:00:00Z', 'UTC')).toBe('2026-11-10T07:00:00.000Z');
    expect(end('2026-11-09T10:00:00Z', 'Pacific/Kiritimati')).toBe('2026-11-09T17:00:00.000Z');
  });
  it.each(['Asia/Ho_Chi_Minh', 'America/New_York', 'Europe/London', 'UTC', 'Etc/GMT+3'])(
    'validates %s',
    (zone) => expect(validTimezone(zone)).toBe(true),
  );
  it.each(['Asia/Not_A_Zone', 'PST', '+07:00', '', '7', 'Europe/London\n'])('rejects %s', (zone) =>
    expect(validTimezone(zone)).toBe(false),
  );
});

describe('one 120-minute advance reminder', () => {
  const start = new Date('2026-11-09T12:00:00Z');
  it('schedules at start minus two hours regardless of server timezone', () => {
    expect(reminderDueAt(start, new Date('2026-11-09T09:59:59Z'))?.toISOString()).toBe(
      '2026-11-09T10:00:00.000Z',
    );
    expect(
      reminderDueAt(
        new Date('2026-11-09T19:00:00+07:00'),
        new Date('2026-11-09T05:00:00-05:00'),
      )?.toISOString(),
    ).toBe('2026-11-09T10:00:00.000Z');
  });
  it.each(['2026-11-09T10:00:00Z', '2026-11-09T11:59:59.999Z'])(
    'sends inside the window immediately at %s',
    (now) => {
      expect(reminderDueAt(start, new Date(now))?.getTime()).toBe(new Date(now).getTime());
    },
  );
  it('skips absent, exact-start and past schedules', () => {
    expect(reminderDueAt(null, start)).toBeNull();
    expect(reminderDueAt(start, start)).toBeNull();
    expect(reminderDueAt(start, new Date(start.getTime() + 1))).toBeNull();
  });
});
