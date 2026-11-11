/** Exact USD strings only. Sum components before rounding to 0.00001 USD. */
export const CREDIT_INT_MAX = 2_147_483_647;
export function costCredits(amounts: readonly string[]): number {
  const parts = amounts.map((value) => {
    if (value.length > 1000 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
      throw new RangeError('Invalid billing decimal');
    const [whole, fraction = ''] = value.split('.');
    return { units: BigInt(whole! + fraction), scale: fraction.length };
  });
  const scale = Math.max(5, ...parts.map((p) => p.scale));
  const sum = parts.reduce((total, p) => total + p.units * 10n ** BigInt(scale - p.scale), 0n);
  const divisor = 10n ** BigInt(scale - 5);
  const credits = (sum + divisor - 1n) / divisor;
  if (credits > BigInt(CREDIT_INT_MAX)) throw new RangeError('Billing credit overflow');
  return Number(credits);
}
export function reserveCredits(bound: string): number {
  const credits = costCredits([bound]);
  if (!credits) throw new RangeError('Billing bound must be positive');
  return Math.max(1, credits);
}
export type CreditAmounts = { ceiling: number; held: number; applied: number; finalized: boolean };
export function assertCreditAmounts(a: CreditAmounts): void {
  if (
    ![a.ceiling, a.held, a.applied].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= CREDIT_INT_MAX,
    ) ||
    a.applied > a.ceiling ||
    (a.finalized ? a.held !== 0 : a.held + a.applied !== a.ceiling)
  )
    throw new RangeError('Invalid credit funding invariant');
}
/** Complete authoritative aggregate target, never a rounded cost difference. */
export function reviseCredits(previous: CreditAmounts, target: number, final: boolean) {
  assertCreditAmounts(previous);
  if (
    !Number.isInteger(target) ||
    target < 0 ||
    target > previous.ceiling ||
    (previous.finalized && target > previous.applied)
  )
    throw new RangeError('Billing bound/finality violation');
  const finalized = previous.finalized || final;
  const next = {
    ceiling: previous.ceiling,
    applied: target,
    held: finalized ? 0 : previous.ceiling - target,
    finalized,
  };
  assertCreditAmounts(next);
  return { ...next, delta: previous.applied - target };
}

/** Public quantities must survive JSON without loss. Unknown attribution stays null. */
export function assertPublicCredits(values: readonly (number | null)[]): void {
  if (values.some((n) => n !== null && (!Number.isSafeInteger(n) || n < 0)))
    throw new RangeError('Unsafe public credit quantity');
}
