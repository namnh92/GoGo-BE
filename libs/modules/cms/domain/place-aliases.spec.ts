import { describe, expect, it } from 'vitest';
import { planAliasWrite } from './place-aliases';
import corpus from '../../assistant/eval/place-qa-cases.s5.vi.json';

const evidence = {
  sourceType: 'editorial',
  sourceReference: 'Merchant interview recorded 2026-11-01',
  collectedAt: '2026-11-01T10:00:00Z',
};
const input = (aliases: string[]) => ({
  aliases,
  aliasProvenance: evidence,
  expectedUpdatedAt: '2026-11-01T10:00:00Z',
});
describe('S5 independent editorial alias input', () => {
  it.each(corpus.places)('accepts realistic aliases for $name', (place) => {
    expect(planAliasWrite(input(place.aliases))?.entries).toHaveLength(place.aliases.length);
  });
  it('deduplicates Vietnamese spelling/space variants, preserving the entered display text', () => {
    expect(planAliasWrite(input(['Nhà Hồ', ' NHA   HO ']))?.entries).toEqual([
      { alias: 'NHA   HO', aliasNormalized: 'nha ho' },
    ]);
  });
  it('distinguishes omission from clearing, and requires evidence for removal', () => {
    expect(planAliasWrite({})).toBeUndefined();
    expect(planAliasWrite(input([]))?.entries).toEqual([]);
    expect(() =>
      planAliasWrite({ aliases: [], expectedUpdatedAt: input([]).expectedUpdatedAt }),
    ).toThrow();
    expect(() => planAliasWrite({ aliasProvenance: evidence })).toThrow();
  });
  it.each([
    '',
    '   ',
    'Nhà Hồ\n',
    'Nhà\tHồ',
    'Nhà\u0000Hồ',
    'Nhà\u200bHồ',
    'Nhà\u2028Hồ',
    'a'.repeat(121),
  ])('rejects empty/control/oversized text without echoing it (%#)', (value) => {
    expect(() => planAliasWrite(input([value]))).toThrow('Aliases require valid bounded text');
  });
  it('enforces 20 entries and 120 characters before deduplication', () => {
    expect(planAliasWrite(input(['a'.repeat(120)]))?.entries).toHaveLength(1);
    expect(planAliasWrite(input(Array(20).fill('NBH')))?.entries).toHaveLength(1);
    expect(() => planAliasWrite(input(Array(21).fill('NBH')))).toThrow();
  });
  it('requires a form version even for an empty replacement', () => {
    expect(() => planAliasWrite({ aliases: [], aliasProvenance: evidence })).toThrow();
  });
  it.each([
    { ...evidence, sourceReference: 'https://maps.google.com/place/coffee' },
    { ...evidence, sourceType: 'provider' },
    { ...evidence, sourceType: 'community' },
    { ...evidence, sourceType: 'model' },
    { ...evidence, sourceType: 'user_chat' },
    { ...evidence, sourceReference: 'job:abc' },
    { ...evidence, collectedAt: '2099-01-01T00:00:00Z' },
    { ...evidence, collectedAt: '2026-11-01' },
    { ...evidence, sourceReference: '' },
  ])('rejects missing/unsafe provenance (%#)', (aliasProvenance) => {
    expect(() => planAliasWrite({ ...input(['NBH']), aliasProvenance })).toThrow();
  });
});
