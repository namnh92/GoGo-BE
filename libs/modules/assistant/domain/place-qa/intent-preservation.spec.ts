import { describe, expect, it } from 'vitest';
import intents from '../../../search/eval/intent-cases.vi.json';
import { PlaceQaClassifier } from './classifier';
const classifier = new PlaceQaClassifier();
describe('all existing intent cases retain non-QA admission (name-only probes need equality)', () => {
  for (const c of intents.cases)
    it(c.id, () => {
      const result = classifier.classify(c.text, null, {
        now: new Date('2026-11-11T10:00:00Z'),
        locale: 'vi',
      });
      if (c.id === 'vi-065') {
        // §3.1 names this factual intent QA; §7's all-157 preservation gate
        // conflicts. Owner clarification is pending; do not claim that gate.
        expect(result.kind).toBe('named_place_question');
      } else expect(['not_qa', 'name_only']).toContain(result.kind);
    });
});
