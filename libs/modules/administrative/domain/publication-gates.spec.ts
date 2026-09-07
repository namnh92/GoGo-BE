import { describe, expect, it } from 'vitest';
import {
  publishRefusal,
  rollbackRefusal,
  validateRefusal,
  validationDrift,
  VALIDATOR_VERSION,
  type DatasetStatus,
  type PersistedValidation,
  type PublishCandidate,
  type RollbackCandidate,
  type ValidationBinding,
  type ValidationIdentity,
} from './publication-gates';

/**
 * ADM-005 (#458) — what publication is allowed to believe.
 *
 * Every test here is a way someone could get an unvalidated, drifted or
 * half-edited dataset to become the country's active administrative data. The
 * gates are ordered, so each case also pins *which* refusal comes back: a
 * reviewer told "validation is stale" when the real problem is that nobody ever
 * validated it will go looking in the wrong place.
 */

const BINDING: ValidationBinding = {
  datasetVersionId: 'd1',
  combinedDatasetVersion: 'v5.0.0+v2.4.1+7fac8c4a+none+r0',
  combinedChecksum: 'checksum-a',
  snapshotFingerprint: 'fingerprint-a',
  overrideRevision: 0,
};

function validation(over: Partial<PersistedValidation> = {}): PersistedValidation {
  return {
    datasetVersion: BINDING.combinedDatasetVersion,
    ranAt: '2026-09-07T00:00:00.000Z',
    findings: [],
    errors: 0,
    warnings: 0,
    publishable: true,
    counts: {
      currentProvinces: 34,
      currentCommunes: 3321,
      historicalProvinces: 63,
      historicalDistricts: 696,
      historicalCommunes: 10035,
      canonicalChanges: 9569,
      quarantined: 1033,
    },
    validationId: 'val-1',
    validatorVersion: VALIDATOR_VERSION,
    boundTo: BINDING,
    ...over,
  };
}

function candidate(over: Partial<PublishCandidate> = {}): PublishCandidate {
  return {
    datasetVersionId: 'd1',
    status: 'VALIDATED',
    combinedDatasetVersion: BINDING.combinedDatasetVersion,
    combinedChecksum: BINDING.combinedChecksum,
    overrideRevision: 0,
    validation: validation(),
    snapshotFingerprint: BINDING.snapshotFingerprint,
    recomputed: {
      combinedDatasetVersion: BINDING.combinedDatasetVersion,
      combinedChecksum: BINDING.combinedChecksum,
    },
    ...over,
  };
}

