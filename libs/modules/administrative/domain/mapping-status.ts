/**
 * ADM-006 (#459) / ADR-0019 §7 — which mapping statuses an automatic run may
 * write, and which belong to a person.
 *
 * The matrix exists because the resolver runs unattended, in bulk, and will run
 * again after every dataset publication. Without it, the second run quietly
 * overwrites the first reviewer's work: a place someone looked at, judged, and
 * marked `VERIFIED` is exactly the place a fresh boundary release is most likely
 * to disagree with, and "the machine had newer data" is not a reason to discard
 * a human decision that was made *because* the machine was wrong.
 *
 * So `VERIFIED` and `REJECTED` are reviewer-owned. The resolver may report that
 * a `VERIFIED` mapping no longer matches the active dataset — that is what
 * `evaluateStaleness` is for — but it may not act on it.
 */

export type MappingStatus =
  'UNMAPPED' | 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'VERIFIED' | 'REJECTED' | 'STALE';

export type MappingMethod =
  | 'editor'
  | 'trusted_code'
  | 'structured_components'
  | 'components_with_coordinates'
  | 'boundary_point_in_polygon'
  | 'exact_name'
  | 'change_mapping'
  | 'fuzzy_suggestion';

/** Statuses an unattended resolver run may move a place *into*, by current status. */
const AUTOMATIC: Readonly<Record<MappingStatus, readonly MappingStatus[]>> = {
  UNMAPPED: ['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW'],
  // A machine mapping may be replaced by a better machine mapping, sent for
  // review, or demoted when its evidence disappears — geometry nulled, a unit
  // dissolved. All three are the machine correcting itself.
  AUTO_MATCHED: ['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW'],
  // A queue state, not a decision: nobody has ruled on it, so a later run that
  // finds decisive evidence is allowed to resolve it.
  NEEDS_REVIEW: ['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW'],
  // Set by the staleness workflows (#461/#462) to mean "known invalid, not yet
  // re-resolved". Re-resolving it is the whole point.
  STALE: ['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW', 'STALE'],
  // Reviewer-owned. Never downgraded, never overwritten, never re-pointed.
  VERIFIED: ['VERIFIED'],
  // Reviewer-owned. A rejection is a judgement that this place should not carry
  // this mapping; re-deriving it on the next run would be arguing with them.
  REJECTED: ['REJECTED'],
};

/**
 * `REJECTED` is the one reviewer-owned state with a documented way back, and it
 * needs an explicit action to open it — a reviewer asking for a rematch, never
 * a scheduled run deciding on its own.
 */
const REMATCHABLE: readonly MappingStatus[] = ['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW'];

export type TransitionDecision =
  | { allowed: true; status: MappingStatus }
  | { allowed: false; status: MappingStatus; reason: 'REVIEWER_OWNED' };

/**
 * Decides what an automatic run may actually write.
 *
 * Returns the status that stands afterwards either way, so a caller cannot
 * accidentally apply a refused transition by ignoring a boolean.
 */
export function applyAutomaticTransition(
  current: MappingStatus,
  proposed: MappingStatus,
  options: { allowRematchRejected?: boolean } = {},
): TransitionDecision {
  const allowed =
    current === 'REJECTED' && options.allowRematchRejected
      ? [...AUTOMATIC.REJECTED, ...REMATCHABLE]
      : AUTOMATIC[current];
  if (allowed.includes(proposed)) return { allowed: true, status: proposed };
  return { allowed: false, status: current, reason: 'REVIEWER_OWNED' };
}

/** True when a person owns this row's status and an unattended run must not touch it. */
export function isReviewerOwned(status: MappingStatus): boolean {
  return status === 'VERIFIED' || status === 'REJECTED';
}

/**
 * Who is recorded as responsible for the mapping a row currently carries.
 *
 * `administrative_mapped_by` is the reviewer behind the *current* decision, not
 * a history of everyone who ever touched the row — the history is the audit
 * log, which keeps every one of them. So the identity survives exactly as long
 * as the decision does.
 *
 * An ordinary automatic run never reaches a reviewer-owned row at all. The one
 * case that does is an explicit, authorised rematch of `REJECTED`: it replaces
 * the reviewer's decision with a machine one, and leaving their id attached
 * would credit a person for an answer they never gave — and, worse, make the
 * row read as reviewed to anything that keys on the column being set.
 */
export function clearsReviewerAttribution(from: MappingStatus, to: MappingStatus): boolean {
  return isReviewerOwned(from) && !isReviewerOwned(to);
}
