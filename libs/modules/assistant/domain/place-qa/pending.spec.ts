import { describe, expect, it } from 'vitest';
import { placeTokensAsIds, renderPlaceTokens } from '../place-tokens';
import { isTypedConfirm, confirmText, makeQaPending, readQaPending } from './pending';
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
      slots: [{ slot: 0, sourceMessageId: 'not-a-message-id', candidateIds: [FIXTURE_A] }],
    }),
  ])('invalid state never authorizes a lookup', (mutate) =>
    expect(readQaPending(mutate(make()), FIXTURE_B, now)).toBeNull(),
  );
  // GoGo-BE#873 Astra F-01, shape rev3 §4.5: a slot's `sourceMessageId` (the
  // name-bearing message) is a reference of its own, distinct from
  // `questionMessageId`. Parsing accepts it; PlaceQaService re-reads BOTH ids
  // under the user and conversation before any lookup (place-qa.service.spec).
  it('keeps a distinct name-bearing source reference', () => {
    const p = {
      ...make(),
      slots: [{ slot: 0 as const, sourceMessageId: FIXTURE_B, candidateIds: [FIXTURE_A] }],
    };
    expect(readQaPending(p, FIXTURE_B, now)).toMatchObject({
      questionMessageId: make().questionMessageId,
      slots: [{ sourceMessageId: FIXTURE_B }],
    });
  });
});

describe('Astra A2: full identity confirmation copy', () => {
  it('recognizes complete chips and legacy coded text, never a command word alone inside a name', () => {
    expect(isTypedConfirm('Xác nhận Song Ngọc · Phường Ba Đình, Hà Nội')).toBe(true);
    expect(isTypedConfirm('Xác nhận Song Ngọc (123456)')).toBe(true);
    expect(isTypedConfirm('Confirm Cafe is open today?')).toBe(false);
    expect(isTypedConfirm('Xác Nhận Bistro giá bao nhiêu?')).toBe(false);
  });

  it('uses the complete name and area, never a visible code', () => {
    expect(confirmText('vi', 'Song Ngọc', 'Phường Ba Đình, Hà Nội')).toBe(
      'Xác nhận Song Ngọc · Phường Ba Đình, Hà Nội',
    );
    expect(confirmText('en', 'Song Ngọc', 'Ba Dinh, Hanoi')).toBe(
      'Confirm Song Ngọc · Ba Dinh, Hanoi',
    );
  });
  it('does not truncate an oversized identity or invent a missing area', () => {
    expect(confirmText('vi', 'a'.repeat(190), 'Phường Ba Đình, Hà Nội')).toBeNull();
    expect(confirmText('vi', 'Song Ngọc', undefined)).toBeNull();
  });
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
