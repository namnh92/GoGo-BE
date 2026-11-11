import { describe, expect, it } from 'vitest';
import { placeTokensAsIds, renderPlaceTokens } from '../place-tokens';
import { makeQaPending, readQaPending } from './pending';
import { FIXTURE_A, FIXTURE_B } from './fixtures';
import { PLACE_QA_PENDING_TTL_MS } from './config';
const now = Date.parse('2026-11-11T10:00:00Z');
const make = () =>
  makeQaPending({
    kind: 'confirm',
    questionMessageId: FIXTURE_A,
    assistantMessageId: FIXTURE_B,
    now,
    topic: 'hours',
    args: { day: 'date', date: '2026-11-12', d: 4, tz: 'Asia/Ho_Chi_Minh' },
    candidates: [FIXTURE_A],
  });
describe('pending v1 reference validation', () => {
  it('preserves topic/date and expires exactly at 30 minutes', () => {
    const p = make();
    expect(readQaPending(p, FIXTURE_B, now)?.args).toEqual(p.args);
    expect(readQaPending(p, FIXTURE_B, now + PLACE_QA_PENDING_TTL_MS - 1)).not.toBeNull();
    expect(readQaPending(p, FIXTURE_B, now + PLACE_QA_PENDING_TTL_MS)).toBeNull();
  });
  it.each([
    (p: ReturnType<typeof make>) => ({ ...p, v: 2 }),
    (p: ReturnType<typeof make>) => ({ ...p, configVersion: 'future' }),
    (p: ReturnType<typeof make>) => ({ ...p, semanticVersion: 2 }),
    (p: ReturnType<typeof make>) => ({ ...p, assistantMessageId: FIXTURE_A }),
    (p: ReturnType<typeof make>) => ({ ...p, retryCount: 2 }),
    (p: ReturnType<typeof make>) => ({
      ...p,
      args: { day: 'date', date: '2026-02-30', d: 1, tz: 'Asia/Ho_Chi_Minh' },
    }),
    (p: ReturnType<typeof make>) => ({ ...p, rawName: 'forbidden' }),
    (p: ReturnType<typeof make>) => ({
      ...p,
      options: [{ optionId: 'x', key: 'place', slot: 0, placeId: FIXTURE_B }],
    }),
    (p: ReturnType<typeof make>) => ({
      ...p,
      slots: [{ slot: 0, sourceMessageId: FIXTURE_B, candidateIds: [FIXTURE_A] }],
    }),
  ])('invalid state never authorizes a lookup', (mutate) =>
    expect(readQaPending(mutate(make()), FIXTURE_B, now)).toBeNull(),
  );
});

describe('fixed no-reference groups across text/export readers', () => {
  it('renders the closed key in both locales, never arbitrary writer prose', async () => {
    const trace = {
      route: 'place_qa',
      placeAnswerGroup: {
        v: 1,
        kind: 'notice',
        message: 'disabled',
        cards: [],
        sources: [],
        options: [],
      },
    };
    expect(placeTokensAsIds('', 'vi', undefined, trace)).toContain('hiện chưa khả dụng');
    expect(placeTokensAsIds('', 'en', undefined, trace)).toContain('currently unavailable');
    expect(renderPlaceTokens('', new Map(), 'neutral', undefined, trace, 'en')).toContain(
      'currently unavailable',
    );
    expect(placeTokensAsIds('malicious prose', 'en', undefined, trace)).toBe('this place');
  });
});
