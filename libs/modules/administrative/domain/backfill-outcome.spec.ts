import { beforeEach, describe, expect, it } from 'vitest';
import {
  classify,
  count,
  countResolution,
  emptyCounters,
  type BackfillCounters,
} from './backfill-outcome';
import type { Resolution } from './resolver';

/**
 * ADM-008 (#461) — how a run's numbers are arrived at.
 *
 * Pure and tested apart from the loop, because these counters are what a dry
 * run promises and what an operator reads afterwards. The distinction the tests
 * exist for is between **protected** and **no-op**: a `VERIFIED` place the
 * resolver would have re-pointed is not "nothing happened", it is the safety
 * rule doing its job, and folding the two together would hide exactly how much
 * of the catalogue an unattended run is not allowed to touch.
 */

const resolution = (over: Partial<Resolution> = {}): Resolution =>
  ({
    placeId: 'p1',
    status: 'AUTO_MATCHED',
    provinceCode: '01',
    communeCode: '00004',
    legacyDistrictCode: null,
    method: 'boundary_point_in_polygon',
    confidence: 1,
    datasetVersion: 'v5.0.0+…',
    boundaryVersion: 'v5.0.0',
    evidence: [],
    candidates: [],
    reason: null,
    writable: true,
    changed: true,
    ...over,
  }) as Resolution;

describe('classify', () => {
  it('splits a blocked write by the status that blocked it', () => {
    expect(classify('blocked', 'VERIFIED')).toBe('protected_verified');
    expect(classify('blocked', 'REJECTED')).toBe('protected_rejected');
  });

  it('passes every other outcome through unchanged', () => {
    expect(classify('written', 'UNMAPPED')).toBe('written');
    expect(classify('noop', 'AUTO_MATCHED')).toBe('noop');
    expect(classify('conflict', 'AUTO_MATCHED')).toBe('conflict');
  });
});

describe('counting', () => {
  let counters: BackfillCounters;
  beforeEach(() => {
    counters = emptyCounters();
  });

  it('starts at zero in every bucket', () => {
    expect(Object.values(emptyCounters()).every((n) => n === 0)).toBe(true);
  });

  it('counts a dry run and an execute run identically at the resolver level', () => {
    // This is the whole basis on which a dry run is evidence about the execute:
    // both count what the resolver decided, and they differ only in whether the
    // decision was written.
    const dry = emptyCounters();
    const wet = emptyCounters();
    for (const target of [dry, wet]) {
      countResolution(target, resolution());
      countResolution(target, resolution({ status: 'NEEDS_REVIEW' }));
      countResolution(target, resolution({ status: 'UNMAPPED' }));
    }
    expect(dry.autoMatched).toBe(wet.autoMatched);
    expect(dry.needsReview).toBe(wet.needsReview);
    expect(dry.unmapped).toBe(wet.unmapped);

    count(dry, 'would_write');
    count(wet, 'written');
    expect(dry.wouldWrite).toBe(1);
    expect(dry.written).toBe(0);
    expect(wet.written).toBe(1);
  });

  it('does not count a reviewer-owned status as a resolver decision', () => {
    // A protected row never reached the resolver's own buckets: nothing was
    // decided about it, which is different from deciding to leave it alone.
    countResolution(counters, resolution({ status: 'VERIFIED' }));
    expect(counters.autoMatched).toBe(0);
    expect(counters.needsReview).toBe(0);
    expect(counters.unmapped).toBe(0);
  });

  it.each([
    ['written', 'written'],
    ['noop', 'noop'],
    ['protected_verified', 'protectedVerified'],
    ['protected_rejected', 'protectedRejected'],
    ['conflict', 'conflicts'],
    ['failure', 'failures'],
  ] as const)('%s increments %s and nothing else', (outcome, field) => {
    count(counters, outcome);
    expect(counters[field]).toBe(1);
    const others = Object.entries(counters).filter(([key]) => key !== field);
    expect(others.every(([, value]) => value === 0)).toBe(true);
  });
});
