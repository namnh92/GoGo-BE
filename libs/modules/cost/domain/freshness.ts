/**
 * COST-BE-017 (#369) — epic §23, source freshness.
 *
 * A status is derived, never stored as truth on its own: the stored facts are
 * *when the source last succeeded*, *when it was last asked*, and *how many
 * times in a row it failed*. The status is what those facts mean at a given
 * `now`, so the same row reads FRESH this morning and STALE tonight without
 * anyone writing to it.
 *
 * MEASURED ZERO != NOT MEASURED. A source that is STALE has numbers on record
 * that were true when taken; the label changes, the numbers do not. A source
 * that is UNKNOWN has no numbers at all, and a report must show "—", not 0.
 */
export const FRESHNESS_STATUSES = ['FRESH', 'STALE', 'UNAVAILABLE', 'UNKNOWN'] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

export type FreshnessFacts = {
  lastSuccessfulAt: Date | null;
  lastAttemptAt: Date | null;
  staleAfterMs: number;
  consecutiveFailures: number;
};

/**
 * - never attempted → UNKNOWN
 * - attempted, never succeeded → UNAVAILABLE
 * - last attempt failed and the last success is already past `staleAfter` →
 *   UNAVAILABLE (nothing usable on record)
 * - last success within `staleAfter` → FRESH (even if the latest attempt
 *   failed: the number on record is still inside its trust window)
 * - otherwise → STALE
 */
export function freshnessStatus(facts: FreshnessFacts, now: Date): FreshnessStatus {
  if (facts.lastAttemptAt === null) return 'UNKNOWN';
  if (facts.lastSuccessfulAt === null) return 'UNAVAILABLE';
  const age = now.getTime() - facts.lastSuccessfulAt.getTime();
  if (age <= facts.staleAfterMs) return 'FRESH';
  return facts.consecutiveFailures > 0 ? 'UNAVAILABLE' : 'STALE';
}

/**
 * Bounded backoff between attempts after failures (epic §22 "no hot retry
 * loop"): the base frequency doubled per consecutive failure, capped at eight
 * times the frequency. A source that is down is re-asked later, not sooner.
 */
export function nextAttemptDelayMs(frequencyMs: number, consecutiveFailures: number): number {
  const factor = Math.min(8, 2 ** Math.max(0, consecutiveFailures));
  return frequencyMs * factor;
}
