import { describe, expect, it } from 'vitest';
import {
  TURN_CALL_SHARE,
  callFits,
  decideAllowance,
  utcMonthStart,
  vnDayStart,
  vnNextReset,
} from './limits';

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

  it('a full burst still refuses when the daily allowance is spent', () => {
    const now = new Date('2026-10-27T16:30:00Z');
    const burst = Array.from({ length: 5 }, () => new Date(now.getTime() - 1_000));
    const d = decideAllowance(limits, { acceptedToday: 30, burstAcceptedAt: burst }, now);
    expect(d).toEqual({ ok: false, code: 'RATE_LIMITED', retryAfterSeconds: 59 });
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

describe('#738 D-11 remaining-call-fit', () => {
  const C = 0.005;
  it('at 0.9C a call of 0.2C is skipped, one of 0.05C runs', () => {
    const at = { knownUsd: 0.9 * C, inFlightUnknown: false, ceilingUsd: C };
    expect(callFits({ ...at, worstCaseUsd: 0.2 * C })).toBe(false);
    expect(callFits({ ...at, worstCaseUsd: 0.05 * C })).toBe(true);
  });
  it('a call in flight counts as the whole ceiling', () => {
    expect(
      callFits({ knownUsd: 0, inFlightUnknown: true, worstCaseUsd: 0.01 * C, ceilingUsd: C }),
    ).toBe(false);
  });
  it('the shares add up to the worst-case turn: two decisions, one relevance, one compose', () => {
    const { decision, relevance, compose } = TURN_CALL_SHARE;
    expect(2 * decision + relevance + compose).toBeCloseTo(1, 2);
  });
});
