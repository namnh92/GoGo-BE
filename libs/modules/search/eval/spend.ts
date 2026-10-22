import type { IntentCallRecord } from '../application/intent-classification.service';

/**
 * GoGo-BE#709 — spend accounting for a live `eval:intent` run.
 *
 * Inverted on purpose (PR #710 review r1): a call counts as possibly billed
 * unless it provably never reached inference. A rejected answer
 * (`invalid_response`) arrived on a 200 and may have been charged, and an
 * outcome added later is billed until someone shows it is not — an allowlist
 * of billed outcomes is how one slipped through at $0.
 */
const NEVER_BILLED: ReadonlySet<IntentCallRecord['outcome']> = new Set([
  'disabled', // no request made
  'empty_request', // no request made
  'quota', // 402: rejected before inference
]);

const possiblyBilled = (c: IntentCallRecord) => !NEVER_BILLED.has(c.outcome);

/** Spend committed so far in USD: reported cost, else the per-call ceiling for a possibly billed call. */
export function committedSpendUsd(calls: IntentCallRecord[], unknownCallUsd: number): number {
  return calls.reduce((sum, c) => sum + (c.costUsd ?? (possiblyBilled(c) ? unknownCallUsd : 0)), 0);
}

/** Possibly billed calls whose cost was not reported — shown beside the sum, never folded in as $0. */
export function unknownCostCalls(calls: IntentCallRecord[]): number {
  return calls.filter((c) => c.costUsd === null && possiblyBilled(c)).length;
}
