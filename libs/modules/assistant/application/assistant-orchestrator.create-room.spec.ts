import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantFrame } from '../domain/assistant.types';
import { AssistantAreaResolver } from './area-resolver.service';
import { v5Query } from './area.fixture';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { newTurnState } from './turn-state';

/**
 * GoGo-BE#733 — "tạo kèo" through the chat: ask only what is missing, show
 * places when the area is known, carry a `create_room` card, and ask back when
 * the area is both a city and a ward. The decision provider is a stub (no
 * inference here); the area resolver is the real one over a v5.1.0-shaped
 * fixture. Owner 2026-10-31: the card is shown at once (Q-1); a day with no
 * hour is asked, never turned into an assumed 19:00 (Q-2).
 */

// Sunday 2026-11-01 01:00 +07: the coming Saturday is 2026-11-07.
const NOW = new Date('2026-10-31T18:00:00Z');
const SATURDAY_EVENING = '2026-11-07T12:00:00.000Z';
const PLACE_1 = '0b6f3c1e-7d2a-4c11-9a3e-5f1d2c3b4a01';
const PLACE_2 = '0b6f3c1e-7d2a-4c11-9a3e-5f1d2c3b4a02';

const base = {
  in_scope: { type: 'noul', noul: 0.99 },
  needs_clarification: { type: 'noul', noul: 0.01 },
  conflicting: { type: 'noul', noul: 0.01 },
  category: { type: 'choice', choice: 'category:cafe' },
  occasion: { type: 'choice', choice: 'not_stated' },
  assistant_intent: { type: 'choice', choice: 'recommend_places' },
  action: { type: 'choice', choice: 'create_room', confidence: 0.9 },
  needs_unverified_attribute: { type: 'noul', noul: 0.01 },
};

type HistoryRow = { role: 'user' | 'assistant'; text: string; follow_ups: { field: string }[] };
const asked = (field: string): HistoryRow => ({
  role: 'assistant',
  text: 'Bạn chọn giúp mình nhé.',
  follow_ups: [{ field }],
});
const said = (text: string): HistoryRow => ({ role: 'user', text, follow_ups: [] });

type Run = {
  frames: AssistantFrame[];
  text: string;
  searches: Record<string, unknown>[];
  jevRequests: string[];
  superseded: unknown[][];
  proposal: { kind: string; values: { field: string; value: unknown; origin: string }[] } | null;
  followUps: { field: string; options: { label: string; text: string }[] }[];
  value: (field: string) => { value: unknown; origin: string } | undefined;
};

