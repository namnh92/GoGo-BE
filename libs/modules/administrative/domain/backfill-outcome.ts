import type { MappingStatus } from './mapping-status';
import type { Resolution, ResolverReason } from './resolver';

/**
 * ADM-008 (#461) — how one place's result is counted.
 *
 * Pure, and separate from the job loop, because the counters are what a
 * reviewer reads afterwards and what a dry run promises. A bucket assigned in
 * the middle of a batch loop is a bucket that quietly changes meaning the next
 * time the loop is edited.
 *
 * The distinction that matters most is between **protected** and **no-op**. A
 * `VERIFIED` place that the resolver would have re-pointed is not "nothing
 * happened" — it is the safety rule doing its job, and it is the number that
 * tells an operator how much of the catalogue an unattended run is not allowed
 * to touch.
 */

export type BackfillOutcome =
  | 'written'
  | 'noop'
  | 'protected_verified'
  | 'protected_rejected'
  | 'conflict'
  | 'failure'
  | 'would_write';

export type BackfillCounters = {
  /** Rows the cursor walked. */
  scanned: number;
  /** Rows that passed the eligibility policy and were resolved. */
  eligible: number;
  written: number;
  /** Would have been written, had this not been a dry run. */
  wouldWrite: number;
  noop: number;
  autoMatched: number;
  needsReview: number;
  unmapped: number;
  protectedVerified: number;
  protectedRejected: number;
  conflicts: number;
  failures: number;
  /** Skipped by selection: already resolved against these exact versions. */
  alreadyCurrent: number;
};

export function emptyCounters(): BackfillCounters {
  return {
    scanned: 0,
    eligible: 0,
    written: 0,
    wouldWrite: 0,
    noop: 0,
    autoMatched: 0,
    needsReview: 0,
    unmapped: 0,
    protectedVerified: 0,
    protectedRejected: 0,
    conflicts: 0,
    failures: 0,
    alreadyCurrent: 0,
  };
}

/**
 * Which bucket a persisted outcome belongs in.
 *
 * `blocked` is split by the status that blocked it, because "the resolver was
 * refused" is not one fact: a protected `VERIFIED` row is the policy working,
 * and a protected `REJECTED` row is a reviewer's decision standing.
 */
export function classify(
  outcome: 'written' | 'noop' | 'conflict' | 'blocked',
  currentStatus: MappingStatus,
): BackfillOutcome {
  if (outcome === 'blocked') {
    return currentStatus === 'VERIFIED' ? 'protected_verified' : 'protected_rejected';
  }
  return outcome;
}

export function count(counters: BackfillCounters, outcome: BackfillOutcome): void {
  switch (outcome) {
    case 'written':
      counters.written += 1;
      break;
    case 'would_write':
      counters.wouldWrite += 1;
      break;
    case 'noop':
      counters.noop += 1;
      break;
    case 'protected_verified':
      counters.protectedVerified += 1;
      break;
    case 'protected_rejected':
      counters.protectedRejected += 1;
      break;
    case 'conflict':
      counters.conflicts += 1;
      break;
    case 'failure':
      counters.failures += 1;
      break;
  }
}

/**
 * The resolver's answer, counted by what it decided rather than by what was
 * written. A dry run and an execute run must produce the same numbers here —
 * that is the whole basis on which a dry run is evidence about the execute.
 */
export function countResolution(counters: BackfillCounters, resolution: Resolution): void {
  if (resolution.status === 'AUTO_MATCHED') counters.autoMatched += 1;
  else if (resolution.status === 'NEEDS_REVIEW') counters.needsReview += 1;
  else if (resolution.status === 'UNMAPPED') counters.unmapped += 1;
}

export type BackfillSample = {
  placeId: string;
  outcome: BackfillOutcome;
  status: MappingStatus;
  communeCode: string | null;
  reason: ResolverReason | null;
};
