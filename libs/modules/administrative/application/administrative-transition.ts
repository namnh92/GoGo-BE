/**
 * ADM-005 (#458) / #482 — the serialisation point for every write that changes
 * a dataset's lifecycle status.
 *
 * Publish, rollback and validate all take this one key. Publish and rollback
 * because there must never be two active versions and never zero; validate
 * because it writes `publishable ? VALIDATED : STAGED` and would otherwise be
 * free to demote a version another transition had just promoted.
 *
 * It lives in its own module because the publication service already depends on
 * the validation service, so neither can own a constant the other must match —
 * and a lock key the three paths agree on only by coincidence is not a lock.
 */

/** Arbitrary and permanent. What matters is that all three paths take the same one. */
export const TRANSITION_LOCK = 4_580_019;

/**
 * A transition that cannot get its row locks quickly is competing with
 * something it should not be competing with. Failing is better than holding the
 * advisory lock — and every other writer — behind it.
 */
export const TRANSITION_LOCK_TIMEOUT = '5s';