describe('publishRefusal', () => {
  it('lets a validated, unchanged, error-free dataset through', () => {
    expect(publishRefusal(candidate())).toBeNull();
  });

  it('publishes with warnings, however many', () => {
    // The pinned dataset trips two. A publication path that a warning could
    // block would teach reviewers to silence warnings rather than read them.
    const warned = validation({
      warnings: 1033,
      findings: [
        {
          gate: 'UNRESOLVED_CHANGES',
          severity: 'WARNING',
          message: 'divided',
          count: 1033,
          samples: [],
        },
      ],
    });
    expect(publishRefusal(candidate({ validation: warned }))).toBeNull();
  });

  it.each([
    ['STAGED', 'DATASET_NOT_VALIDATED'],
    ['REJECTED', 'DATASET_REJECTED'],
    ['ROLLED_BACK', 'DATASET_NOT_VALIDATED'],
    ['PUBLISHED', 'DATASET_ALREADY_PUBLISHED'],
  ] as const)('refuses a %s dataset with %s', (status, code) => {
    expect(publishRefusal(candidate({ status }))?.code).toBe(code);
  });

  it('refuses when no validation was ever stored', () => {
    expect(publishRefusal(candidate({ validation: null }))?.code).toBe('VALIDATION_MISSING');
  });

  it('refuses an ERROR result, and says the error cannot be overridden', () => {
    const failed = validation({ errors: 3, publishable: false });
    const refusal = publishRefusal(candidate({ validation: failed }));
    expect(refusal?.code).toBe('VALIDATION_HAS_ERRORS');
    expect(refusal?.message).toContain('cannot be overridden');
  });

  it('refuses a result that claims publishable while carrying errors', () => {
    // Belt and braces: `publishable` is derived, but it is also stored, and a
    // stored boolean that disagrees with its own error count is not evidence.
    const lying = validation({ errors: 2, publishable: true });
    expect(publishRefusal(candidate({ validation: lying }))?.code).toBe('VALIDATION_HAS_ERRORS');
  });

  describe('staleness — the result must describe this exact dataset', () => {
    it.each([
      ['the staged rows were edited', { snapshotFingerprint: 'fingerprint-b' }, 'staged rows'],
      ['the override revision moved', { overrideRevision: 1 }, 'override revision'],
      ['the stored checksum moved', { combinedChecksum: 'checksum-b' }, 'combined checksum'],
      ['the row is a different dataset', { datasetVersionId: 'd2' }, 'dataset id'],
    ])('refuses when %s', (_case, over, mentioned) => {
      const refusal = publishRefusal(candidate(over as Partial<PublishCandidate>));
      expect(refusal?.code).toBe('VALIDATION_STALE');
      expect(refusal?.message).toContain(mentioned);
    });

    it('refuses a result produced by an older validator', () => {
      const old = validation({ validatorVersion: 'adm-004.0' });
      const refusal = publishRefusal(candidate({ validation: old }));
      expect(refusal?.code).toBe('VALIDATION_STALE');
      expect(refusal?.message).toContain('validator');
    });

    it('names every mismatch at once, so one re-validation fixes all of them', () => {
      const refusal = publishRefusal(
        candidate({ overrideRevision: 2, snapshotFingerprint: 'fingerprint-c' }),
      );
      expect(refusal?.message).toContain('override revision');
      expect(refusal?.message).toContain('staged rows');
    });
  });

  describe('the pinned sources must still produce this dataset', () => {
    it('refuses when a pinned file is missing or its bytes moved', () => {
      expect(publishRefusal(candidate({ recomputed: null }))?.code).toBe(
        'SNAPSHOT_CHECKSUM_MISMATCH',
      );
    });

    it('refuses when the sources now produce a different version', () => {
      const drifted = candidate({
        recomputed: { combinedDatasetVersion: 'v5.1.0+…', combinedChecksum: 'checksum-z' },
      });
      expect(publishRefusal(drifted)?.code).toBe('SNAPSHOT_CHECKSUM_MISMATCH');
    });
  });

  it('reports the lifecycle problem before the drift problem', () => {
    // A reviewer told "the sources drifted" about a dataset nobody validated
    // would go and re-pin the sources, which is not the problem.
    const both = candidate({ status: 'STAGED', recomputed: null });
    expect(publishRefusal(both)?.code).toBe('DATASET_NOT_VALIDATED');
  });
});

describe('rollbackRefusal', () => {
  function target(over: Partial<RollbackCandidate> = {}): RollbackCandidate {
    return {
      datasetVersionId: 'd0',
      status: 'ROLLED_BACK',
      combinedDatasetVersion: 'v4.9.0+v2.4.1+7fac8c4a+none+r0',
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
      validation: validation(),
      snapshotFingerprint: BINDING.snapshotFingerprint,
      ...over,
    };
  }

  it('restores a version that really was published before', () => {
    expect(rollbackRefusal(target())).toBeNull();
  });

  it('refuses a dataset that was never published', () => {
    const refusal = rollbackRefusal(target({ status: 'VALIDATED', publishedAt: null }));
    expect(refusal?.code).toBe('DATASET_NEVER_PUBLISHED');
    expect(refusal?.message).toContain('does not publish a new one');
  });

  it('refuses the version that is already active', () => {
    expect(rollbackRefusal(target({ status: 'PUBLISHED' }))?.code).toBe(
      'DATASET_ALREADY_PUBLISHED',
    );
  });

  it('refuses when the stored rows no longer match what was validated', () => {
    // The rows are what gets served. A version whose units were edited after
    // publication is not the version anyone reviewed.
    const refusal = rollbackRefusal(target({ snapshotFingerprint: 'fingerprint-tampered' }));
    expect(refusal?.code).toBe('DATASET_CORRUPTED');
    expect(refusal?.message).toContain('re-import');
  });

  it('does not consult the pinned files at all', () => {
    // A version published a year ago may have been built from a snapshot no
    // longer vendored. Refusing on that ground would remove the escape hatch
    // exactly when it is needed, so integrity is judged on the rows.
    expect(rollbackRefusal(target())).toBeNull();
  });

  it('refuses a version with no stored validation', () => {
    expect(rollbackRefusal(target({ validation: null }))?.code).toBe('VALIDATION_MISSING');
  });
});

