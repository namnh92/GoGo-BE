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

export type SpendSettings = { maxUsd: number; unknownCallUsd: number };

/**
 * Read the spend ceiling of a live run, refusing anything unusable (PR #710
 * review r2). `0,05` is NaN and an empty string is 0: either would let a paid
 * run go through the whole dataset, so both are errors, never defaults.
 */
export function parseSpendSettings(env: Record<string, string | undefined>): SpendSettings {
  const read = (name: string, fallback: string, ok: (n: number) => boolean, rule: string) => {
    const raw = env[name] ?? fallback;
    const n = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name}="${raw}" is not ${rule}`);
    return n;
  };
  return {
    maxUsd: read(
      'INTENT_EVAL_MAX_USD',
      '0.05',
      (n) => n >= 0,
      'a non-negative USD amount like 0.05',
    ),
    unknownCallUsd: read(
      'INTENT_EVAL_UNKNOWN_CALL_USD',
      '0.001',
      (n) => n > 0,
      'a positive USD amount like 0.001',
    ),
  };
}
