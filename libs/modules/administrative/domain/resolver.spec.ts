import { describe, expect, it } from 'vitest';
import {
  adjudicate,
  definitionalConfidence,
  type AdjudicationInput,
  type CurrentMapping,
  type Evidence,
} from './resolver';
import { applyAutomaticTransition, clearsReviewerAttribution } from './mapping-status';

/**
 * ADM-006 (#459) — the decision, without a database.
 *
 * The single behaviour worth guarding hardest is that two deterministic sources
 * which disagree never produce an answer. Picking the higher-priority one would
 * pass every test that only checks the happy path, and a wrong commune code is
 * indistinguishable from a right one everywhere downstream.
 */

const unmapped: CurrentMapping = {
  status: 'UNMAPPED',
  provinceCode: null,
  communeCode: null,
  legacyDistrictCode: null,
  method: null,
  datasetVersion: null,
  boundaryVersion: null,
};

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    method: 'boundary_point_in_polygon',
    provinceCode: '01',
    communeCode: '00004',
    hierarchyValid: true,
    deterministic: true,
    detail: 'point in Phường Ba Đình (00004)',
    ...over,
  };
}

function run(over: Partial<AdjudicationInput> = {}) {
  return adjudicate({
    placeId: 'p1',
    datasetVersion: 'v5.0.0+v2.4.1+7fac8c4a+none+r0',
    boundaryVersion: 'v4.0.0',
    current: unmapped,
    evidence: [],
    reasons: [],
    ...over,
  });
}

describe('a single deterministic source resolves', () => {
  it('AUTO_MATCHED from a unique boundary containment, carrying the boundary version', () => {
    const result = run({ evidence: [evidence()] });
    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      provinceCode: '01',
      communeCode: '00004',
      method: 'boundary_point_in_polygon',
      boundaryVersion: 'v4.0.0',
      confidence: 1,
      reason: null,
      writable: true,
      changed: true,
    });
  });

  it('records the dataset version on every answer', () => {
    // A code read without knowing which dataset produced it is ambiguous, not
    // merely undated: 2,212 current commune codes named something else before.
    expect(run({ evidence: [evidence()] }).datasetVersion).toBe('v5.0.0+v2.4.1+7fac8c4a+none+r0');
  });

  it('does not claim a boundary version when boundaries did not decide it', () => {
    const result = run({ evidence: [evidence({ method: 'trusted_code' })] });
    expect(result.method).toBe('trusted_code');
    expect(result.boundaryVersion).toBeNull();
  });

  it('leaves confidence null where no number is defined', () => {
    const result = run({ evidence: [evidence({ method: 'exact_name' })] });
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.confidence).toBeNull();
  });
});

