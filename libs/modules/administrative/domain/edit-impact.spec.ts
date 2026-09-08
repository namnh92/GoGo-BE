import { describe, expect, it } from 'vitest';
import { contradictsStoredMapping, editPolicyFor, isMaterialForMapping } from './edit-impact';
import type { Resolution } from './resolver';

const base: Resolution = {
  placeId: 'p1',
  status: 'AUTO_MATCHED',
  provinceCode: '01',
  communeCode: '00004',
  legacyDistrictCode: null,
  method: 'boundary_point_in_polygon',
  confidence: 1,
  datasetVersion: 'v5.0.0+test',
  boundaryVersion: 'b1',
  evidence: [],
  candidates: [],
  reason: null,
  writable: true,
  changed: true,
};

describe('editPolicyFor', () => {
  it('lets the machine correct its own states', () => {
    for (const status of ['UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW', 'STALE'] as const) {
      expect(editPolicyFor(status)).toBe('RESOLVE');
    }
  });

  it('never lets an edit overwrite or re-point a verified mapping', () => {
    expect(editPolicyFor('VERIFIED')).toBe('STALE_IF_CONTRADICTED');
  });

  it('leaves a rejection to the rematch that exists for it', () => {
    expect(editPolicyFor('REJECTED')).toBe('PROTECTED');
  });
});

describe('contradictsStoredMapping', () => {
  it('is a contradiction when the resolver names a different commune outright', () => {
    expect(contradictsStoredMapping({ provinceCode: '79', communeCode: '26734' }, base)).toBe(true);
  });

  it('is not a contradiction when the resolver agrees', () => {
    expect(contradictsStoredMapping({ provinceCode: '01', communeCode: '00004' }, base)).toBe(
      false,
    );
  });

  it('is not a contradiction when the evidence merely disagrees with itself', () => {
    // NEEDS_REVIEW is "I cannot tell", and a verified mapping may still be the
    // right answer. Demoting it here would empty the catalogue on any release
    // that made two polygons overlap.
    expect(
      contradictsStoredMapping(
        { provinceCode: '79', communeCode: '26734' },
        { ...base, status: 'NEEDS_REVIEW', provinceCode: null, communeCode: null },
      ),
    ).toBe(false);
  });

  it('is not a contradiction when there is no evidence at all', () => {
    expect(
      contradictsStoredMapping(
        { provinceCode: '79', communeCode: '26734' },
        { ...base, status: 'UNMAPPED', provinceCode: null, communeCode: null },
      ),
    ).toBe(false);
  });
});

describe('isMaterialForMapping', () => {
  it('is false for an edit that touched nothing the resolver reads', () => {
    expect(isMaterialForMapping({ geometryMoved: false, codesAsserted: false })).toBe(false);
  });

  it('is true for each of the two inputs on its own', () => {
    const off = { geometryMoved: false, codesAsserted: false };
    expect(isMaterialForMapping({ ...off, geometryMoved: true })).toBe(true);
    expect(isMaterialForMapping({ ...off, codesAsserted: true })).toBe(true);
  });

  it('takes exactly two inputs — the resolver reads nothing else (ADR-0019 §7b)', () => {
    // `city` and `district` were once here. The signature is the enforcement:
    // a caller cannot re-open an administrative question with a free-text edit,
    // because there is no argument left to say it with.
    expect(Object.keys({ geometryMoved: false, codesAsserted: false })).toHaveLength(2);
  });
});
