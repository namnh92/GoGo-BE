import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildIntentRequest,
  fallbackIntent,
  mapIntentAnswers,
  parseIntentFacts,
  type IntentFacts,
} from './intent';
import { SEED_TAXONOMY } from '../eval/seed-taxonomy';

type Case = {
  id: string;
  text: string;
  tags: string[];
  expect: Pick<IntentFacts, 'partySize' | 'timeHint' | 'areaText'> & {
    budget: { amount: number; mode: 'per_person' | 'total' | null } | null;
    category: string | null;
    occasion: string | null;
    inScope: boolean;
    needsClarification: boolean;
  };
  knownParserGaps?: (keyof IntentFacts)[];
};

const dataset = JSON.parse(
  readFileSync(path.join(__dirname, '../eval/intent-cases.vi.json'), 'utf8'),
) as { cases: Case[] };

describe('intent facts — the owner example', () => {
  it('reads party, per-person budget, time and area without a model', () => {
    expect(
      parseIntentFacts(
        'Tối nay 4 người đi ăn lẩu khoảng 300k/người, gần Cầu Giấy, ưu tiên quán yên tĩnh.',
      ),
    ).toEqual({
      partySize: 4,
      budget: { amount: 300_000, currency: 'VND', mode: 'per_person' },
      timeHint: 'tonight',
      areaText: 'Cầu Giấy',
    });
  });

  it('a per-person phrase is not a party of one', () => {
    expect(parseIntentFacts('Nướng Hàn Quốc 300k/1 người, nhóm 6').partySize).toBe(6);
    expect(parseIntentFacts('khoảng 300k một người').partySize).toBeNull();
  });

  it('amounts are integer VND, slang included', () => {
    const amount = (t: string) => parseIntentFacts(t).budget?.amount;
    expect(amount('1tr5')).toBe(1_500_000);
    expect(amount('1 củ 2')).toBe(1_200_000);
    expect(amount('2 lít')).toBe(200_000);
    expect(amount('1 triệu rưỡi')).toBe(1_500_000);
    expect(amount('1,5 triệu')).toBe(1_500_000);
    expect(amount('300.000đ')).toBe(300_000);
    expect(amount('150-200k/ng')).toBe(200_000);
    expect(amount('đi 4 người')).toBeUndefined();
  });
});

describe('intent facts — Vietnamese case set', () => {
  it(`holds ${dataset.cases.length} cases (100–200 required)`, () => {
    expect(dataset.cases.length).toBeGreaterThanOrEqual(100);
    expect(dataset.cases.length).toBeLessThanOrEqual(200);
    expect(new Set(dataset.cases.map((c) => c.id)).size).toBe(dataset.cases.length);
  });

  for (const c of dataset.cases) {
    it(`${c.id}: ${c.text}`, () => {
      const facts = parseIntentFacts(c.text);
      const expected: IntentFacts = {
        partySize: c.expect.partySize,
        budget: c.expect.budget ? { ...c.expect.budget, currency: 'VND' } : null,
        timeHint: c.expect.timeHint,
        areaText: c.expect.areaText,
      };
      for (const field of Object.keys(expected) as (keyof IntentFacts)[]) {
        if (c.knownParserGaps?.includes(field)) {
          // A documented gap: the day the parser gets it right, this fails and
          // the dataset entry loses its gap.
          expect(facts[field], `${field} is a known gap`).not.toEqual(expected[field]);
        } else {
          expect(facts[field], field).toEqual(expected[field]);
        }
      }
    });
  }
});

describe('intent questions', () => {
  it('options are the taxonomy keys passed in, plus a no-match option', () => {
    const { questions, state } = buildIntentRequest('đi ăn lẩu', SEED_TAXONOMY);
    expect(state).toEqual({ request: 'đi ăn lẩu' });
    const category = questions.category;
    expect(category?.type).toBe('choice');
    expect(Object.keys(category?.type === 'choice' ? category.criteria : {})).toEqual([
      ...SEED_TAXONOMY.category.map((t) => t.key),
      'none',
    ]);
    expect(Object.keys(questions).filter((k) => k.startsWith('mood:'))).toHaveLength(5);
    expect(Object.keys(questions).filter((k) => k.startsWith('setting:'))).toHaveLength(4);
  });

  it('facts are never asked of the model', () => {
    const { questions } = buildIntentRequest('4 người 300k/người', SEED_TAXONOMY);
    const text = JSON.stringify(questions).toLowerCase();
    // The criteria may mention a budget as something code fills in; no
    // question may ask the model for a count, an amount, a distance or hours.
    for (const word of ['how many', 'how much', 'price', 'distance', 'opening hours', 'amount']) {
      expect(text).not.toContain(word);
    }
  });

  it('caps the request sent', () => {
    expect(buildIntentRequest('x'.repeat(2_000), SEED_TAXONOMY).state.request).toHaveLength(500);
  });
});

