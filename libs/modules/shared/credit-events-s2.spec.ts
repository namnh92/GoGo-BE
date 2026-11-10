import { describe, expect, it } from 'vitest';
import { submissionCreditFacts } from './assistant-credits';

describe('#829 S2 evidence components', () => {
  it('uses the owner-authorized +10 evidence component', () => {
    expect(submissionCreditFacts(1)).toEqual({ base: 50, photoBonus: 10, total: 60 });
    expect(submissionCreditFacts(4, false)).toEqual({ base: 0, photoBonus: 10, total: 10 });
  });
});