async function turn(
  text: string,
  opts: {
    answers?: Record<string, unknown> | null;
    history?: HistoryRow[];
    context?: { kind: 'place' | 'plan'; id: string };
  } = {},
): Promise<Run> {
  const frames: AssistantFrame[] = [];
  const searches: Record<string, unknown>[] = [];
  const jevRequests: string[] = [];
  const superseded: unknown[][] = [];
  const answers = opts.answers === undefined ? base : opts.answers;
  const orchestrator = new AssistantOrchestrator(
    {
      ASSISTANT_FIRST_TEXT_TIMEOUT_MS: 5_000,
      ASSISTANT_JEV_TIMEOUT_MS: 4_000,
      ASSISTANT_MAX_OUTPUT_TOKENS: 100,
    } as never,
    {
      history: async () => opts.history ?? [],
      insertProposal: async (p: { kind: string; values: unknown }) => ({
        id: 'p-new',
        conversation_id: 'c',
        message_id: 'm',
        kind: p.kind,
        values: p.values,
        created_at: NOW.toISOString(),
        expires_at: NOW.toISOString(),
      }),
      insertSupersedingProposal: async (p: {
        conversationId: string;
        kind: string;
        values: unknown;
      }) => {
        superseded.push([p.conversationId, p.kind]);
        return {
          row: {
            id: 'p-new',
            conversation_id: 'c',
            message_id: 'm',
            kind: p.kind,
            values: p.values,
            created_at: NOW.toISOString(),
            expires_at: NOW.toISOString(),
          },
          superseded: 1,
        };
      },
    } as never,
    {
      taxonomy: async () => ({
        category: [
          { key: 'category:cafe', label: 'cà phê' },
          { key: 'category:restaurant', label: 'nhà hàng' },
        ],
        mood: [],
        setting: [],
        suitability: [],
        categorySynonyms: { 'category:cafe': ['cà phê'], 'category:restaurant': ['ăn tối'] },
      }),
      labels: () => new Map<string, string>(),
    } as never,
    {
      search: async (q: Record<string, unknown>) => {
        searches.push(q);
        return { results: [{ id: PLACE_1 }, { id: PLACE_2 }] };
      },
    } as never,
    {
      placeTags: async () => new Map(),
      planCard: async () => ({ kind: 'plan', available: false, facts: {} }),
      placeCard: async (id: string) => ({
        kind: 'place',
        placeId: id,
        available: true,
        facts: { name: `Quán ${id}` },
      }),
    } as never,
    new AssistantAreaResolver(v5Query() as never),
    { searchPublished: async () => [] } as never,
    {} as never,
    answers === null
      ? null
      : ({
          decide: async (req: { state: { request: string } }) => {
            jevRequests.push(req.state.request);
            return {
              model: 'typesafe/jev-1.14',
              answers,
              usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 },
            };
          },
        } as never),
    null,
  );
  await orchestrator.run(
    {
      messageId: 'm',
      ledgerId: 'l',
      conversationId: 'c',
      userId: 'u',
      text,
      locale: 'vi',
      context: opts.context ?? null,
    },
    newTurnState(),
    { emit: async (f: AssistantFrame) => void frames.push(f) } as never,
    new AbortController().signal,
  );
  const proposalFrame = frames.find((f) => f.type === 'proposal') as
    { proposal: Run['proposal'] } | undefined;
  const followUps =
    (frames.find((f) => f.type === 'follow_ups') as { groups: Run['followUps'] } | undefined)
      ?.groups ?? [];
  const proposal = proposalFrame?.proposal ?? null;
  return {
    frames,
    text: frames
      .filter((f): f is Extract<AssistantFrame, { type: 'delta' }> => f.type === 'delta')
      .map((f) => f.text)
      .join(''),
    searches,
    jevRequests,
    superseded,
    proposal,
    followUps,
    value: (field) => proposal?.values.find((v) => v.field === field),
  };
}

