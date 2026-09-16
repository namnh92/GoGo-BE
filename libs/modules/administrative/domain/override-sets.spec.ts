import { describe, expect, it } from 'vitest';

import { DECISION_STATES, decisionState, materializedDecision } from './override-sets';

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