describe('confidence is definitional, not a score', () => {
  // Deterministic selection and calibrated certainty are different claims. Two
  // kinds of evidence answer "which unit is this" by construction; everything
  // else is an argument, however good, and gets no number.
  it.each([
    ['trusted_code', 1],
    ['boundary_point_in_polygon', 1],
    ['structured_components', null],
    ['exact_name', null],
    ['change_mapping', null],
    ['components_with_coordinates', null],
  ] as const)('%s alone resolves with confidence %s', (method, expected) => {
    const result = run({ evidence: [evidence({ method })] });
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.method).toBe(method);
    expect(result.confidence).toBe(expected);
  });

  it('keeps 1.00 when a code and the geometry agree', () => {
    const result = run({
      evidence: [evidence({ method: 'trusted_code' }), evidence()],
    });
    expect(result).toMatchObject({ status: 'AUTO_MATCHED', method: 'trusted_code', confidence: 1 });
  });

  it('gives no number to a unique match that sits on an edge', () => {
    // A single polygon can still be an edge match — a coastline, or a border
    // with a polygon this release does not carry. It resolves; it is not
    // definitional.
    const result = run({ evidence: [evidence({ onEdge: true })] });
    expect(result).toMatchObject({ status: 'AUTO_MATCHED', confidence: null });
  });

  it('gives no number when a conflict sent the result to review', () => {
    const result = run({
      evidence: [
        evidence({ method: 'trusted_code', communeCode: '00004' }),
        evidence({ communeCode: '00008' }),
      ],
    });
    expect(result).toMatchObject({ status: 'NEEDS_REVIEW', confidence: null });
  });

  it('voids 1.00 when another deterministic source named a different commune', () => {
    // Even where the contradiction is itself invalid and does not reach the
    // answer, the answer is no longer conflict-free.
    const winner = evidence({ method: 'trusted_code' });
    const other = evidence({ communeCode: '00008' });
    expect(definitionalConfidence(winner, [winner, other])).toBeNull();
    expect(definitionalConfidence(winner, [winner])).toBe(1);
  });

  it('never numbers a province-only result', () => {
    expect(definitionalConfidence(evidence({ communeCode: null }), [])).toBeNull();
  });

  it('never numbers a suggestion', () => {
    const result = run({
      evidence: [evidence({ method: 'fuzzy_suggestion', deterministic: false })],
      reasons: ['AMBIGUOUS_NAME'],
    });
    expect(result.confidence).toBeNull();
  });
});

