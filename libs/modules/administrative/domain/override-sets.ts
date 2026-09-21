import type { Refusal } from './publication-gates';

/**
 * ADM-011 (#484) / ADR-0019 — what a reviewer decision about the advisory
 * mapping source is allowed to do.
 *
 * The 1,033 quarantined rows are divided communes. ADR-0019 forbids guessing
 * which successor one became, so a person decides — and the decision must not
 * edit the pinned snapshot, must not touch a published dataset, and must not
 * change what the resolver answers the moment it is taken.
 *
 * Everything here is a pure function of facts the server re-read for itself
 * under lock. Nothing a client sends reaches a decision except the target it
 * names, the reason it gives, and the revision it believed it was deciding
 * against — and that last one exists precisely so two reviewers working the
 * same row cannot silently overwrite each other.
 */

export type OverrideSetStatus = 'DRAFT' | 'MATERIALIZED' | 'ABANDONED';
export type DecisionKind = 'ACCEPT' | 'REJECT';

/**
 * What the queue filter calls a row, derived from its effective decision.
 *
 * `MATERIALIZED_*` is a fact of the dataset version, not of a draft set: the
 * row's decision was carried into this version by a materialisation and
 * nothing a reviewer does in a later draft un-settles it — a new decision on
 * such a row is a re-decision, and the queue then reports that draft state.
 */
export type DecisionState =
  | 'UNDECIDED'
  | 'ACCEPTED_DRAFT'
  | 'REJECTED_DRAFT'
  | 'SUPERSEDED'
  | 'MATERIALIZED_ACCEPT'
  | 'MATERIALIZED_REJECT'
  /*
   * Another row of the same source carried the decision: this version already
   * names a successor for the source, so this row asks a question that has
   * been answered. Not actionable, and not in the backlog.
   */
  | 'SOURCE_SETTLED';

export type OverrideSet = {
  id: string;
  baseDatasetId: string;
  revision: number;
  status: OverrideSetStatus;
};

/**
 * Whether this set may still be decided against, and whether the caller was
 * looking at the revision it is now.
 *
 * The revision check is the whole concurrency story. It is not optimistic
 * locking over a row a reviewer edited — decisions are appended, never edited —
 * it is "the set you read is the set you are deciding against". Two reviewers
 * accepting different targets for the same row a second apart both succeed
 * under a naive design, and the second silently wins; here the second is told
 * the set moved and re-reads it.
 */
export function decisionRefusal(set: OverrideSet, expectedRevision: number): Refusal | null {
  if (set.status !== 'DRAFT') {
    return {
      code: 'OVERRIDE_SET_NOT_DRAFT',
      message: `override set is ${set.status}; only a DRAFT set accepts decisions`,
    };
  }
  if (set.revision !== expectedRevision) {
    return {
      code: 'OVERRIDE_SET_REVISION_CONFLICT',
      message:
        `the override set moved to revision ${set.revision} while you were deciding ` +
        `against ${expectedRevision}; re-read it — somebody else decided a row`,
    };
  }
  return null;
}

/** The quarantine row a decision names, as re-read from the database. */
export type QuarantineRef = {
  id: string;
  datasetVersionId: string;
  oldCode: string | null;
};

/**
 * The unit a reviewer chose, as re-read from the base dataset's own current
 * component. Null when nothing in that dataset carries the named identity.
 */
export type TargetUnit = {
  code: string;
  effectiveFrom: string;
  level: string;
  status: string;
  parentCode: string | null;
} | null;

export type AcceptInput = {
  set: OverrideSet;
  row: QuarantineRef;
  target: TargetUnit;
  /** Codes of every province in the base dataset, for the hierarchy check. */
  parentExists: boolean;
  /** Whether this exact edge is already asserted canonically in the base. */
  edgeAlreadyCanonical: boolean;
  /**
   * The successor a reviewer override in the base already names for this
   * source, whichever quarantine row it was decided on. One source has one
   * successor (ADR-0019 §3a-0), so a second target is a contradiction the
   * validation gate would refuse later — this refuses it now, with the reason.
   */
  sourceOverride: { targetCode: string; sourceVersion: string } | null;
  /** An effective ACCEPT this draft already holds on another row of the same source. */
  siblingAccept: { quarantineRowId: string; targetCode: string } | null;
};

