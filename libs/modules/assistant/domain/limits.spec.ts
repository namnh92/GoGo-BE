import { describe, expect, it } from 'vitest';
import { decideAllowance, utcMonthStart, vnDayStart, vnNextReset } from './limits';

describe('assistant allowance (Q1)', () => {
  const limits = { dailyMessageLimit: 30, messagesPerMinuteLimit: 5 };

  it('the day starts at midnight Asia/Ho_Chi_Minh, as a UTC instant', () => {
    // 2026-10-27 23:30 VN = 16:30Z → the VN day began 2026-10-26T17:00Z.
    expect(vnDayStart(new Date('2026-10-27T16:30:00Z')).toISOString()).toBe(
      '2026-10-26T17:00:00.000Z',
    );
    // 2026-10-28 00:10 VN = 17:10Z → a new VN day.
    expect(vnDayStart(new Date('2026-10-27T17:10:00Z')).toISOString()).toBe(
      '2026-10-27T17:00:00.000Z',
    );
    expect(vnNextReset(new Date('2026-10-27T16:30:00Z')).toISOString()).toBe(
      '2026-10-27T17:00:00.000Z',
    );
  });

  it('month start is UTC', () => {
    expect(utcMonthStart(new Date('2026-10-27T16:30:00Z')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('accepts under both limits and reports what remains', () => {
    const d = decideAllowance(limits, { acceptedToday: 3, burstAcceptedAt: [] }, new Date());
    expect(d).toEqual({ ok: true, remainingToday: 27 });
  });

  it('a spent day is ASSISTANT_DAILY_LIMIT with Retry-After to the reset, checked before the burst', () => {
    const now = new Date('2026-10-27T16:30:00Z');
    const burst = Array.from({ length: 5 }, () => new Date(now.getTime() - 1_000));
    const d = decideAllowance(limits, { acceptedToday: 30, burstAcceptedAt: burst }, now);
    expect(d).toEqual({ ok: false, code: 'ASSISTANT_DAILY_LIMIT', retryAfterSeconds: 1800 });
  });

  it('a full rolling minute is RATE_LIMITED until the oldest counted send ages out', () => {
    const now = new Date('2026-10-27T10:00:00Z');
    const burst = [50, 40, 30, 20, 10].map((s) => new Date(now.getTime() - s * 1000));
    const d = decideAllowance(limits, { acceptedToday: 5, burstAcceptedAt: burst }, now);
    expect(d).toEqual({ ok: false, code: 'RATE_LIMITED', retryAfterSeconds: 10 });
  });

  it('a zero limit refuses (configured off is not unlimited)', () => {
    const d = decideAllowance(
      { dailyMessageLimit: 0, messagesPerMinuteLimit: 5 },
      { acceptedToday: 0, burstAcceptedAt: [] },
      new Date(),
    );
    expect(d.ok).toBe(false);
  });
});
