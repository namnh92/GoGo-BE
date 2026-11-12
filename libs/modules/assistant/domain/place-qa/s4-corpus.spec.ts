import { describe, expect, it } from 'vitest';
import s3 from '../../eval/place-qa-cases.vi.json';
import s4 from '../../eval/place-qa-cases.s4.vi.json';
import { PlaceQaClassifier } from './classifier';
import { answerToken } from './tokens';
const classifier = new PlaceQaClassifier();
describe('S4 manifest and grammar diagnostics', () => {
  it('has all disjoint core buckets and three referent sources per topic', () => {
    const ids = [...s4.coreS3Ids, ...s4.coreS4Ids];
    expect(ids).toHaveLength(234);
    expect(new Set(ids).size).toBe(234);
    const cases = [...s3.cases, ...s4.cases].filter((c) => ids.includes(c.id));
    const counts: Record<string, number> = {};
    for (const c of cases) counts[c.bucket] = (counts[c.bucket] ?? 0) + 1;
    expect(counts).toMatchObject({
      hours: 12,
      price: 12,
      address: 12,
      directions: 12,
      parking: 12,
      amenity: 12,
      suitability: 12,
      rating: 12,
      contact: 12,
      overview: 12,
      out_of_data: 12,
      resolution: 40,
      branch: 12,
      not_found: 12,
      hard_negative: 30,
      compare: 8,
    });
    for (const topic of [
      'hours',
      'price',
      'address',
      'directions',
      'parking',
      'amenity',
      'suitability',
      'rating',
      'contact',
      'overview',
      'out_of_data',
    ])
      for (const source of ['context', 'sole', 'ordinal'])
        expect(ids).toContain(`s4-${topic}-${source}`);
  });
  for (const c of s4.cases.filter((c) => c.bucket !== 'topic'))
    it(c.id, () => {
      const r = classifier.classify(
        c.text,
        c.fixture.contextPlace
          ? { kind: 'place', id: '11111111-1111-4111-8111-111111111111' }
          : null,
        { now: new Date(s4.clock), locale: 'vi' },
      );
      expect(r.kind).toBe(c.bucket === 'compare' ? 'compare' : 'referent_question');
      if (r.kind !== 'not_qa') {
        if ('topic' in c.expected) expect(r.topic).toBe(c.expected.topic);
        expect(() =>
          answerToken({
            placeId: '11111111-1111-4111-8111-111111111111',
            locale: 'vi',
            topic: r.topic,
            ...r.args,
          }),
        ).not.toThrow();
      }
    });
});
