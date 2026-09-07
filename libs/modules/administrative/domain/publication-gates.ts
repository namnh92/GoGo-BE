import type { ValidationReport } from './validation';

/**
 * ADM-005 (#458) / ADR-0019 §3 — what publication is allowed to believe.
 *
 * Everything here is a pure function of facts the server re-read for itself.
 * Nothing a client sends reaches it: not a `publishable` flag, not a checksum,
 * not an acknowledgement of the warnings. The caller names a dataset; the
 * server decides whether that dataset may become the active one.
 *
 * The gates are ordered from cheapest to strongest, and the *first* refusal is
 * returned rather than a list. A reviewer reading "this dataset was never
 * validated" is not helped by also being told its fingerprint moved.
 */

export type DatasetStatus = 'STAGED' | 'VALIDATED' | 'REJECTED' | 'PUBLISHED' | 'ROLLED_BACK';

/**
 * Bumped whenever a gate is added, removed, or changes what it means. A report
 * produced by an older validator is not evidence about the current gates, so
 * publication treats it as stale rather than as a pass.
 */
export const VALIDATOR_VERSION = 'adm-004.1';

/**
 * The identity a validation result is bound to. Publication re-derives every
 * one of these from the database and refuses on the first disagreement — which
 * is what makes "validated last week, then someone edited a staged row" a
 * refusal rather than a silent publication of unvalidated data.
 */
export type ValidationBinding = {
  datasetVersionId: string;
  combinedDatasetVersion: string;
  combinedChecksum: string;
  /** Digest of the staged rows themselves, so a direct UPDATE is detected. */
  snapshotFingerprint: string;
  overrideRevision: number;
};

/** What is stored in `administrative_dataset_versions.validation_report`. */
export type PersistedValidation = ValidationReport & {
  /** Deterministic in its inputs: the same run re-computes the same id. */
  validationId: string;
  validatorVersion: string;
  boundTo: ValidationBinding;
};

export type Refusal = { code: string; message: string };

export type PublishCandidate = {
  datasetVersionId: string;
  status: DatasetStatus;
  combinedDatasetVersion: string;
  combinedChecksum: string;
  overrideRevision: number;
  validation: PersistedValidation | null;
  /** Recomputed now from the staged rows. */
  snapshotFingerprint: string;
  /**
   * Recomputed now from the pinned manifest, or null when a pinned file is
   * missing or its bytes no longer match. Null is a refusal, not a skip.
   */
  recomputed: { combinedDatasetVersion: string; combinedChecksum: string } | null;
};

/**
 * Returns the reason this dataset may not be published, or null.
 *
 * `publishable === errors === 0` is the last word, and warnings are never
 * consulted: the 2025 reorganisation legitimately trips two of them, and a
 * publication path that could be blocked by a warning would teach reviewers to
 * suppress warnings rather than read them.
 */
export function publishRefusal(candidate: PublishCandidate): Refusal | null {
  if (candidate.status === 'PUBLISHED') {
    return {
      code: 'DATASET_ALREADY_PUBLISHED',
      message: `${candidate.combinedDatasetVersion} is already the active dataset`,
    };
  }
  if (candidate.status === 'REJECTED') {
    return {
      code: 'DATASET_REJECTED',
      message: `${candidate.combinedDatasetVersion} was rejected and cannot be published`,
    };
  }
  if (candidate.status !== 'VALIDATED') {
    return {
      code: 'DATASET_NOT_VALIDATED',
      message: `${candidate.combinedDatasetVersion} is ${candidate.status}; validate it first`,
    };
  }

  const validation = candidate.validation;
  if (!validation) {
    return {
      code: 'VALIDATION_MISSING',
      message: `no validation result is stored for ${candidate.combinedDatasetVersion}`,
    };
  }

  const stale = staleness(candidate, validation);
  if (stale) return stale;

  if (!candidate.recomputed) {
    return {
      code: 'SNAPSHOT_CHECKSUM_MISMATCH',
      message: 'a pinned source file is missing or its bytes no longer match the manifest',
    };
  }
  if (
    candidate.recomputed.combinedChecksum !== candidate.combinedChecksum ||
    candidate.recomputed.combinedDatasetVersion !== candidate.combinedDatasetVersion
  ) {
    return {
      code: 'SNAPSHOT_CHECKSUM_MISMATCH',
      message:
        `the pinned sources now produce ${candidate.recomputed.combinedDatasetVersion}, ` +
        `not the stored ${candidate.combinedDatasetVersion}`,
    };
  }

  if (validation.errors > 0 || !validation.publishable) {
    return {
      code: 'VALIDATION_HAS_ERRORS',
      message: `${validation.errors} validation error(s) block publication; ERROR cannot be overridden`,
    };
  }
  return null;
}

/**
 * Every way a stored result can stop describing the thing being published.
 *
 * Four separate identities are compared rather than one, because they fail
 * independently: the row can be re-pointed, the sources can move, a reviewer
 * can bump the override revision, and the staged rows themselves can be edited
 * underneath a version whose checksum never changes — that last one is why the
 * fingerprint exists at all.
 */
function staleness(candidate: PublishCandidate, validation: PersistedValidation): Refusal | null {
  const mismatches: string[] = [];
  if (validation.boundTo.datasetVersionId !== candidate.datasetVersionId) {
    mismatches.push('dataset id');
  }
  if (validation.boundTo.combinedDatasetVersion !== candidate.combinedDatasetVersion) {
    mismatches.push('combined version');
  }
  if (validation.boundTo.combinedChecksum !== candidate.combinedChecksum) {
    mismatches.push('combined checksum');
  }
  if (validation.boundTo.overrideRevision !== candidate.overrideRevision) {
    mismatches.push('override revision');
  }
  if (validation.boundTo.snapshotFingerprint !== candidate.snapshotFingerprint) {
    mismatches.push('staged rows');
  }
  if (validation.validatorVersion !== VALIDATOR_VERSION) {
    mismatches.push(`validator (${validation.validatorVersion} != ${VALIDATOR_VERSION})`);
  }
  if (mismatches.length === 0) return null;
  return {
    code: 'VALIDATION_STALE',
    message: `validation no longer describes this dataset: ${mismatches.join(', ')} changed; re-validate`,
  };
}