/**
 * #482 — what validation is allowed to write to.
 *
 * Validation is not a read: it stores `publishable ? VALIDATED : STAGED` on the
 * row. That is the right answer for a version being prepared and a demotion for
 * every other version there is, so the states it may be asked for are a closed
 * set and the identity it was computed from is re-checked before the write.
 */
describe('validateRefusal', () => {
  const candidate = (status: DatasetStatus) => ({
    status,
    combinedDatasetVersion: 'v5.0.0+v2.4.1+7fac8c4a+none+r0',
  });

  it('allows the two states a version being prepared can be in', () => {
    expect(validateRefusal(candidate('STAGED'))).toBeNull();
    // Re-validating a VALIDATED version is how a reviewer re-checks after a
    // source fix, and it can legitimately push it back to STAGED.
    expect(validateRefusal(candidate('VALIDATED'))).toBeNull();
  });

  it('refuses the active version, because the write would demote it', () => {
    // The partial unique index forbids two PUBLISHED rows, not zero of them.
    // Demoting the only one leaves the environment with no active dataset and
    // every place approval refusing.
    const refusal = validateRefusal(candidate('PUBLISHED'));
    expect(refusal?.code).toBe('DATASET_STATE_NOT_VALIDATABLE');
    expect(refusal?.message).toContain('PUBLISHED');
  });

  it('refuses a restorable version, because the write would un-restore it', () => {
    // `rollbackRefusal` requires exactly ROLLED_BACK; moving it to VALIDATED
    // removes the escape hatch.
    expect(validateRefusal(candidate('ROLLED_BACK'))?.code).toBe('DATASET_STATE_NOT_VALIDATABLE');
  });

  it('refuses a rejected version rather than quietly reviving it', () => {
    expect(validateRefusal(candidate('REJECTED'))?.code).toBe('DATASET_STATE_NOT_VALIDATABLE');
  });
});

describe('validationDrift', () => {
  const identity: ValidationIdentity = {
    status: 'STAGED',
    combinedDatasetVersion: 'v5.0.0+v2.4.1+7fac8c4a+none+r0',
    combinedChecksum: 'checksum-a',
    overrideRevision: 0,
    snapshotFingerprint: 'fingerprint-a',
  };

  it('writes the report when nothing moved under it', () => {
    expect(validationDrift(identity, { ...identity })).toBeNull();
  });

  it('refuses when the staged rows were edited while the gates ran', () => {
    // This is the case the fingerprint exists for: the combined checksum is
    // computed from the pinned files and cannot see a direct UPDATE.
    const refusal = validationDrift(identity, {
      ...identity,
      snapshotFingerprint: 'fingerprint-b',
    });
    expect(refusal?.code).toBe('DATASET_CHANGED_DURING_VALIDATION');
    expect(refusal?.message).toContain('staged rows');
    expect(refusal?.message).toContain('nothing was written');
  });

  it('names each identity that moved, so a reviewer knows what to look at', () => {
    for (const [drift, expected] of [
      [{ status: 'PUBLISHED' as DatasetStatus }, 'status'],
      [{ combinedDatasetVersion: 'v5.1.0+v2.4.1+7fac8c4a+none+r0' }, 'combined version'],
      [{ combinedChecksum: 'checksum-b' }, 'combined checksum'],
      [{ overrideRevision: 1 }, 'override revision'],
    ] as [Partial<ValidationIdentity>, string][]) {
      const refusal = validationDrift(identity, { ...identity, ...drift });
      expect(refusal?.code).toBe('DATASET_CHANGED_DURING_VALIDATION');
      expect(refusal?.message).toContain(expected);
    }
  });

  it('reports every movement at once rather than the first', () => {
    // Unlike the publish gates, this is not a diagnosis a reviewer acts on
    // step by step — the whole run is discarded either way.
    const refusal = validationDrift(identity, {
      ...identity,
      overrideRevision: 2,
      snapshotFingerprint: 'fingerprint-c',
    });
    expect(refusal?.message).toContain('override revision');
    expect(refusal?.message).toContain('staged rows');
  });
});
