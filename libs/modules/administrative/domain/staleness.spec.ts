import { describe, expect, it } from 'vitest';
import { evaluateStaleness, type ActiveUnit } from './staleness';
import type { CurrentMapping } from './resolver';

/**
 * ADM-006 (#459) — is a stored mapping still true?
 *
 * The distinction the tests exist for: a mapping *labelled* with an older
 * dataset version is the normal state of the catalogue between publications and
 * must not raise an alarm, while a mapping whose commune no longer exists is a
 * real defect. Only the codes tell them apart, so the stored version alone is
 * never the test.
 */

const ACTIVE = 'v5.0.0+v2.4.1+7fac8c4a+none+r0';
const OLDER = 'v4.9.0+v2.4.1+7fac8c4a+none+r0';

function mapping(over: Partial<CurrentMapping> = {}): CurrentMapping {
  return {
    status: 'AUTO_MATCHED',
    provinceCode: '01',
    communeCode: '00004',
    legacyDistrictCode: null,
    method: 'boundary_point_in_polygon',
    datasetVersion: ACTIVE,
    boundaryVersion: 'v4.0.0',
    ...over,
  };
}

const unit: ActiveUnit = { code: '00004', parentCode: '01', status: 'ACTIVE', effectiveTo: null };

const check = (current: CurrentMapping, u: ActiveUnit | null = unit) =>
  evaluateStaleness({ current, activeDatasetVersion: ACTIVE, unit: u });

describe('valid mappings', () => {
  it('is CURRENT when the codes resolve and the version matches', () => {
    expect(check(mapping())).toMatchObject({ stale: false, reason: 'CURRENT' });
  });

  it('is REVALIDATED — not stale — when only the version label is older', () => {
    // The catalogue is in this state after every publication. Treating it as
    // stale would put the whole catalogue in a review queue for a release that
    // changed nothing about these places.
    const verdict = check(mapping({ datasetVersion: OLDER }));
    expect(verdict).toMatchObject({ stale: false, reason: 'REVALIDATED', requiresReview: false });
    expect(verdict.storedDatasetVersion).toBe(OLDER);
  });

  it('says nothing about a place with no mapping', () => {
    expect(
      check(mapping({ status: 'UNMAPPED', communeCode: null, provinceCode: null })),
    ).toMatchObject({ stale: false, reason: 'NO_MAPPING' });
  });
});

describe('invalidated mappings', () => {
  it('is stale when the commune is not in the active dataset at all', () => {
    expect(check(mapping({ datasetVersion: OLDER }), null)).toMatchObject({
      stale: true,
      reason: 'UNIT_NOT_IN_ACTIVE_DATASET',
      requiresReview: true,
    });
  });

  it('is stale when the code exists but names a unit that has ended', () => {
    // 00004 is Phường Trúc Bạch until 2025-06-30 and Phường Ba Đình after. A
    // stored code pointing at the ended period is not a current address.
    const ended: ActiveUnit = {
      code: '00004',
      parentCode: '01',
      status: 'INACTIVE',
      effectiveTo: '2025-06-30',
    };
    expect(check(mapping(), ended)).toMatchObject({ stale: true, reason: 'UNIT_NOT_CURRENT' });
  });

  it('is stale when the commune no longer sits under the stored province', () => {
    expect(check(mapping(), { ...unit, parentCode: '79' })).toMatchObject({
      stale: true,
      reason: 'HIERARCHY_CHANGED',
    });
  });
});

describe('reviewer-owned rows are flagged, never resolved here', () => {
  it('marks a VERIFIED place as reviewer-owned while still reporting staleness', () => {
    const verdict = check(mapping({ status: 'VERIFIED', datasetVersion: OLDER }), null);
    expect(verdict).toMatchObject({
      stale: true,
      reviewerOwned: true,
      requiresReview: true,
      reason: 'UNIT_NOT_IN_ACTIVE_DATASET',
    });
  });

  it('marks REJECTED as reviewer-owned too', () => {
    expect(check(mapping({ status: 'REJECTED' })).reviewerOwned).toBe(true);
  });

  it('returns a verdict and nothing else — there is no status field to write', () => {
    // The verdict deliberately carries no proposed status: deciding what to do
    // about a stale VERIFIED place belongs to #461/#462 and to a person.
    const verdict = check(mapping({ status: 'VERIFIED' }), null);
    expect(Object.keys(verdict).sort()).toEqual([
      'activeDatasetVersion',
      'reason',
      'requiresReview',
      'reviewerOwned',
      'stale',
      'storedDatasetVersion',
    ]);
  });
});
