import { describe, expect, it } from 'vitest';
import {
  answerQueries,
  answerToken,
  mapPrivateTokens,
  parseAnswerToken,
  validAnswerMessage,
} from './tokens';
import { fixtureRow, FIXTURE_A, FIXTURE_B, FIXTURE_C } from './fixtures';
import { parseReferenceGroup } from './reference-group';
import {
  placeToken,
  placeTokensAsIds,
  stripTokenDelimiters,
  truncateTokenSafe,
} from '../place-tokens';
const raw = (suffix: string) => `\uE000a1:${FIXTURE_A}:en:${suffix}\uE001`;
describe('grammar v1', () => {
  it('round-trips locale, weekday, concrete date and semantic keys', () => {
    for (const locale of ['vi', 'en'] as const)
      for (let d = 0; d < 7; d++) {
        const q = {
          placeId: FIXTURE_A,
          locale,
          topic: 'hours' as const,
          day: 'weekday' as const,
          d,
        };
        expect(parseAnswerToken(answerToken(q))).toEqual(q);
      }
    const q = {
      placeId: FIXTURE_A,
      locale: 'en' as const,
      topic: 'hours' as const,
      day: 'date' as const,
      date: '2026-11-11',
      d: 3,
      tz: 'Asia/Ho_Chi_Minh' as const,
    };
    expect(parseAnswerToken(answerToken(q))).toEqual(q);
  });
  it.each([
    'hours:day=date:date=2026-02-30:d=1:tz=Asia/Ho_Chi_Minh',
    'hours:day=date:date=2026-11-11:d=4:tz=Asia/Ho_Chi_Minh',
    'hours:day=weekday:d=7',
    'hours:day=weekday:d=3:date=2026-11-11',
    'hours:d=3',
    'price:o=absent',
    'price:k=wifi',
    'amenity:k=wifi:k=wifi',
    'amenity:k=',
    'amenity:k=<script>',
    'suitability:n=100',
    'suitability:n=0',
    'suitability:n=2.5',
    'suitability:n=-2',
    'suitability:n=no',
    'hours:day=date:date=2026-11-11:d=3:tz=UTC',
    'unknown',
    'price:price=1',
  ])('rejects invalid semantics without a lookup: %s', (suffix) =>
    expect(parseAnswerToken(raw(suffix))).toBeNull(),
  );
  it('rejects future versions, uppercase UUIDs, oversized and incomplete tokens', () => {
    for (const value of [
      raw('price').replace('a1:', 'a2:'),
      raw('price').replace(FIXTURE_A, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
      raw(`amenity:k=${'a'.repeat(500)}`),
      raw('price').slice(0, -1),
    ])
      expect(parseAnswerToken(value)).toBeNull();
  });
  it('bounds message counts independently of clarification identity references', () => {
    expect(validAnswerMessage(raw('price').repeat(8))).toBe(true);
    expect(validAnswerMessage(raw('price').repeat(9))).toBe(false);
    expect(
      validAnswerMessage(
        [FIXTURE_A, FIXTURE_B, FIXTURE_C]
          .map((placeId) => answerToken({ placeId, locale: 'vi', topic: 'price' }))
          .join(''),
      ),
    ).toBe(false);
    const text = [FIXTURE_A, FIXTURE_B, FIXTURE_C].map(placeToken).join(' ');
    expect(
      parseReferenceGroup(
        {
          v: 1,
          kind: 'clarification',
          cards: [FIXTURE_A, FIXTURE_B, FIXTURE_C],
          sources: [],
          options: [],
        },
        text,
      ),
    ).not.toBeNull();
    const row = fixtureRow('bad', [FIXTURE_A, FIXTURE_B]);
    expect(
      parseReferenceGroup(
        { ...row.trace.placeAnswerGroup, cards: [FIXTURE_A, FIXTURE_A] },
        row.text,
      ),
    ).toBeNull();
  });
  it('property: arbitrary private runs never leak through export; cuts never split a reference', () => {
    let seed = 856;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 300; i++) {
      const noise = Array.from({ length: next() % 90 }, () =>
        String.fromCharCode(next() % 256),
      ).join('');
      const input = `start\uE000${noise}\uE001 end\uE000unfinished`;
      expect(placeTokensAsIds(input)).not.toMatch(/[\uE000\uE001]/);
      expect(stripTokenDelimiters(input)).not.toMatch(/[\uE000\uE001]/);
    }
    const token = raw('hours:day=weekday:d=3');
    for (let n = 1; n < token.length; n++)
      expect(truncateTokenSafe('abc' + token + 'end', 3 + n)).toBe('abc');
    expect(mapPrivateTokens('\uE000bad\uE000a2:x\uE001\uE001', () => '?')).toBe('???');
    expect(answerQueries(raw('price'))).toHaveLength(1);
  });
});