/**
 * Returns the reason this row may not be accepted onto this target, or null.
 *
 * The target is named, never positional. A reviewer who accepts "candidate 0"
 * has not decided anything — the upstream's default target for a divided
 * commune is exactly the guess ADR-0019 refuses, and offering it as a default
 * would launder that guess through a person's click.
 */
export function acceptRefusal(input: AcceptInput): Refusal | null {
  if (input.row.datasetVersionId !== input.set.baseDatasetId) {
    return {
      code: 'QUARANTINE_ROW_NOT_IN_DATASET',
      message: 'that quarantined row belongs to a different dataset version',
    };
  }
  if (!input.row.oldCode) {
    return {
      code: 'QUARANTINE_ROW_HAS_NO_SOURCE',
      message:
        'the advisory row names no source unit, so there is no edge to accept; reject it instead',
    };
  }
  if (!input.target) {
    return {
      code: 'OVERRIDE_TARGET_NOT_FOUND',
      message:
        'no unit with that code and effective date exists in this dataset; ' +
        'a code alone is not an identity, and the one you named is not in this version',
    };
  }
  if (input.target.level !== 'COMMUNE') {
    return {
      code: 'OVERRIDE_TARGET_NOT_CURRENT',
      message: `the target is a ${input.target.level}; a divided commune becomes a commune`,
    };
  }
  if (input.target.status !== 'ACTIVE') {
    return {
      code: 'OVERRIDE_TARGET_NOT_CURRENT',
      message: `the target is ${input.target.status}; only an ACTIVE unit can be a successor`,
    };
  }
  if (!input.target.parentCode || !input.parentExists) {
    return {
      code: 'OVERRIDE_TARGET_HIERARCHY_INVALID',
      message:
        `the target's province ${input.target.parentCode ?? '(none)'} does not resolve in ` +
        'this dataset; accepting it would assert a commune under a province that is not there',
    };
  }
  if (input.target.code === input.row.oldCode) {
    return {
      code: 'OVERRIDE_TARGET_IS_SOURCE',
      message: 'the target is the source unit itself, which asserts nothing',
    };
  }
  if (input.edgeAlreadyCanonical) {
    return {
      code: 'OVERRIDE_EDGE_ALREADY_CANONICAL',
      message:
        `${input.row.oldCode} → ${input.target.code} is already a canonical edge in this ` +
        'dataset; there is nothing for an override to add',
    };
  }
  /*
   * The decision is taken on a row, but the fact it asserts is about the
   * source: 1,033 advisory rows describe 471 divided communes, and a commune
   * has one successor in the resolver whatever the source proposed. So a
   * source that a reviewer already sent somewhere — in this base, or on
   * another row of this draft — cannot be sent somewhere else from here.
   */
  if (input.sourceOverride && input.sourceOverride.targetCode !== input.target.code) {
    return {
      code: 'OVERRIDE_SOURCE_ALREADY_RESOLVED',
      message:
        `${input.row.oldCode} already resolves to ${input.sourceOverride.targetCode} through a ` +
        `reviewer override (${input.sourceOverride.sourceVersion}); one source has one ` +
        'successor, so retract that override in a later round before naming another',
    };
  }
  if (input.siblingAccept) {
    if (input.siblingAccept.targetCode !== input.target.code) {
      return {
        code: 'OVERRIDE_SOURCE_CONFLICT_IN_DRAFT',
        message:
          `this draft already accepts ${input.row.oldCode} → ${input.siblingAccept.targetCode} on ` +
          `another row of the same source (${input.siblingAccept.quarantineRowId}); decide the ` +
          'source once — supersede that decision, or reject this row',
      };
    }
    return {
      code: 'OVERRIDE_SOURCE_ALREADY_DECIDED_IN_DRAFT',
      message:
        `this draft already accepts ${input.row.oldCode} → ${input.target.code} on another row ` +
        `of the same source (${input.siblingAccept.quarantineRowId}); that decision covers the ` +
        'source, and a second one would write the same edge twice',
    };
  }
  return null;
}

/** What materialisation needs to know about the base it is deriving from. */
export type MaterializeInput = {
  set: OverrideSet;
  expectedRevision: number;
  /** Effective decisions only — superseded ones do not count towards anything. */
  effectiveDecisions: number;
  /** The base dataset's identity, re-read under lock. */
  base: { id: string; status: string; combinedChecksum: string; overrideRevision: number };
  /** The checksum the base carried when the set was opened. */
  baseChecksumAtOpen: string;
};

