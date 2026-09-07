import type { CurrentMapping } from './resolver';

/**
 * ADM-006 (#459) — is a stored mapping still true against the active dataset?
 *
 * Evaluation only. Nothing here writes, and in particular nothing here writes
 * `STALE`: publication does not set it (ADM-005), and the resolver does not set
 * it on a reviewer-owned row. The verdict is returned so #461's backfill and
 * #462's approval policy can decide what to do with it — including the case
 * this function exists to make visible, a `VERIFIED` place whose commune no
 * longer exists, where the right answer is a person and never a silent remap.
 *
 * The distinction that matters is between a mapping that is *labelled* with an
 * older dataset version and one that is *invalidated* by the new one. The first
 * is the normal state of the catalogue between publications and must not raise
 * an alarm; the second is a real defect. Only the codes can tell them apart,
 * which is why the stored version alone is never the test.
 */

export type StaleReason =
  | 'NO_MAPPING'
  | 'CURRENT'
  | 'REVALIDATED'
  | 'UNIT_NOT_IN_ACTIVE_DATASET'
  | 'UNIT_NOT_CURRENT'
  | 'HIERARCHY_CHANGED';

export type ActiveUnit = {
  code: string;
  parentCode: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'FUTURE';
  effectiveTo: string | null;
};

export type StaleVerdict = {
  stale: boolean;
  reason: StaleReason;
  /** True when a person owns this row, so persistence is never automatic. */
  reviewerOwned: boolean;
  requiresReview: boolean;
  storedDatasetVersion: string | null;
  activeDatasetVersion: string;
};

export function evaluateStaleness(input: {
  current: CurrentMapping;
  activeDatasetVersion: string;
  /** The stored commune code, looked up in the **active** dataset. */
  unit: ActiveUnit | null;
}): StaleVerdict {
  const { current, activeDatasetVersion, unit } = input;
  const reviewerOwned = current.status === 'VERIFIED' || current.status === 'REJECTED';
  const base = {
    reviewerOwned,
    storedDatasetVersion: current.datasetVersion,
    activeDatasetVersion,
  };

  if (current.status === 'UNMAPPED' || !current.communeCode) {
    return { ...base, stale: false, reason: 'NO_MAPPING', requiresReview: false };
  }
  if (!unit) {
    return {
      ...base,
      stale: true,
      reason: 'UNIT_NOT_IN_ACTIVE_DATASET',
      requiresReview: true,
    };
  }
  if (unit.status !== 'ACTIVE' || unit.effectiveTo !== null) {
    return { ...base, stale: true, reason: 'UNIT_NOT_CURRENT', requiresReview: true };
  }
  if (current.provinceCode !== null && unit.parentCode !== current.provinceCode) {
    // The commune survived but moved provinces — or the stored pair came from
    // two different releases. Either way the pair is not a pair any more.
    return { ...base, stale: true, reason: 'HIERARCHY_CHANGED', requiresReview: true };
  }
  return {
    ...base,
    stale: false,
    // Still true, just labelled with an older release. Re-stamping the version
    // is a write, and a write on a reviewer-owned row is not this function's
    // to make — so it is reported, not performed.
    reason: current.datasetVersion === activeDatasetVersion ? 'CURRENT' : 'REVALIDATED',
    requiresReview: false,
  };
}
