import { describe, expect, it } from 'vitest';

import {
  DECISION_STATES,
  acceptRefusal,
  decisionState,
  materializedDecision,
  settlementOf,
  type AcceptInput,
} from './override-sets';

describe('decisionState', () => {
  it('reports a draft decision as a draft', () => {
    expect(decisionState({ decision: 'ACCEPT' }, false)).toBe('ACCEPTED_DRAFT');
    expect(decisionState({ decision: 'REJECT' }, true)).toBe('REJECTED_DRAFT');
  });

  it('reports a row nobody decided as undecided, or superseded when only history remains', () => {
    expect(decisionState(null, false)).toBe('UNDECIDED');
    expect(decisionState(null, true)).toBe('SUPERSEDED');
  });

  it('reports a materialised decision as settled, not undecided', () => {
    // GoGo-BE#619: after a materialisation the derived version carried the
    // decision on the row, and the queue still called it UNDECIDED.
    expect(decisionState(null, false, 'ACCEPT')).toBe('MATERIALIZED_ACCEPT');
    expect(decisionState(null, false, 'REJECT')).toBe('MATERIALIZED_REJECT');
    // Settled beats a superseded history: the history belongs to the draft, the
    // decision belongs to the version.
    expect(decisionState(null, true, 'ACCEPT')).toBe('MATERIALIZED_ACCEPT');
  });

  it('reports a row whose source another row settled as settled, below any draft or own stamp', () => {
    expect(decisionState(null, false, null, true)).toBe('SOURCE_SETTLED');
    expect(decisionState(null, true, null, true)).toBe('SOURCE_SETTLED');
    expect(decisionState(null, false, 'REJECT', true)).toBe('MATERIALIZED_REJECT');
    expect(decisionState({ decision: 'ACCEPT' }, false, null, true)).toBe('ACCEPTED_DRAFT');
  });

  it('lets a later draft decision re-decide a materialised row', () => {
    expect(decisionState({ decision: 'ACCEPT' }, false, 'REJECT')).toBe('ACCEPTED_DRAFT');
    expect(decisionState({ decision: 'REJECT' }, false, 'ACCEPT')).toBe('REJECTED_DRAFT');
  });

  it('lists every state the filter accepts, materialised ones included', () => {
    expect(DECISION_STATES).toEqual([
      'UNDECIDED',
      'ACCEPTED_DRAFT',
      'REJECTED_DRAFT',
      'SUPERSEDED',
      'MATERIALIZED_ACCEPT',
      'MATERIALIZED_REJECT',
      'SOURCE_SETTLED',
    ]);
  });
});

describe('materializedDecision', () => {
  it('reads only the two decision kinds out of the free-text column', () => {
    expect(materializedDecision('ACCEPT')).toBe('ACCEPT');
    expect(materializedDecision('REJECT')).toBe('REJECT');
    expect(materializedDecision(null)).toBeNull();
    expect(materializedDecision('')).toBeNull();
    expect(materializedDecision('accept')).toBeNull();
    expect(materializedDecision('SKIPPED')).toBeNull();
  });
});

describe('settlementOf', () => {
  it('is nothing when the version holds no override for the source', () => {
    expect(settlementOf({ newCode: '00025' }, null)).toEqual({
      materialized: null,
      sourceSettled: false,
    });
  });

  it("reads the override edge as this row's own decision when it names this row's target", () => {
    // GoGo-BE#622: an earlier materialisation dropped the stamp on r2/r3, and
    // the row went back to "undecided" while its edge was still canonical.
    expect(settlementOf({ newCode: '00025' }, { targetCode: '00025' })).toEqual({
      materialized: 'ACCEPT',
      sourceSettled: false,
    });
  });

  it('settles a sibling row when the override names a different successor', () => {
    expect(settlementOf({ newCode: '00008' }, { targetCode: '00025' })).toEqual({
      materialized: null,
      sourceSettled: true,
    });
    expect(settlementOf({ newCode: null }, { targetCode: '00025' })).toEqual({
      materialized: null,
      sourceSettled: true,
    });
  });
});

describe('acceptRefusal — one source, one successor (GoGo-BE#622)', () => {
  const target = {
    code: '00008',
    effectiveFrom: '2025-07-01',
    level: 'COMMUNE',
    status: 'ACTIVE',
    parentCode: '01',
  };
  const base = (): AcceptInput => ({
    set: { id: 's', baseDatasetId: 'v1', revision: 0, status: 'DRAFT' },
    row: { id: 'row-b', datasetVersionId: 'v1', oldCode: '00007' },
    target,
    parentExists: true,
    edgeAlreadyCanonical: false,
    sourceOverride: null,
    siblingAccept: null,
  });

  it('accepts a source nobody has sent anywhere', () => {
    expect(acceptRefusal(base())).toBeNull();
  });

  it('refuses a second successor for a source the base already resolved by override', () => {
    // DEV 2026-09-17: r1 said 00007 → 00025; accepting 00007 → 00008 on the
    // sibling row minted r2 with two successors and OVERRIDE_CONFLICT.
    const refusal = acceptRefusal({
      ...base(),
      sourceOverride: { targetCode: '00025', sourceVersion: 'override:r1' },
    });
    expect(refusal?.code).toBe('OVERRIDE_SOURCE_ALREADY_RESOLVED');
    expect(refusal?.message).toContain('00025');
    expect(refusal?.message).toContain('override:r1');
  });

  it('keeps the identical edge as the already-canonical refusal, not a source conflict', () => {
    const refusal = acceptRefusal({
      ...base(),
      edgeAlreadyCanonical: true,
      sourceOverride: { targetCode: '00008', sourceVersion: 'override:r1' },
    });
    expect(refusal?.code).toBe('OVERRIDE_EDGE_ALREADY_CANONICAL');
  });

  it('refuses a different successor accepted on a sibling row of the same draft', () => {
    // DEV 2026-09-17: 00016 → 00008 and 00016 → 00004 accepted in one set.
    const refusal = acceptRefusal({
      ...base(),
      siblingAccept: { quarantineRowId: 'row-a', targetCode: '00004' },
    });
    expect(refusal?.code).toBe('OVERRIDE_SOURCE_CONFLICT_IN_DRAFT');
    expect(refusal?.message).toContain('00004');
  });

  it('refuses the same successor accepted on a sibling row, which would write the edge twice', () => {
    const refusal = acceptRefusal({
      ...base(),
      siblingAccept: { quarantineRowId: 'row-a', targetCode: '00008' },
    });
    expect(refusal?.code).toBe('OVERRIDE_SOURCE_ALREADY_DECIDED_IN_DRAFT');
  });

  it('checks the target itself before it checks the source', () => {
    const refusal = acceptRefusal({
      ...base(),
      target: { ...target, status: 'INACTIVE' },
      sourceOverride: { targetCode: '00025', sourceVersion: 'override:r1' },
    });
    expect(refusal?.code).toBe('OVERRIDE_TARGET_NOT_CURRENT');
  });
});
