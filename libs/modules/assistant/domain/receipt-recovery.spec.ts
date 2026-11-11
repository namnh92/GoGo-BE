import { describe, expect, it } from 'vitest';
import {
  receiptRecoveryEligible,
  RECEIPT_RECOVERY_BACKOFF_SECONDS,
  RECEIPT_RECOVERY_MAX_GETS,
  RECEIPT_RECOVERY_WINDOW_SECONDS,
} from './receipt-recovery';

describe('#853 receipt recovery budget property', () => {
  it('a usage has at most five GET claims for any tick sequence, including jumps, duplicate ticks and restarts', () => {
    for (let seed = 1; seed <= 100; seed++) {
      let random = seed,
        attempts = 0,
        nextAt: number | null = null,
        now = 0;
      for (let tick = 0; tick < 300; tick++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        now += (random % 7 === 0 ? 0 : random % 600) * 1000;
        if (receiptRecoveryEligible(attempts, 0, nextAt, now)) {
          attempts++;
          nextAt =
            attempts < RECEIPT_RECOVERY_MAX_GETS
              ? now + RECEIPT_RECOVERY_BACKOFF_SECONDS[attempts]! * 1000
              : RECEIPT_RECOVERY_WINDOW_SECONDS * 1000;
        }
        expect(attempts).toBeLessThanOrEqual(RECEIPT_RECOVERY_MAX_GETS);
      }
      // Persisted attempts survive a restart or a due-time reset.
      for (let tick = 0; tick < 100; tick++) {
        if (receiptRecoveryEligible(attempts, 0, 0, now)) attempts++;
        expect(attempts).toBeLessThanOrEqual(RECEIPT_RECOVERY_MAX_GETS);
      }
    }
  });
  it('allows five spaced attempts within 24h; exhausted budget waits for quarantine', () => {
    let now = 0;
    for (let attempt = 0; attempt < RECEIPT_RECOVERY_MAX_GETS; attempt++) {
      now += RECEIPT_RECOVERY_BACKOFF_SECONDS[attempt]! * 1000;
      expect(receiptRecoveryEligible(attempt, 0, now, now)).toBe(true);
    }
    expect(now).toBeLessThan(RECEIPT_RECOVERY_WINDOW_SECONDS * 1000);
    expect(receiptRecoveryEligible(5, 0, 0, now)).toBe(false);
    expect(receiptRecoveryEligible(0, 0, null, 299999)).toBe(false);
    expect(receiptRecoveryEligible(0, 0, null, 86400000)).toBe(false);
  });
});
