import { describe, expect, it } from 'vitest';
import intents from '../../../search/eval/intent-cases.vi.json';
import { PlaceQaClassifier } from './classifier';
const classifier = new PlaceQaClassifier();
const options = { now: new Date('2026-11-11T10:00:00Z'), locale: 'vi' as const };
// Owner "Theo đề xuất", dev/policy/decisions-log.md, 2026-11-11:
// §3.1 applies to vi-065; §7 preserves the other 156 intent cases.
describe('156 existing intent cases retain non-QA admission (name-only probes need equality)', () => {
  for (const c of intents.cases.filter((c) => c.id !== 'vi-065'))
    it(c.id, () => {
      expect(['not_qa', 'name_only']).toContain(classifier.classify(c.text, null, options).kind);
    });
});
it('vi-065 is the owner-approved named-place hours question', () => {
  const c = intents.cases.find((c) => c.id === 'vi-065')!;
  expect(c.text).toBe('Mấy giờ thì quán Highlands đóng cửa?');
  expect(classifier.classify(c.text, null, options)).toMatchObject({
    kind: 'named_place_question',
    topic: 'hours',
  });
});