describe('agreement and disagreement', () => {
  it('attributes an agreed answer to the strongest source that produced it', () => {
    const result = run({
      evidence: [evidence({ method: 'exact_name' }), evidence({ method: 'trusted_code' })],
    });
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.method).toBe('trusted_code');
  });

  it('refuses to choose when two deterministic sources disagree', () => {
    const result = run({
      evidence: [
        evidence({ method: 'trusted_code', communeCode: '00004' }),
        evidence({ method: 'boundary_point_in_polygon', communeCode: '00008' }),
      ],
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('EVIDENCE_CONFLICT');
    expect(result.communeCode).toBeNull();
    expect(result.candidates.map((c) => c.communeCode).sort()).toEqual(['00004', '00008']);
  });

  it('keeps the stored codes rather than blanking them on a conflict', () => {
    // A place already carrying a reviewed-enough mapping should not be emptied
    // because a new source turned up and argued with the old one.
    const current: CurrentMapping = {
      ...unmapped,
      status: 'AUTO_MATCHED',
      provinceCode: '01',
      communeCode: '00025',
      method: 'exact_name',
    };
    const result = run({
      current,
      evidence: [
        evidence({ communeCode: '00004' }),
        evidence({ method: 'trusted_code', communeCode: '00008' }),
      ],
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.communeCode).toBe('00025');
  });
});

describe('hierarchy is checked, not assumed', () => {
  it('sends an explicit code with an invalid hierarchy to review, not to UNMAPPED', () => {
    const result = run({
      evidence: [evidence({ method: 'trusted_code', provinceCode: '79', hierarchyValid: false })],
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('INVALID_HIERARCHY');
    expect(result.candidates).toHaveLength(1);
  });

  it('treats a province with no commune as a review task, never as an answer', () => {
    const result = run({ evidence: [evidence({ communeCode: null })] });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('PROVINCE_ONLY');
    expect(result.candidates[0]!.provinceCode).toBe('01');
  });
});

describe('suggestions never decide', () => {
  it('multiple polygon matches produce review with candidates, never a pick', () => {
    const result = run({
      evidence: [
        evidence({ communeCode: '00004', deterministic: false }),
        evidence({ communeCode: '00008', deterministic: false }),
      ],
      reasons: ['MULTIPLE_BOUNDARY_MATCHES'],
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('MULTIPLE_BOUNDARY_MATCHES');
    expect(result.method).toBeNull();
  });

  it('reports a shared border separately from overlapping polygons', () => {
    const result = run({
      evidence: [
        evidence({ communeCode: '00004', deterministic: false }),
        evidence({ communeCode: '00008', deterministic: false }),
      ],
      reasons: ['BOUNDARY_EDGE'],
    });
    expect(result.reason).toBe('BOUNDARY_EDGE');
  });

  it('never yields AUTO_MATCHED from fuzzy evidence alone', () => {
    const result = run({
      evidence: [evidence({ method: 'fuzzy_suggestion', deterministic: false })],
      reasons: ['AMBIGUOUS_NAME'],
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.method).toBeNull();
  });

  it('a divided commune with no independent evidence stays unresolved', () => {
    // The upstream offers a default target for every divided ward. ADR-0019
    // forbids trusting it, and name similarity cannot break the tie.
    const result = run({ evidence: [], reasons: ['DIVIDED_CHANGE'] });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('DIVIDED_CHANGE');
    expect(result.communeCode).toBeNull();
  });

  it('resolves a divided commune when geometry answers it independently', () => {
    const result = run({
      evidence: [evidence({ communeCode: '00007' })],
      reasons: ['DIVIDED_CHANGE'],
    });
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.method).toBe('boundary_point_in_polygon');
  });
});

describe('absence of evidence is not a review task', () => {
  it.each([
    'MISSING_GEOMETRY',
    'INVALID_GEOMETRY',
    'NO_BOUNDARY_MATCH',
    'NO_BOUNDARY_VERSION',
  ] as const)('%s leaves the place UNMAPPED', (reason) => {
    // Putting "we know nothing about this place" in a human queue buries the
    // cases where a person could actually help.
    const result = run({ evidence: [], reasons: [reason] });
    expect(result.status).toBe('UNMAPPED');
    expect(result.reason).toBe(reason);
  });

  it('no evidence and no reason is UNMAPPED', () => {
    expect(run().status).toBe('UNMAPPED');
    expect(run().reason).toBe('NO_EVIDENCE');
  });
});

describe('legacy district', () => {
  it('carries a legacy code asserted alongside a current match', () => {
    const result = run({
      evidence: [
        evidence(),
        evidence({
          method: 'exact_name',
          provinceCode: null,
          communeCode: null,
          legacyDistrictCode: '001',
        }),
      ],
    });
    expect(result.status).toBe('AUTO_MATCHED');
    expect(result.legacyDistrictCode).toBe('001');
  });

  it('refuses to pick when two sources name different legacy districts', () => {
    // There are no legacy district boundaries to arbitrate with. Guessing here
    // would invent history rather than record it.
    const result = run({
      evidence: [
        evidence(),
        evidence({ provinceCode: null, communeCode: null, legacyDistrictCode: '001' }),
        evidence({
          method: 'trusted_code',
          provinceCode: null,
          communeCode: null,
          legacyDistrictCode: '002',
        }),
      ],
    });
    expect(result.legacyDistrictCode).toBeNull();
  });
});

describe('reviewer-owned rows', () => {
  const verified: CurrentMapping = {
    status: 'VERIFIED',
    provinceCode: '01',
    communeCode: '00025',
    legacyDistrictCode: null,
    method: 'editor',
    datasetVersion: 'v5.0.0+v2.4.1+7fac8c4a+none+r0',
    boundaryVersion: null,
  };

  it('never downgrades or re-points a VERIFIED place, however strong the evidence', () => {
    const result = run({ current: verified, evidence: [evidence({ communeCode: '00004' })] });
    expect(result).toMatchObject({
      status: 'VERIFIED',
      communeCode: '00025',
      method: 'editor',
      reason: 'REVIEWER_OWNED',
      writable: false,
      changed: false,
    });
    // The disagreeing evidence is still reported, so a reviewer can see it.
    expect(result.candidates.map((c) => c.communeCode)).toContain('00004');
  });

  it('leaves a REJECTED place alone unless a rematch was explicitly asked for', () => {
    const rejected: CurrentMapping = { ...verified, status: 'REJECTED', method: null };
    expect(run({ current: rejected, evidence: [evidence()] }).status).toBe('REJECTED');

    const rematched = run({
      current: rejected,
      evidence: [evidence()],
      allowRematchRejected: true,
    });
    expect(rematched.status).toBe('AUTO_MATCHED');
    expect(rematched.communeCode).toBe('00004');
  });
});

describe('change detection', () => {
  it('reports no change when the answer matches what is stored', () => {
    const current: CurrentMapping = {
      status: 'AUTO_MATCHED',
      provinceCode: '01',
      communeCode: '00004',
      legacyDistrictCode: null,
      method: 'boundary_point_in_polygon',
      datasetVersion: 'v5.0.0+v2.4.1+7fac8c4a+none+r0',
      boundaryVersion: 'v4.0.0',
    };
    expect(run({ current, evidence: [evidence()] }).changed).toBe(false);
  });

  it('reports a change when only the dataset version moved', () => {
    // The codes are the same characters and a different claim: they are now
    // asserted against a dataset that was not the one they were derived from.
    const current: CurrentMapping = {
      status: 'AUTO_MATCHED',
      provinceCode: '01',
      communeCode: '00004',
      legacyDistrictCode: null,
      method: 'boundary_point_in_polygon',
      datasetVersion: 'v4.9.0+v2.4.1+7fac8c4a+none+r0',
      boundaryVersion: 'v4.0.0',
    };
    expect(run({ current, evidence: [evidence()] }).changed).toBe(true);
  });
});

describe('the transition matrix', () => {
  it.each([
    ['UNMAPPED', 'AUTO_MATCHED', true],
    ['AUTO_MATCHED', 'NEEDS_REVIEW', true],
    ['NEEDS_REVIEW', 'AUTO_MATCHED', true],
    ['STALE', 'AUTO_MATCHED', true],
    ['VERIFIED', 'AUTO_MATCHED', false],
    ['VERIFIED', 'NEEDS_REVIEW', false],
    ['VERIFIED', 'UNMAPPED', false],
    ['REJECTED', 'AUTO_MATCHED', false],
  ] as const)('%s -> %s automatically: %s', (from, to, allowed) => {
    expect(applyAutomaticTransition(from, to).allowed).toBe(allowed);
  });

  it('a refused transition reports the status that still stands', () => {
    const decision = applyAutomaticTransition('VERIFIED', 'AUTO_MATCHED');
    expect(decision).toEqual({ allowed: false, status: 'VERIFIED', reason: 'REVIEWER_OWNED' });
  });

  it('opens REJECTED only for an explicit rematch', () => {
    expect(applyAutomaticTransition('REJECTED', 'AUTO_MATCHED').allowed).toBe(false);
    expect(
      applyAutomaticTransition('REJECTED', 'AUTO_MATCHED', { allowRematchRejected: true }).allowed,
    ).toBe(true);
  });

  it('never opens VERIFIED, rematch flag or not', () => {
    expect(
      applyAutomaticTransition('VERIFIED', 'AUTO_MATCHED', { allowRematchRejected: true }).allowed,
    ).toBe(false);
  });
});

describe('reviewer attribution follows the decision, not the row', () => {
  it.each([
    ['REJECTED', 'AUTO_MATCHED', true],
    ['REJECTED', 'NEEDS_REVIEW', true],
    ['REJECTED', 'UNMAPPED', true],
    ['REJECTED', 'STALE', true],
    // The decision is unchanged, so the person behind it still is.
    ['REJECTED', 'REJECTED', false],
    ['VERIFIED', 'VERIFIED', false],
    // Nothing was reviewer-owned to begin with.
    ['AUTO_MATCHED', 'NEEDS_REVIEW', false],
    ['UNMAPPED', 'AUTO_MATCHED', false],
  ] as const)('%s -> %s clears administrative_mapped_by: %s', (from, to, cleared) => {
    expect(clearsReviewerAttribution(from, to)).toBe(cleared);
  });
});
