/** Policy A: one durable GET budget per paid usage, shared by all calls.
 * First attempt waits 5m; subsequent delays are 15m, 1h, 4h, 12h after
 * the preceding claim. Missed ticks never catch up in a burst. A crash after
 * claim consumes the attempt. At 24h unknown cost quarantines, never zeroes.
 */
export const RECEIPT_RECOVERY_BACKOFF_SECONDS = [300, 900, 3600, 14400, 43200] as const;
export const RECEIPT_RECOVERY_MAX_GETS = RECEIPT_RECOVERY_BACKOFF_SECONDS.length;
export const RECEIPT_RECOVERY_WINDOW_SECONDS = 24 * 60 * 60;
export type ReceiptFinalityPolicy = 'inline_receipt_v1' | 'recovered_receipt_v1';

/** Evaluated with database time while the usage's account lock is held. */
export function receiptRecoveryEligible(
  attempts: number,
  acceptedAtMs: number,
  nextAtMs: number | null,
  nowMs: number,
): boolean {
  return (
    attempts >= 0 &&
    attempts < RECEIPT_RECOVERY_MAX_GETS &&
    nowMs < acceptedAtMs + RECEIPT_RECOVERY_WINDOW_SECONDS * 1000 &&
    nowMs >= (nextAtMs ?? acceptedAtMs + RECEIPT_RECOVERY_BACKOFF_SECONDS[0] * 1000)
  );
}