/**
 * Returns the reason this set may not be materialised, or null.
 *
 * Materialisation is the only act in this feature that produces something the
 * resolver will eventually answer from, so it is the only one that has to care
 * about the base still being the base.
 */
export function materializeRefusal(input: MaterializeInput): Refusal | null {
  if (input.set.status !== 'DRAFT') {
    return {
      code: 'OVERRIDE_SET_NOT_DRAFT',
      message: `override set is ${input.set.status}; only a DRAFT set can be materialised`,
    };
  }
  if (input.set.revision !== input.expectedRevision) {
    return {
      code: 'OVERRIDE_SET_REVISION_CONFLICT',
      message:
        `the override set is at revision ${input.set.revision}, not ${input.expectedRevision}; ` +
        're-read the decisions before materialising them',
    };
  }
  if (input.effectiveDecisions === 0) {
    return {
      code: 'OVERRIDE_SET_EMPTY',
      message:
        'no effective decision to materialise; a dataset identical to its base is not a version',
    };
  }
  if (input.base.combinedChecksum !== input.baseChecksumAtOpen) {
    return {
      code: 'BASE_DATASET_CHANGED',
      message:
        'the base dataset is no longer the one these decisions were taken against; ' +
        'open a new override set on the current version',
    };
  }
  return null;
}

export function abandonRefusal(set: OverrideSet): Refusal | null {
  if (set.status !== 'DRAFT') {
    return {
      code: 'OVERRIDE_SET_NOT_DRAFT',
      message: `override set is already ${set.status}`,
    };
  }
  return null;
}

/**
 * What the queue calls a row.
 *
 * `SUPERSEDED` describes a row whose only decisions have all been replaced —
 * which cannot happen while a set holds one effective decision per row, so it
 * is reachable only through the decision history of a materialised set. It is
 * a state of the *history*, never a third thing a reviewer chooses.
 */
export function decisionState(
  effective: { decision: DecisionKind } | null,
  hasSupersededHistory: boolean,
  materialized: DecisionKind | null = null,
  sourceSettled = false,
): DecisionState {
  if (effective) return effective.decision === 'ACCEPT' ? 'ACCEPTED_DRAFT' : 'REJECTED_DRAFT';
  if (materialized)
    return materialized === 'ACCEPT' ? 'MATERIALIZED_ACCEPT' : 'MATERIALIZED_REJECT';
  if (sourceSettled) return 'SOURCE_SETTLED';
  return hasSupersededHistory ? 'SUPERSEDED' : 'UNDECIDED';
}

/**
 * What a reviewer override already in this version means for one quarantine
 * row of the same source. The override edge is the fact; the stamp on the row
 * is a copy of it that an earlier materialisation may not have carried, so the
 * edge is consulted first and the stamp second.
 *
 * - the edge names this row's proposed target → this is the decided row;
 * - the edge names another target → a sibling row was decided, and this one
 *   is settled by it.
 */
export function settlementOf(
  row: { newCode: string | null },
  sourceOverride: { targetCode: string } | null,
): { materialized: DecisionKind | null; sourceSettled: boolean } {
  if (!sourceOverride) return { materialized: null, sourceSettled: false };
  if (row.newCode && sourceOverride.targetCode === row.newCode) {
    return { materialized: 'ACCEPT', sourceSettled: false };
  }
  return { materialized: null, sourceSettled: true };
}

/**
 * The decision a materialisation stamped on a quarantine row, if any. The
 * column is free text because it is copied from the decision enum at
 * materialisation time; anything else in it is not a decision and is ignored
 * rather than trusted.
 */
export function materializedDecision(reviewerDecision: string | null): DecisionKind | null {
  return reviewerDecision === 'ACCEPT' || reviewerDecision === 'REJECT' ? reviewerDecision : null;
}

export const DECISION_STATES: readonly DecisionState[] = [
  'UNDECIDED',
  'ACCEPTED_DRAFT',
  'REJECTED_DRAFT',
  'SUPERSEDED',
  'MATERIALIZED_ACCEPT',
  'MATERIALIZED_REJECT',
  'SOURCE_SETTLED',
];