const fields = (r: Run) => r.followUps.map((g) => g.field);
const cards = (r: Run) => r.frames.filter((f) => f.type === 'card').length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('#733 a "tạo kèo" turn', () => {
  it('U-8 Jev says gogo_guide + create_room: places, a room card, and the missing items', async () => {
    const r = await turn('tạo kèo cà phê ở Hà Nội', {
      answers: { ...base, assistant_intent: { type: 'choice', choice: 'gogo_guide' } },
    });
    expect(r.frames.some((f) => f.type === 'step' && f.step === 'searching_places')).toBe(true);
    expect(cards(r)).toBeGreaterThanOrEqual(1);
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('administrativeArea')).toMatchObject({
      value: { provinceCode: '01', communeCode: null },
      origin: 'explicit',
    });
    expect(r.value('seedPlaceIds')).toMatchObject({ origin: 'assumed' });
    // time › party_size › budget; the contract cap keeps two.
    expect(fields(r)).toEqual(['time', 'party_size']);
  });

  it('U-9 no area: asks area and the hour only, the card carries what was said', async () => {
    const r = await turn('tạo kèo ăn tối thứ 7 với 4 người, 300k/người', {
      answers: { ...base, category: { type: 'choice', choice: 'category:restaurant' } },
    });
    expect(fields(r)).toEqual(['area', 'time']);
    expect(cards(r)).toBe(0);
    expect(r.value('participantCount')).toEqual(
      expect.objectContaining({ value: 4, origin: 'explicit' }),
    );
    expect(r.value('budgetMode')).toMatchObject({ value: 'per_person' });
    expect(r.value('budgetAmount')).toMatchObject({ value: 300_000, origin: 'explicit' });
    // Q-2: "thứ 7" names a day, not an hour.
    expect(r.value('startAt')).toBeUndefined();
    expect(r.value('endAt')).toBeUndefined();
    // The hour is asked for that day, with chips the parser reads back.
    const time = r.followUps.find((g) => g.field === 'time')!;
    expect(time.options.map((o) => o.text)).toEqual(['Thứ 7 trưa', 'Thứ 7 chiều', 'Thứ 7 tối']);
    expect(r.text).toMatch(/khu vực nào/);
    expect(r.text).toMatch(/thời gian/);
  });

  it('Q-2 "tạo kèo thứ 7": time is asked and the card has no start', async () => {
    const r = await turn('tạo kèo cà phê thứ 7 ở Hà Nội');
    expect(fields(r)).toContain('time');
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('startAt')).toBeUndefined();
  });

  it('Q-2 the chip "Thứ 7 tối" reads back to the coming Saturday 19:00 +07, explicit', async () => {
    const r = await turn('Thứ 7 tối', {
      history: [said('tạo kèo cà phê ở Hà Nội với 4 người'), asked('time')],
    });
    expect(r.value('startAt')).toEqual({
      field: 'startAt',
      value: SATURDAY_EVENING,
      origin: 'explicit',
      editable: true,
    });
    expect(r.value('endAt')).toMatchObject({ origin: 'assumed' });
    expect(r.value('participantCount')).toMatchObject({ value: 4, origin: 'explicit' });
    expect(fields(r)).not.toContain('time');
  });

  it('U-10 an area answer merges with the request it answers', async () => {
    const r = await turn('Ở Hà Nội', {
      history: [said('tạo kèo ăn tối thứ 7 với 4 người'), asked('area')],
    });
    expect(r.jevRequests[0]).toContain('tạo kèo ăn tối thứ 7 với 4 người');
    expect(r.jevRequests[0]).toContain('Ở Hà Nội');
    expect(r.value('participantCount')).toMatchObject({ value: 4, origin: 'explicit' });
    expect(r.value('administrativeArea')).toMatchObject({ value: { provinceCode: '01' } });
    expect(cards(r)).toBeGreaterThanOrEqual(1);
    expect(fields(r)).toEqual(['time', 'budget']);
  });

  it('U-11 a question typed under the chips starts a fresh request', async () => {
    const r = await turn('Làm sao để mời bạn?', {
      answers: {
        ...base,
        assistant_intent: { type: 'choice', choice: 'gogo_guide' },
        action: { type: 'choice', choice: 'none' },
      },
      history: [said('tạo kèo ăn tối thứ 7 với 4 người'), asked('area')],
    });
    expect(r.jevRequests[0]).toBe('Làm sao để mời bạn?');
    expect(r.proposal).toBeNull();
  });

  it('I-7 an answer to a turn that asked nothing does not merge', async () => {
    const r = await turn('Ở Hà Nội', {
      history: [said('tạo kèo ăn tối thứ 7 với 4 người'), { ...asked('area'), follow_ups: [] }],
    });
    expect(r.jevRequests[0]).toBe('Ở Hà Nội');
    expect(r.value('participantCount')).not.toMatchObject({ origin: 'explicit' });
  });

  it('U-12 "Sài Gòn": two dataset choices, deterministic text, no search', async () => {
    const r = await turn('tạo kèo ăn tối ở Sài Gòn');
    expect(fields(r)).toEqual(['area_scope', 'time']);
    const scope = r.followUps[0]!;
    expect(scope.options).toEqual([
      { label: 'Cả Thành phố Hồ Chí Minh', text: 'Cả Thành phố Hồ Chí Minh' },
      { label: 'Phường Sài Gòn', text: 'Phường Sài Gòn, Thành phố Hồ Chí Minh' },
    ]);
    expect(r.text).toMatch(/Thành phố Hồ Chí Minh/);
    expect(r.text).toMatch(/Phường Sài Gòn/);
    expect(r.searches).toHaveLength(0);
    expect(cards(r)).toBe(0);
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('administrativeArea')).toBeUndefined();
  });

  it('U-12 the ward chip searches the ward; the city chip the whole city', async () => {
    const history = [said('tạo kèo ăn tối ở Sài Gòn'), asked('area_scope')];
    const ward = await turn('Phường Sài Gòn, Thành phố Hồ Chí Minh', { history });
    expect(ward.searches[0]).toMatchObject({
      administrativeArea: { provinceCode: '79', communeCode: '26740' },
    });
    const city = await turn('Cả Thành phố Hồ Chí Minh', { history });
    expect(city.searches[0]).toMatchObject({
      administrativeArea: { provinceCode: '79', communeCode: null },
    });
  });

  it('U-13 a new room card supersedes the pending ones of the conversation', async () => {
    const r = await turn('tạo kèo cà phê ở Hà Nội');
    expect(r.superseded).toEqual([['c', 'create_room']]);
  });

  it('U-2 a how-to question is never a card, whatever Jev said', async () => {
    const r = await turn('Cách tạo phòng trên GoGo?', {
      answers: { ...base, assistant_intent: { type: 'choice', choice: 'gogo_guide' } },
    });
    expect(r.proposal).toBeNull();
    expect(r.searches).toHaveLength(0);
  });

  it('U-14 Jev unavailable: the deterministic path gives the same frames', async () => {
    const a = await turn('tạo kèo cà phê ở Hà Nội', { answers: null });
    expect(a.proposal?.kind).toBe('create_room');
    expect(cards(a)).toBeGreaterThanOrEqual(1);
    expect(fields(a)).toEqual(['time', 'party_size']);
    const b = await turn('tạo kèo ăn tối thứ 7 với 4 người, 300k/người', { answers: null });
    expect(fields(b)).toEqual(['area', 'time']);
    expect(b.value('participantCount')).toMatchObject({ value: 4, origin: 'explicit' });
    const c = await turn('tạo kèo ăn tối ở Sài Gòn', { answers: null });
    expect(fields(c)).toEqual(['area_scope', 'time']);
    expect(c.proposal?.kind).toBe('create_room');
  });

  it('Sol F-02 Jev down and no kind of place: the activity is asked, nothing searched', async () => {
    const r = await turn('tạo kèo ở Hà Nội với 4 người', { answers: null });
    expect(fields(r)[0]).toBe('activity');
    expect(r.searches).toHaveLength(0);
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('administrativeArea')).toMatchObject({ value: { provinceCode: '01' } });
  });

  it('Sol F-06 an occasion the model inferred does not make the room type explicit', async () => {
    const r = await turn('tạo kèo cà phê ở Hà Nội', {
      answers: { ...base, occasion: { type: 'choice', choice: 'couple' } },
    });
    expect(r.value('type')).toMatchObject({ origin: 'assumed' });
  });

  it('Sol F-07 from an opened plan, "tạo kèo" still takes the room flow', async () => {
    const r = await turn('tạo kèo cà phê ở Hà Nội', {
      answers: { ...base, assistant_intent: { type: 'choice', choice: 'plan_help' } },
      context: { kind: 'plan', id: '0b6f3c1e-7d2a-4c11-9a3e-5f1d2c3b4aff' },
    });
    expect(r.searches).toHaveLength(1);
    expect(r.value('administrativeArea')).toMatchObject({ value: { provinceCode: '01' } });
  });

  it('Sol F-08 a "what to do" turn in Sài Gòn still names both scopes', async () => {
    const r = await turn('tạo kèo thứ 7 ở Sài Gòn', {
      answers: {
        ...base,
        category: { type: 'choice', choice: 'none' },
        needs_clarification: { type: 'noul', noul: 0.99 },
      },
    });
    expect(fields(r)).toContain('area_scope');
    expect(r.text).toMatch(/Phường Sài Gòn/);
  });
});