/**
 * The lifecycle states a validation run may be asked for.
 *
 * Validation is not a read: it writes the report, the diff and the resulting
 * lifecycle status onto the row. `publishable ? VALIDATED : STAGED` is the
 * right answer for a version being prepared and the wrong one for every other
 * version there is — applied to the active dataset it would demote it out of
 * PUBLISHED and leave the environment with no active version at all (the
 * partial unique index forbids *two*, not *none*), and applied to a
 * ROLLED_BACK version it would take it out of the restorable set, since
 * `rollbackRefusal` requires that exact status.
 *
 * Neither is something an operator asked for by pressing "validate", so
 * neither is allowed. Reported as GoGo-BE#482.
 */
export const VALIDATABLE_STATUSES: readonly DatasetStatus[] = ['STAGED', 'VALIDATED'];

export type ValidateCandidate = {
  status: DatasetStatus;
  combinedDatasetVersion: string;
};

/** Returns the reason this dataset may not be validated, or null. */
export function validateRefusal(candidate: ValidateCandidate): Refusal | null {
  if (VALIDATABLE_STATUSES.includes(candidate.status)) return null;
  return {
    code: 'DATASET_STATE_NOT_VALIDATABLE',
    message:
      `${candidate.combinedDatasetVersion} is ${candidate.status}; ` +
      `only ${VALIDATABLE_STATUSES.join(' and ')} versions can be validated, because ` +
      'validation writes the resulting lifecycle status and would otherwise demote this one',
  };
}

/**
 * What a validation run is *about*, sampled before the reads and again under
 * lock before the write.
 *
 * A validation takes long enough to read every unit, change and quarantine row
 * of a dataset. In that window a publication can win the transition lock, an
 * override revision can be bumped, or a staged row can be edited directly. A
 * report written afterwards would then describe rows that are no longer there
 * while claiming, through its own binding, that it describes the current ones.
 */
export type ValidationIdentity = {
  status: DatasetStatus;
  combinedDatasetVersion: string;
  combinedChecksum: string;
  overrideRevision: number;
  snapshotFingerprint: string;
};

/**
 * Returns the reason a completed validation must not be written, or null.
 *
 * Ordered after `validateRefusal` on the re-read row: a version that became
 * PUBLISHED mid-run is refused for *being* published, which is the more useful
 * of the two true answers.
 */
export function validationDrift(
  before: ValidationIdentity,
  now: ValidationIdentity,
): Refusal | null {
  const moved: string[] = [];
  if (before.status !== now.status) moved.push(`status (${before.status} -> ${now.status})`);
  if (before.combinedDatasetVersion !== now.combinedDatasetVersion) moved.push('combined version');
  if (before.combinedChecksum !== now.combinedChecksum) moved.push('combined checksum');
  if (before.overrideRevision !== now.overrideRevision) moved.push('override revision');
  if (before.snapshotFingerprint !== now.snapshotFingerprint) moved.push('staged rows');
  if (moved.length === 0) return null;
  return {
    code: 'DATASET_CHANGED_DURING_VALIDATION',
    message:
      `${now.combinedDatasetVersion} changed while it was being validated: ` +
      `${moved.join(', ')}; nothing was written, re-run the validation`,
  };
}

export type RollbackCandidate = {
  datasetVersionId: string;
  status: DatasetStatus;
  combinedDatasetVersion: string;
  publishedAt: Date | string | null;
  validation: PersistedValidation | null;
  /** Recomputed now from the rows still stored for this version. */
  snapshotFingerprint: string;
};

/**
 * Returns the reason this dataset may not be re-activated, or null.
 *
 * Rollback deliberately does **not** re-verify the pinned source files. A
 * version published a year ago may have been built from a snapshot no longer
 * vendored, and refusing to restore it on those grounds would remove the escape
 * hatch exactly when it is needed. What must still hold is that the rows
 * themselves are the rows that were validated — checked by fingerprint, which
 * is about this database and not about a file on disk.
 */
export function rollbackRefusal(candidate: RollbackCandidate): Refusal | null {
  if (candidate.status === 'PUBLISHED') {
    return {
      code: 'DATASET_ALREADY_PUBLISHED',
      message: `${candidate.combinedDatasetVersion} is already the active dataset`,
    };
  }
  if (!candidate.publishedAt) {
    return {
      code: 'DATASET_NEVER_PUBLISHED',
      message:
        `${candidate.combinedDatasetVersion} was never published; ` +
        'rollback restores a previously active version, it does not publish a new one',
    };
  }
  if (candidate.status !== 'ROLLED_BACK') {
    return {
      code: 'DATASET_NOT_RESTORABLE',
      message: `${candidate.combinedDatasetVersion} is ${candidate.status} and cannot be re-activated`,
    };
  }
  if (!candidate.validation) {
    return {
      code: 'VALIDATION_MISSING',
      message: `no validation result is stored for ${candidate.combinedDatasetVersion}`,
    };
  }
  if (candidate.validation.boundTo.snapshotFingerprint !== candidate.snapshotFingerprint) {
    return {
      code: 'DATASET_CORRUPTED',
      message:
        `the stored rows for ${candidate.combinedDatasetVersion} no longer match the ` +
        'snapshot that was validated and published; re-import instead of restoring',
    };
  }
  return null;
}