describe('intent mapping', () => {
  const facts = parseIntentFacts('Tối nay 4 người đi ăn lẩu');
  const answers = (over: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = {
      in_scope: { type: 'noul', noul: 0.97 },
      category: {
        type: 'choice',
        choice: 'restaurant',
        probabilities: { restaurant: 0.9, cafe: 0.1 },
        confidence: 0.8,
      },
      occasion: { type: 'choice', choice: 'group' },
      needs_clarification: { type: 'noul', noul: 0.1 },
      conflicting: { type: 'noul', noul: 0.05 },
      'mood:chill': { type: 'noul', noul: 0.8 },
      'mood:festive': { type: 'noul', noul: 0.2 },
      'mood:cozy': { type: 'noul', noul: 0.6 },
      'setting:indoor': { type: 'noul', noul: 0.4 },
      ...over,
    };
    return base as never;
  };

  it('keeps what the model returned and invents nothing', () => {
    const r = mapIntentAnswers(facts, answers(), 'typesafe/jev-1.14-20261014');
    expect(r.source).toBe('decision_model');
    expect(r.model).toBe('typesafe/jev-1.14-20261014');
    expect(r.facts).toBe(facts);
    expect(r.category).toEqual({
      key: 'restaurant',
      probabilities: { restaurant: 0.9, cafe: 0.1 },
      confidence: 0.8,
    });
    expect(r.occasion).toEqual({ key: 'group' });
    expect(r.moods).toEqual([
      { key: 'chill', probability: 0.8 },
      { key: 'cozy', probability: 0.6 },
    ]);
    expect(r.settings).toEqual([]);
    expect(r.clarification).toEqual({ needed: false, reasons: [] });
  });

  it('no-match options become null', () => {
    const r = mapIntentAnswers(
      facts,
      answers({
        category: { type: 'choice', choice: 'none' },
        occasion: { type: 'choice', choice: 'not_stated' },
      }),
      'm',
    );
    expect(r.category.key).toBeNull();
    expect(r.occasion.key).toBeNull();
  });

  it('out of scope, unclear and conflicting each ask, with the reason', () => {
    expect(
      mapIntentAnswers(facts, answers({ in_scope: { type: 'noul', noul: 0.1 } }), 'm')
        .clarification,
    ).toEqual({
      needed: true,
      reasons: ['out_of_scope'],
    });
    expect(
      mapIntentAnswers(
        facts,
        answers({
          needs_clarification: { type: 'noul', noul: 0.7 },
          conflicting: { type: 'noul', noul: 0.9 },
        }),
        'm',
      ).clarification.reasons,
    ).toEqual(['unclear_activity', 'conflicting_preferences']);
  });
});

describe('intent fallback', () => {
  it('matches one synonym family, never guesses a mood or occasion', () => {
    const text = 'Tìm quán cà phê yên tĩnh ở Quận 1';
    const r = fallbackIntent(text, parseIntentFacts(text), SEED_TAXONOMY, 'disabled');
    expect(r).toMatchObject({
      source: 'fallback',
      model: null,
      fallbackReason: 'disabled',
      category: { key: 'cafe' },
      occasion: { key: null },
      moods: [],
      settings: [],
      inScope: { value: true, probability: null },
      clarification: { needed: false, reasons: [] },
    });
  });

  it('two matching families is no category', () => {
    const text = 'quán ăn hay quán cà phê';
    expect(
      fallbackIntent(text, parseIntentFacts(text), SEED_TAXONOMY, 'timeout').category.key,
    ).toBeNull();
  });
});
