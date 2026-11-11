import { describe, expect, it } from 'vitest';
import {
  costCredits,
  reserveCredits,
  reviseCredits,
  assertCreditAmounts,
  CREDIT_INT_MAX,
} from './credit-cost';
describe('#851 D02 exact cost conversion', () => {
  it.each([
    ['0', 0],
    ['0.00000001', 1],
    ['0.00001', 1],
    ['0.00001001', 2],
    ['0.000000000000000001', 1],
  ])('%s USD -> %i credits', (usd, credits) => expect(costCredits([usd])).toBe(credits));
  it('sums before ceiling and retains precision beyond 8 decimal places', () => {
    expect(costCredits(['0.000004', '0.000004'])).toBe(1);
    expect(costCredits(['0.000009999999999999', '0.000000000000000002'])).toBe(2);
    expect(reserveCredits('0.000000000001')).toBe(1);
  });
  it.each(['-1', 'NaN', 'Infinity', '1e-5', '', ' 0.1', '0.', '00.1', '21474.83648'])(
    'rejects invalid/overflow %s',
    (s) => expect(() => costCredits([s])).toThrow(RangeError),
  );
  it('zero is a valid actual cost but never a positive bound', () => {
    expect(() => reserveCredits('0')).toThrow(RangeError);
    expect(costCredits(['21474.83647'])).toBe(CREDIT_INT_MAX);
  });
  it('R20 -> 12 -> 14 -> 10 -> final releases only residual hold', () => {
    let p = { ceiling: 20, held: 20, applied: 0, finalized: false };
    for (const [target, delta, held] of [
      [12, -12, 8],
      [14, -2, 6],
      [10, 4, 10],
    ]) {
      const n = reviseCredits(p, target!, false);
      expect(n).toMatchObject({ delta, held });
      p = n;
    }
    expect(reviseCredits(p, 10, true)).toMatchObject({
      delta: 0,
      held: 0,
      applied: 10,
      finalized: true,
    });
    expect(
      reviseCredits({ ceiling: 20, held: 0, applied: 10, finalized: true }, 4, false),
    ).toMatchObject({ delta: 6, held: 0 });
    expect(() =>
      reviseCredits({ ceiling: 20, held: 0, applied: 10, finalized: true }, 11, true),
    ).toThrow();
    expect(() => reviseCredits(p, 21, false)).toThrow();
  });
  it('generated decimal partitions equal one ceiling over the exact sum', () => {
    let seed = 851;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      const a = BigInt(next() % 10000000),
        b = BigInt(next() % 10000000);
      const usd = (n: bigint) => '0.' + n.toString().padStart(12, '0');
      expect(costCredits([usd(a), usd(b)])).toBe(Number((a + b + 9999999n) / 10000000n));
    }
  });
  it('generated revision sequences preserve wallet=ledger, available and H+A=R; refunds are not grants', () => {
    let seed = 832;
    for (let i = 0; i < 200; i++) {
      const R = 20 + i,
        initial = R + 50;
      let balance = initial,
        ledger = initial;
      let p = { ceiling: R, held: R, applied: 0, finalized: false };
      for (let j = 0; j < 80; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        const n = reviseCredits(p, seed % (R + 1), false);
        balance += n.delta;
        ledger += n.delta;
        expect(balance).toBe(ledger);
        expect(balance - n.held).toBe(initial - R);
        expect(n.applied + n.held).toBe(R);
        assertCreditAmounts(n);
        p = n;
      }
      const final = reviseCredits(p, p.applied, true);
      expect(balance - final.held).toBe(balance);
      const refund = reviseCredits(final, 0, true);
      expect(refund.delta).toBe(final.applied);
    }
  });
});
