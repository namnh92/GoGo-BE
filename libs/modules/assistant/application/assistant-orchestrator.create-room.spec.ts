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

type HistoryRow = {
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  follow_ups: { field: string; options?: { text: string }[] }[];
  trace?: Record<string, unknown>;
};
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
  /** Every Jev request's state and question keys, in call order (#738). */
  jevCalls: { state: Record<string, unknown>; questions: string[] }[];
  superseded: unknown[][];
  trace: Record<string, unknown>;
  costs: { jevCalls: number; jevCostUsd: number | null; jevInputTokens: number | null };
  proposal: { kind: string; values: { field: string; value: unknown; origin: string }[] } | null;
  followUps: { field: string; options: { label: string; text: string }[] }[];
  value: (field: string) => { value: unknown; origin: string } | undefined;
};

async function turn(
  text: string,
  opts: {
    /** One answer set for every call, or one per Jev call in order (#738). */
    answers?: Record<string, unknown> | (Record<string, unknown> | 'throw')[] | null;
    /** Search candidates; more than three makes the relevance call run. */
    places?: number;
    /** What each Jev call reports. */
    usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
    history?: HistoryRow[];
    archive?: HistoryRow[];
    context?: { kind: 'place' | 'plan'; id: string };
    ceiling?: number;
    composer?: { calls: number };
    metrics?: string[];
  } = {},
): Promise<Run> {
  const frames: AssistantFrame[] = [];
  const searches: Record<string, unknown>[] = [];
  const jevRequests: string[] = [];
  const jevCalls: Run['jevCalls'] = [];
  const superseded: unknown[][] = [];
  const answers = opts.answers === undefined ? base : opts.answers;
  const orchestrator = new AssistantOrchestrator(
    {
      ASSISTANT_FIRST_TEXT_TIMEOUT_MS: opts.places ? 15_000 : 5_000,
      ASSISTANT_JEV_TIMEOUT_MS: 4_000,
      ASSISTANT_MAX_OUTPUT_TOKENS: 100,
      ASSISTANT_TURN_COST_CEILING_USD: opts.ceiling ?? 0.005,
    } as never,
    {
      history: async (_conversationId: string, _messageId: string, limit: number) =>
        [...(opts.history ?? []), { ...said(text), id: `user-${opts.archive?.length ?? 0}` }].slice(
          -limit,
        ),
      episodeMessages: async (_conversationId: string, ids: string[]) =>
        (opts.archive ?? []).filter((row) => ids.includes(row.id!)),
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
        mood: [{ key: 'romantic', label: 'lãng mạn' }],
        setting: [{ key: 'outdoor', label: 'ngoài trời' }],
        suitability: [
          { key: 'couple', label: 'Cặp đôi' },
          { key: 'group', label: 'Nhóm bạn' },
          { key: 'date', label: 'hẹn hò' },
          { key: 'birthday', label: 'sinh nhật' },
        ],
        categorySynonyms: { 'category:cafe': ['cà phê'], 'category:restaurant': ['ăn tối'] },
        synonyms: { romantic: ['lang man'] },
      }),
      labels: () =>
        new Map<string, string>([
          ['romantic', 'lãng mạn'],
          ['outdoor', 'ngoài trời'],
          ['category:cafe', 'cà phê'],
          ['category:restaurant', 'nhà hàng'],
          ['couple', 'Cặp đôi'],
          ['group', 'Nhóm bạn'],
          ['date', 'hẹn hò'],
          ['birthday', 'sinh nhật'],
        ]),
    } as never,
    {
      search: async (q: Record<string, unknown>) => {
        searches.push(q);
        return {
          results: opts.places
            ? Array.from({ length: opts.places }, (_, i) => ({ id: `place-${i}` }))
            : [{ id: PLACE_1 }, { id: PLACE_2 }],
        };
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
    { retrieve: async () => ({ outcome: 'no_published', terms: [], sections: [] }) } as never,
    {} as never,
    answers === null
      ? null
      : ({
          decide: async (req: {
            state: { request: string } & Record<string, unknown>;
            questions: Record<string, unknown>;
          }) => {
            jevRequests.push(req.state.request);
            jevCalls.push({ state: req.state, questions: Object.keys(req.questions) });
            const answer = Array.isArray(answers) ? answers[jevCalls.length - 1] : answers;
            if (answer === 'throw') throw new Error('jev failed');
            return {
              model: 'typesafe/jev-1.14',
              answers: answer ?? {},
              usage: opts.usage ?? { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 },
            };
          },
        } as never),
    opts.composer
      ? ({
          model: 'anthropic/claude-haiku-5.5',
          stream: async function* () {
            opts.composer!.calls += 1;
            yield { type: 'delta', text: 'Câu trả lời.' };
            yield { type: 'done', finishReason: 'stop' };
          },
        } as never)
      : null,
    opts.metrics
      ? ({
          increment: (name: string, labels: Record<string, string>) =>
            opts.metrics!.push(`${name}:${labels.reason ?? ''}`),
          observe: () => undefined,
        } as never)
      : undefined,
  );
  const state = newTurnState();
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
    state,
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
    jevCalls,
    superseded,
    trace: state.trace,
    costs: state.costs as Run['costs'],
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
        turn_relation: { type: 'choice', choice: 'new_request' },
      },
      history: [said('tạo kèo ăn tối thứ 7 với 4 người'), asked('area')],
    });
    // #738: Jev reads the reply apart from the request it would continue.
    expect(r.jevCalls[0]!.state.latest_message).toBe('Làm sao để mời bạn?');
    expect(r.trace.turnRelation).toEqual({ source: 'jev', relation: 'new_request' });
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

  it('Astra A-F-01 a long clarification chain keeps the request that opened it', async () => {
    const r = await turn('6 người', {
      answers: null,
      history: [
        said('tạo kèo cà phê'),
        asked('area'),
        said('Ở Hà Nội'),
        asked('time'),
        said('Thứ 7'),
        asked('time'),
        said('Thứ 7 tối'),
        asked('party_size'),
      ],
    });
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('participantCount')).toMatchObject({ value: 6, origin: 'explicit' });
    expect(r.value('administrativeArea')).toMatchObject({ value: { provinceCode: '01' } });
    expect(r.value('startAt')).toMatchObject({ value: SATURDAY_EVENING });
  });

  it('Astra A-F-03 an area correction outlives the turns after it', async () => {
    const r = await turn('4 người', {
      history: [
        said('tạo kèo cà phê ở Phường Bến Thành, Thành phố Hồ Chí Minh'),
        asked('time'),
        said('Ở Hà Nội'),
        asked('party_size'),
      ],
    });
    expect(r.value('administrativeArea')).toMatchObject({
      value: { provinceCode: '01', communeCode: null },
    });
  });

  it('Astra A-F-04 a fresh request under the chips is a boundary the walk keeps', async () => {
    const r = await turn('Ở Hà Nội', {
      history: [
        said('tạo kèo ăn tối 4 người'),
        asked('area'),
        said('tìm quán cà phê'),
        asked('area'),
      ],
    });
    expect(r.jevRequests[0]).not.toContain('tạo kèo ăn tối');
    expect(r.jevRequests[0]).toContain('tìm quán cà phê');
    expect(r.value('participantCount')).not.toMatchObject({ value: 4, origin: 'explicit' });
  });

  it('Astra A-F-05 a bare typed area answers the area question', async () => {
    const r = await turn('Hà Nội', {
      answers: null,
      history: [said('tạo kèo cà phê'), asked('area')],
    });
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('administrativeArea')).toMatchObject({ value: { provinceCode: '01' } });
  });

  it('A-F-01 retains the opening request and facts after raw-history eviction', async () => {
    const archive: HistoryRow[] = [];
    let result: Run | undefined;
    for (const text of [
      'tạo kèo cà phê',
      'Sài Gòn',
      'Cả Thành phố Hồ Chí Minh',
      'Thứ 7',
      'Thứ 7 tối',
      '6 người',
      '8 người',
      '6 người',
      '300k/người',
    ]) {
      const id = `user-${archive.length}`;
      result = await turn(text, { answers: null, history: archive, archive });
      archive.push(
        { ...said(text), id },
        { role: 'assistant', text: result.text, follow_ups: result.followUps, trace: result.trace },
      );
      expect((result.trace.episodeRefs as unknown[]).length).toBeLessThanOrEqual(8);
    }
    expect(result!.proposal?.kind).toBe('create_room');
    expect(cards(result!)).toBeGreaterThan(0);
    expect(result!.value('participantCount')).toMatchObject({ value: 6, origin: 'explicit' });
    expect(result!.value('budgetAmount')).toMatchObject({ value: 300_000, origin: 'explicit' });
    expect(result!.value('administrativeArea')).toMatchObject({
      value: { provinceCode: '79', communeCode: null },
      origin: 'explicit',
    });
    expect(result!.value('startAt')).toMatchObject({ value: SATURDAY_EVENING, origin: 'explicit' });
    for (const field of ['activity', 'area', 'time', 'party_size', 'budget']) {
      expect(fields(result!)).not.toContain(field);
    }
  });

  it.each([null, { ...base, turn_relation: { type: 'choice', choice: 'new_request' } }])(
    'F-12 a second explicit create request starts fresh (%s)',
    async (answers) => {
      const text = 'tạo kèo cà phê với 4 người ở Phường Ba Đình, Thành phố Hà Nội';
      const r = await turn(text, {
        answers,
        history: [said('tạo kèo ăn tối thứ 7 với 6 người, 300k/người'), asked('area')],
      });
      if (answers) expect(r.jevCalls[0]!.state.latest_message).toBe(text);
      expect(cards(r)).toBeGreaterThan(0);
      expect(fields(r)).not.toContain('activity');
      expect(r.value('seedPlaceIds')).toBeDefined();
      expect(r.value('participantCount')).toMatchObject({ value: 4, origin: 'explicit' });
      expect(r.value('budgetAmount')).toMatchObject({ origin: 'assumed' });
      expect(r.value('startAt')).toBeUndefined();
      expect(r.followUps.find((group) => group.field === 'time')!.options[0]!.text).toBe('Tối nay');
    },
  );

  it('F-12 a fact-bearing search request does not inherit the old action or facts', async () => {
    const r = await turn('thôi, tìm cà phê ở Hà Nội', {
      answers: null,
      history: [said('tạo kèo ăn tối thứ 7 với 6 người, 300k/người'), asked('area')],
    });
    expect(r.proposal).toBeNull();
    expect(cards(r)).toBeGreaterThan(0);
  });

  it('F-12 later answers cannot cross a fact-bearing fresh request boundary', async () => {
    const r = await turn('6 người', {
      answers: null,
      history: [
        said('tạo kèo ăn tối thứ 7 với 4 người, 300k/người'),
        asked('area'),
        said('tạo kèo cà phê ở Hà Nội'),
        asked('party_size'),
      ],
    });
    expect(cards(r)).toBeGreaterThan(0);
    expect(r.value('participantCount')).toMatchObject({ value: 6, origin: 'explicit' });
    expect(r.value('budgetAmount')).toMatchObject({ origin: 'assumed' });
    expect(r.value('startAt')).toBeUndefined();
  });

  it.each(['cho mình 4 người', 'cho tôi 4 người'])(
    'F-13 a polite party-size answer keeps the room episode: %s',
    async (text) => {
      const r = await turn(text, {
        answers: null,
        history: [said('tạo kèo cà phê ở Hà Nội'), asked('party_size')],
      });
      expect(r.proposal?.kind).toBe('create_room');
      expect(r.value('participantCount')).toMatchObject({ value: 4, origin: 'explicit' });
      expect(r.value('administrativeArea')).toMatchObject({ value: { provinceCode: '01' } });
      expect(fields(r)).not.toContain('activity');
      expect(cards(r)).toBeGreaterThan(0);
    },
  );

  it('F-14 retains a mixed activity answer across corrections and stored refs', async () => {
    const archive: HistoryRow[] = [];
    let result: Run | undefined;
    for (const text of ['tạo kèo', 'cà phê với 4 người', 'Ở Hà Nội', '6 người']) {
      const id = `user-${archive.length}`;
      result = await turn(text, { answers: null, history: archive.slice(-2), archive });
      archive.push(
        { ...said(text), id },
        { role: 'assistant', text: result.text, follow_ups: result.followUps, trace: result.trace },
      );
    }
    expect(result!.proposal?.kind).toBe('create_room');
    expect(result!.value('participantCount')).toMatchObject({ value: 6, origin: 'explicit' });
    expect(result!.value('administrativeArea')).toMatchObject({ value: { provinceCode: '01' } });
    expect(fields(result!)).not.toContain('activity');
    expect(cards(result!)).toBeGreaterThan(0);
    expect(result!.trace.episodeRefs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'user-2', answerField: 'activity' })]),
    );
  });

  it('F-14 a mixed preference answer survives a later party-size correction', async () => {
    const r = await turn('6 người', {
      history: [
        said('tạo kèo cà phê ở Hà Nội'),
        asked('preference'),
        said('yên tĩnh với 4 người'),
        asked('time'),
      ],
    });
    expect(r.jevRequests[0]).toContain('yên tĩnh với 4 người');
    expect(r.value('participantCount')).toMatchObject({ value: 6, origin: 'explicit' });
  });

  it('F-12 an offered activity reply still continues the room request', async () => {
    const r = await turn('Tìm quán cà phê', {
      answers: null,
      history: [
        said('tạo kèo ở Hà Nội với 4 người'),
        {
          ...asked('activity'),
          follow_ups: [{ field: 'activity', options: [{ text: 'Tìm quán cà phê' }] }],
        },
      ],
    });
    expect(r.proposal?.kind).toBe('create_room');
    expect(cards(r)).toBeGreaterThan(0);
    expect(r.value('participantCount')).toMatchObject({ value: 4, origin: 'explicit' });
  });

  it('A-F-07 a typed preference keeps the selected province', async () => {
    const r = await turn('bình yên', {
      answers: null,
      history: [said('tạo kèo cà phê ở Tỉnh Thái Nguyên'), asked('preference')],
    });
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('administrativeArea')).toMatchObject({
      value: { provinceCode: '19', communeCode: null },
    });
  });

  it.each([
    ["B'Lao", '99991'],
    ["D'Ran", '99992'],
    ['bình yên', '05587'],
  ])('A-F-07/F-11 a prompted bare area answers the episode: %s', async (text, communeCode) => {
    const r = await turn(text, {
      answers: null,
      history: [said('tạo kèo cà phê'), asked('area')],
    });
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('administrativeArea')).toMatchObject({ value: { communeCode } });
  });

  it('A-F-02/F-10 a legacy city correction asks for a current area', async () => {
    const r = await turn('Thành phố Thủ Đức, Thành phố Hồ Chí Minh', {
      answers: null,
      history: [said('tạo kèo cà phê ở Hà Nội'), asked('time')],
    });
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('administrativeArea')).toBeUndefined();
    expect(fields(r)).toContain('area');
    expect(cards(r)).toBe(0);
  });
});

/**
 * GoGo-BE#738 — under a pending clarification, Jev says in the same call
 * whether the newest message answers it (`turn_relation`); the word heuristic
 * only decides when Jev is down. Owner F-16: "cho mình quán cà phê" under the
 * activity question continues the room request.
 */
describe('#738 turn_relation decides the episode boundary', () => {
  const relation = (choice: string) => ({
    ...base,
    turn_relation: { type: 'choice', choice },
  });
  const ROOM = 'tạo kèo đi chơi ở Hà Nội tối nay với 4 người';

  it('AC-1 "cho mình quán cà phê" under the activity question continues the room request', async () => {
    const r = await turn('cho mình quán cà phê', {
      answers: relation('answer_pending'),
      history: [said(ROOM), asked('activity')],
    });
    // One call, asked about the merged request, with the reply apart.
    expect(r.jevCalls).toHaveLength(1);
    expect(r.jevCalls[0]!.questions).toContain('turn_relation');
    expect(r.jevCalls[0]!.state.request).toContain(ROOM);
    expect(r.jevCalls[0]!.state.request).toContain('cho mình quán cà phê');
    expect(r.jevCalls[0]!.state.latest_message).toBe('cho mình quán cà phê');
    expect(r.jevCalls[0]!.state.pending_question).toBe('Bạn chọn giúp mình nhé.');
    expect(r.trace.turnRelation).toEqual({ source: 'jev', relation: 'answer_pending' });
    expect(r.proposal?.kind).toBe('create_room');
    expect(r.value('participantCount')).toMatchObject({ value: 4, origin: 'explicit' });
  });

  it('AC-1 "thôi, tìm cà phê ở Hà Nội" is a new request: classified again alone, no room card', async () => {
    const r = await turn('thôi, tìm cà phê ở Hà Nội', {
      answers: [
        // About the merged text: it still reads as the room request.
        relation('new_request'),
        // The second call, about the new request alone.
        { ...base, action: { type: 'choice', choice: 'none' } },
      ],
      history: [said('tạo kèo ăn tối thứ 7 với 6 người, 300k/người'), asked('activity')],
    });
    expect(r.trace.turnRelation).toEqual({ source: 'jev', relation: 'new_request' });
    // Owner 2026-11-01: one Jev call per text classified.
    expect(r.jevCalls).toHaveLength(2);
    expect(r.jevCalls[1]!.state.request).toBe('thôi, tìm cà phê ở Hà Nội');
    expect(r.jevCalls[1]!.questions).not.toContain('turn_relation');
    expect(r.trace.jevDecisionCalls).toBe(2);
    expect((r.trace.intent as { source: string }).source).toBe('decision_model');
    expect(r.proposal).toBeNull();
    expect(cards(r)).toBeGreaterThan(0);
    expect(r.trace.episode).toBeUndefined();
  });

  it('each Jev call is counted and costed in the turn', async () => {
    const r = await turn('thôi, tìm cà phê ở Hà Nội', {
      answers: [relation('new_request'), { ...base, action: { type: 'choice', choice: 'none' } }],
      history: [said('tạo kèo ăn tối thứ 7 với 6 người, 300k/người'), asked('activity')],
    });
    // The stub reports 1 input token and $0.0001 per call; the relevance call
    // (recommend_places) is a Jev call of its own and counts the same way.
    const decisionCalls = 2;
    expect(r.costs.jevCalls).toBeGreaterThanOrEqual(decisionCalls);
    expect(r.costs.jevInputTokens).toBe(r.costs.jevCalls);
    expect(r.costs.jevCostUsd).toBeCloseTo(0.0001 * r.costs.jevCalls, 10);
  });

  it('the second call failing classifies the new request deterministically', async () => {
    const r = await turn('thôi, tìm cà phê ở Hà Nội', {
      answers: [relation('new_request'), {}],
      history: [said('tạo kèo ăn tối thứ 7 với 6 người, 300k/người'), asked('activity')],
    });
    expect(r.jevCalls).toHaveLength(2);
    expect((r.trace.intent as { source: string }).source).toBe('fallback');
    expect(r.proposal).toBeNull();
  });

  it('AC-2 unclear: asked whether to continue — not merged, not dropped, nothing prepared', async () => {
    const r = await turn('cà phê đi', {
      answers: relation('unclear'),
      history: [{ ...said(ROOM), id: 'u1' }, asked('activity')],
    });
    expect(r.trace.turnRelation).toEqual({ source: 'jev', relation: 'unclear' });
    expect(r.proposal).toBeNull();
    expect(cards(r)).toBe(0);
    expect(r.searches).toHaveLength(0);
    expect(fields(r)).toEqual(['turn_relation']);
    expect(r.followUps[0]!.options.map((o) => o.text)).toEqual([
      'Tiếp tục yêu cầu trước',
      'Đây là yêu cầu mới',
    ]);
    expect(r.text).toMatch(/tiếp tục yêu cầu trước/);
    // The merged episode is kept by reference, so the chip can continue it.
    expect(r.trace.episodeRefs).toHaveLength(2);
  });

  it('AC-2 the "continue" chip resumes the earlier request with the unclear message', async () => {
    const archive: HistoryRow[] = [
      { ...said(ROOM), id: 'u1' },
      { ...said('cà phê đi'), id: 'u2' },
    ];
    const r = await turn('Tiếp tục yêu cầu trước', {
      history: [
        said(ROOM),
        asked('activity'),
        said('cà phê đi'),
        {
          role: 'assistant',
          text: 'Bạn muốn tiếp tục yêu cầu trước?',
          follow_ups: [
            {
              field: 'turn_relation',
              options: [{ text: 'Tiếp tục yêu cầu trước' }, { text: 'Đây là yêu cầu mới' }],
            },
          ],
          trace: {
            episodeRefs: [
              { id: 'u1', allowBareArea: false },
              { id: 'u2', allowBareArea: false, answerField: 'activity' },
            ],
          },
        },
      ],
      archive,
    });
    expect(r.trace.turnRelation).toEqual({ source: 'person', relation: 'answer_pending' });
    expect(r.jevCalls).toHaveLength(1);
    expect(r.jevCalls[0]!.questions).not.toContain('turn_relation');
    expect(r.jevRequests[0]).toContain(ROOM);
    expect(r.jevRequests[0]).toContain('cà phê đi');
    expect(r.jevRequests[0]).not.toContain('Tiếp tục');
    expect(r.proposal?.kind).toBe('create_room');
  });

  it('AC-2 the "new request" chip starts from the unclear message alone', async () => {
    const archive: HistoryRow[] = [
      { ...said(ROOM), id: 'u1' },
      { ...said('cà phê đi'), id: 'u2' },
    ];
    const r = await turn('Đây là yêu cầu mới', {
      answers: { ...base, action: { type: 'choice', choice: 'none' } },
      history: [
        said(ROOM),
        asked('activity'),
        said('cà phê đi'),
        {
          role: 'assistant',
          text: 'Bạn muốn tiếp tục yêu cầu trước?',
          follow_ups: [
            {
              field: 'turn_relation',
              options: [{ text: 'Tiếp tục yêu cầu trước' }, { text: 'Đây là yêu cầu mới' }],
            },
          ],
          trace: {
            episodeRefs: [
              { id: 'u1', allowBareArea: false },
              { id: 'u2', allowBareArea: false },
            ],
          },
        },
      ],
      archive,
    });
    expect(r.trace.turnRelation).toEqual({ source: 'person', relation: 'new_request' });
    expect(r.jevRequests).toEqual(['cà phê đi']);
    expect(r.proposal).toBeNull();
  });

  it('AC-3 a quick reply is an answer by itself: no turn_relation question', async () => {
    const r = await turn('Thứ 7 tối', {
      history: [
        said('tạo kèo cà phê ở Hà Nội với 4 người'),
        {
          role: 'assistant',
          text: 'Mấy giờ?',
          follow_ups: [
            {
              field: 'time',
              options: [{ text: 'Thứ 7 trưa' }, { text: 'Thứ 7 chiều' }, { text: 'Thứ 7 tối' }],
            },
          ],
        },
      ],
    });
    expect(r.jevCalls).toHaveLength(1);
    expect(r.jevCalls[0]!.questions).not.toContain('turn_relation');
    expect(r.trace.turnRelation).toBeUndefined();
  });

  it('one decision call when the message continues or is unclear, two for a new request', async () => {
    for (const [choice, calls] of [
      ['answer_pending', 1],
      ['unclear', 1],
      ['new_request', 2],
    ] as const) {
      const r = await turn('cho mình quán cà phê', {
        answers: relation(choice),
        history: [said(ROOM), asked('activity')],
      });
      expect(r.jevCalls, choice).toHaveLength(calls);
    }
  });

  it('Jev down: the #733 heuristic decides, as before (F-16 stays the known limit there)', async () => {
    const r = await turn('cho mình quán cà phê', {
      answers: null,
      history: [said(ROOM), asked('activity')],
    });
    expect(r.trace.turnRelation).toEqual({ source: 'heuristic', relation: 'new_request' });
    expect(r.proposal).toBeNull();
  });

  it('a Jev answer without turn_relation is invalid: the heuristic decides', async () => {
    const r = await turn('Ở Phường Ba Đình, Thành phố Hà Nội', {
      answers: base,
      history: [said(ROOM), asked('activity')],
    });
    expect(r.trace.turnRelation).toEqual({ source: 'heuristic', relation: 'answer_pending' });
    expect((r.trace.intent as { source: string }).source).toBe('fallback');
  });
});

/**
 * GoGo-BE#738 follow-up (owner 2026-11-01): a new request after a place
 * request that said things asks "new or update?" first; keeping walks one
 * question per differing item, then joins the two. The owner's example.
 */
describe('#738 a new request asks "new or update?", then one item at a time', () => {
  const OLD_TEXT = 'Cho tôi quán cà phê lãng mạn cho 2 người ở Hà Nội';
  const NEW_TEXT = 'Cho tôi quán cà phê ngoài trời cho 3 người';
  const oldUser: HistoryRow = { ...said(OLD_TEXT), id: 'u1' };
  const resultsTurn: HistoryRow = {
    role: 'assistant',
    text: 'Mình tìm thấy 2 địa điểm.',
    follow_ups: [],
    trace: {
      intent: {
        intent: 'recommend_places',
        action: 'none',
        category: 'category:cafe',
        occasion: null,
        moods: ['romantic'],
        settings: [],
        model: 'typesafe/jev-1.14',
      },
      episodeRefs: [{ id: 'u1', allowBareArea: false }],
    },
  };
  const freshAnswers = {
    ...base,
    action: { type: 'choice', choice: 'none' },
    'setting:outdoor': { type: 'noul', noul: 0.9 },
  };
  /** The assistant row a turn leaves for the next one to read. */
  const replyOf = (r: Run): HistoryRow => ({
    role: 'assistant',
    text: r.text,
    follow_ups: r.followUps,
    trace: r.trace,
  });

  async function firstTurn() {
    return turn(NEW_TEXT, {
      answers: [
        { ...base, turn_relation: { type: 'choice', choice: 'new_request' } },
        freshAnswers,
      ],
      history: [oldUser, resultsTurn],
      archive: [oldUser],
    });
  }

  it('asks "new or update?" first: nothing searched or prepared', async () => {
    const r = await firstTurn();
    // The relation, then the new request alone: two classifications.
    expect(r.jevCalls).toHaveLength(2);
    expect(r.jevCalls[0]!.questions).toContain('turn_relation');
    expect(r.jevCalls[1]!.state.request).toBe(NEW_TEXT);
    expect(fields(r)).toEqual(['reconcile_mode']);
    expect(r.followUps[0]!.options.map((o) => o.text)).toEqual([
      'Tạo yêu cầu mới',
      'Giữ thông tin cũ và cập nhật',
    ]);
    expect(r.text).toMatch(/tạo yêu cầu mới, hay giữ thông tin đã có/);
    expect(r.searches).toHaveLength(0);
    expect(r.proposal).toBeNull();
    const state = r.trace.reconcile as {
      items: { field: string }[];
      refs: { new: { id: string } };
    };
    expect(state.items.map((i) => i.field)).toEqual(['preferences', 'partySize', 'area']);
    expect(state.refs.new.id).toBe('user-1');
    // Keys, ids and dataset labels only: no message text is stored with the walk.
    expect(JSON.stringify(state)).not.toContain('Cho tôi');
  });

  it('keep and update: one question per turn, no Jev decision, then the joined search', async () => {
    const first = await firstTurn();
    const newUser: HistoryRow = { ...said(NEW_TEXT), id: 'user-1' };
    const history: HistoryRow[] = [oldUser, resultsTurn, newUser, replyOf(first)];
    const archive: HistoryRow[] = [oldUser, newUser];
    const step = async (chip: string) => {
      const r = await turn(chip, { answers: freshAnswers, history: [...history], archive });
      history.push(said(chip), replyOf(r));
      return r;
    };

    const prefs = await step('Giữ thông tin cũ và cập nhật');
    expect(prefs.jevCalls).toHaveLength(0);
    expect(prefs.text).toBe('Bạn muốn ngoài trời hay lãng mạn?');
    expect(prefs.followUps[0]!.options.map((o) => o.label)).toEqual([
      'ngoài trời',
      'lãng mạn',
      'Cả hai',
    ]);
    expect(prefs.searches).toHaveLength(0);

    const party = await step(prefs.followUps[0]!.options[2]!.text);
    expect(party.jevCalls).toHaveLength(0);
    expect(party.text).toBe('Bạn muốn cho 3 người? (trước đó là 2 người)');

    const area = await step(party.followUps[0]!.options[0]!.text);
    // D-17: the area is worded from the dataset, never as typed.
    expect(area.text).toBe('Bạn vẫn muốn ở Hà Nội?');

    const done = await step(area.followUps[0]!.options[0]!.text);
    // No decision call on any reconciling turn (a relevance call may run).
    expect(done.jevCalls.every((c) => !c.questions.includes('assistant_intent'))).toBe(true);
    // D-15: the joined turn stores the request for the turns after it.
    expect((done.trace.reconcile as { status: string }).status).toBe('final');
    expect((done.trace.intent as { reconciled?: boolean }).reconciled).toBe(true);
    // D-10: the trace says who decided.
    expect((done.trace.intent as { source: string }).source).toBe('reconciled');
    expect(done.searches).toHaveLength(1);
    expect(cards(done)).toBeGreaterThan(0);
    expect(done.trace.episodeRefs).toEqual([
      { id: 'u1', allowBareArea: false },
      { id: 'user-1', allowBareArea: false },
    ]);
  });

  it('"Tạo yêu cầu mới" starts over from the new message alone', async () => {
    const first = await firstTurn();
    const newUser: HistoryRow = { ...said(NEW_TEXT), id: 'user-1' };
    const r = await turn('Tạo yêu cầu mới', {
      answers: freshAnswers,
      history: [oldUser, resultsTurn, newUser, replyOf(first)],
      archive: [oldUser, newUser],
    });
    expect(r.jevRequests).toEqual([NEW_TEXT]);
    expect(r.trace.reconcile).toBeUndefined();
    expect(fields(r)).not.toContain('reconcile_mode');
    // Hà Nội was the old request's: the new one has no area, so it is asked.
    expect(fields(r)).toContain('area');
  });

  it('a new request that only adds to the old one is not asked about', async () => {
    const r = await turn(`${OLD_TEXT} tối nay`, {
      answers: [
        { ...base, turn_relation: { type: 'choice', choice: 'new_request' } },
        {
          ...base,
          action: { type: 'choice', choice: 'none' },
          'mood:romantic': { type: 'noul', noul: 0.9 },
        },
      ],
      history: [oldUser, resultsTurn],
      archive: [oldUser],
    });
    expect(r.trace.reconcile).toBeUndefined();
    expect(r.searches).toHaveLength(1);
  });

  it('a short refinement after results continues the request (answer_pending)', async () => {
    const r = await turn('cho 4 người nhé', {
      answers: { ...base, turn_relation: { type: 'choice', choice: 'answer_pending' } },
      history: [oldUser, resultsTurn],
      archive: [oldUser],
    });
    expect(r.jevCalls).toHaveLength(1);
    expect(r.jevRequests[0]).toContain(OLD_TEXT);
    expect(r.trace.turnRelation).toEqual({ source: 'jev', relation: 'answer_pending' });
    expect(r.trace.reconcile).toBeUndefined();
  });

  it('a guide question after results is not reconciled', async () => {
    const r = await turn('Làm sao để mời bạn?', {
      answers: [
        { ...base, turn_relation: { type: 'choice', choice: 'new_request' } },
        {
          ...base,
          assistant_intent: { type: 'choice', choice: 'gogo_guide' },
          action: { type: 'choice', choice: 'none' },
          category: { type: 'choice', choice: 'none' },
        },
      ],
      history: [oldUser, resultsTurn],
      archive: [oldUser],
    });
    // A how-to question is answered as itself: nothing to keep or drop.
    expect(r.trace.reconcile).toBeUndefined();
    expect(fields(r)).not.toContain('reconcile_mode');
    expect(r.frames.some((f) => f.type === 'step' && f.step === 'reading_guide')).toBe(true);
  });

  it('Jev down (as in integration IT-1): a different room request asks first, then "new" makes the card', async () => {
    const first = await turn(
      'tạo kèo đi nhà hàng thứ 7 với 4 người ở Phường Ba Đình, Thành phố Hà Nội',
      {
        answers: null,
      },
    );
    expect(first.proposal?.kind).toBe('create_room');
    const u1: HistoryRow = {
      ...said('tạo kèo đi nhà hàng thứ 7 với 4 người ở Phường Ba Đình, Thành phố Hà Nội'),
      id: 'user-0',
    };
    const changed = await turn('tạo kèo cà phê với 4 người ở Phường Ba Đình, Thành phố Hà Nội', {
      answers: null,
      history: [u1, replyOf(first)],
      archive: [u1],
    });
    expect(changed.trace.turnRelation).toEqual({ source: 'heuristic', relation: 'new_request' });
    expect(fields(changed)).toEqual(['reconcile_mode']);
    expect(changed.proposal).toBeNull();
    const u2: HistoryRow = {
      ...said('tạo kèo cà phê với 4 người ở Phường Ba Đình, Thành phố Hà Nội'),
      id: 'user-1',
    };
    const fresh = await turn(changed.followUps[0]!.options[0]!.text, {
      answers: null,
      history: [u1, replyOf(first), u2, replyOf(changed)],
      archive: [u1, u2],
    });
    expect(fresh.proposal?.kind).toBe('create_room');
    expect(cards(fresh)).toBeGreaterThan(0);
  });
});

/**
 * GoGo-BE#738, shape rev 4 §5 — one persisted request state, what a typed
 * message does mid-walk, and what a turn may spend.
 */
describe('#738 shape §5', () => {
  const OLD_TEXT = 'Cho tôi quán cà phê lãng mạn cho 2 người ở Hà Nội';
  const NEW_TEXT = 'Cho tôi quán cà phê ngoài trời cho 3 người';
  const relation = (choice: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    action: { type: 'choice', choice: 'none' },
    turn_relation: { type: 'choice', choice },
    ...extra,
  });
  const ranked = { ...base, action: { type: 'choice', choice: 'none' } };
  const freshAnswers = { ...ranked, 'setting:outdoor': { type: 'noul', noul: 0.9 } };
  const replyOf = (r: Run): HistoryRow => ({
    role: 'assistant',
    text: r.text,
    follow_ups: r.followUps,
    trace: r.trace,
  });
  const intent = (over: Record<string, unknown> = {}) => ({
    intent: 'recommend_places',
    action: 'none',
    category: 'category:cafe',
    occasion: null,
    moods: ['romantic'],
    settings: [],
    model: 'typesafe/jev-1.14',
    ...over,
  });
  type Stored = {
    status: string;
    asked: number | null;
    items: { field: string; kind: string }[];
    values: Record<
      string,
      {
        value?: { value: unknown; provenance: string; keys?: Record<string, string> };
        pending?: { value: unknown; provenance: string }[];
      }
    >;
  };
  const stored = (r: Run) => r.trace.reconcile as Stored;

  /** A conversation with the owner's two requests on it, at "new or update?". */
  async function opened(
    oldText = OLD_TEXT,
    newText = NEW_TEXT,
    oldIntent = intent(),
    fresh: Record<string, unknown> = freshAnswers,
  ) {
    const oldUser: HistoryRow = { ...said(oldText), id: 'u1' };
    const results: HistoryRow = {
      role: 'assistant',
      text: 'Mình tìm thấy 2 địa điểm.',
      follow_ups: [],
      trace: { intent: oldIntent, episodeRefs: [{ id: 'u1', allowBareArea: false }] },
    };
    const first = await turn(newText, {
      answers: [relation('new_request'), fresh],
      history: [oldUser, results],
      archive: [oldUser],
    });
    const newUser: HistoryRow = { ...said(newText), id: 'user-1' };
    const history: HistoryRow[] = [oldUser, results, newUser, replyOf(first)];
    const archive: HistoryRow[] = [oldUser, newUser];
    return {
      first,
      history,
      archive,
      /** One more turn on the conversation, kept in its history with its id. */
      step: async (text: string, opts: Parameters<typeof turn>[1] = {}) => {
        const r = await turn(text, { answers: ranked, ...opts, history: [...history], archive });
        const row: HistoryRow = { ...said(text), id: `user-${archive.length}` };
        history.push(row, replyOf(r));
        archive.push(row);
        return r;
      },
    };
  }

  /** The owner's walk, keeping "ngoài trời" and "2 người", Hà Nội kept. */
  async function walked(opts: Parameters<typeof turn>[1] = {}) {
    const c = await opened();
    const prefs = await c.step('Giữ thông tin cũ và cập nhật');
    const party = await c.step(prefs.followUps[0]!.options[0]!.text);
    const area = await c.step(party.followUps[0]!.options[1]!.text);
    const done = await c.step(area.followUps[0]!.options[0]!.text, opts);
    return { ...c, done };
  }

  const resolvedOf = (call: { state: Record<string, unknown> }) =>
    call.state.resolved as {
      settled: Record<string, unknown>;
      assumed: Record<string, unknown>;
      open: string[];
      labels: Record<string, string>;
    };

  describe('D-15 a joined request never re-parses', () => {
    it('relevance reads the chosen values, not the rejected ones', async () => {
      const { done } = await walked({ places: 6 });
      const call = done.jevCalls[0]!;
      expect(call.questions).toContain('c1');
      const resolved = resolvedOf(call);
      expect(resolved.settled.partySize).toBe(2);
      expect(resolved.settled.settings).toEqual(['outdoor']);
      expect(resolved.settled.moods).toBeUndefined();
      expect(resolved.labels.romantic).toBeUndefined();
    });

    it('continuations keep the values, and only what the newest message asserts applies', async () => {
      const c = await walked();
      const cheaper = await c.step('rẻ hơn chút', { answers: relation('answer_pending') });
      expect(resolvedOf(cheaper.jevCalls[0]!).settled.partySize).toBe(2);
      expect(cheaper.jevCalls[0]!.questions).toContain('turn_relation');
      expect(stored(cheaper).values.partySize!.value!.value).toBe(2);
      expect(stored(cheaper).values.settings).toBeUndefined();
      expect(stored(cheaper).values.preferences!.value!.value).toEqual({
        moods: [],
        settings: ['outdoor'],
      });

      const three = await c.step('3 người nhé', { answers: relation('answer_pending') });
      expect(stored(three).values.partySize!.value).toMatchObject({ value: 3 });

      const denied = await c.step('không phải 3 người', { answers: relation('answer_pending') });
      // 3 is rejected: asked again, with what is left. Never silently kept.
      expect(fields(denied)).toEqual(['reconcile_partySize']);
      expect(stored(denied).values.partySize!.value).toBeUndefined();
      expect(stored(denied).values.partySize!.pending!.map((p) => p.value)).toEqual([2]);
    });

    it('two walks in a row never read a value from the source text', async () => {
      const c = await walked();
      // The stored messages now say something else: values must not move.
      c.archive[0]!.text = 'Cho tôi nhà hàng cho 9 người ở Đà Nẵng';
      const next = await c.step('Cho tôi quán cà phê ngoài trời cho 5 người ở Hà Nội', {
        answers: [relation('new_request'), freshAnswers],
      });
      expect(fields(next)).toEqual(['reconcile_mode']);
      expect(stored(next).items.map((i) => i.field)).toEqual(['partySize']);
      expect(stored(next).values.partySize!.pending!.map((p) => p.value)).toEqual([5, 2]);
      const party = await c.step('Giữ thông tin cũ và cập nhật');
      expect(party.jevCalls).toHaveLength(0);
      const done = await c.step(party.followUps[0]!.options[1]!.text);
      expect(done.trace.intent).toMatchObject({ source: 'reconciled' });
      expect(done.searches[0]!.administrativeArea).toMatchObject({ provinceCode: '01' });
      expect(stored(done).values.partySize!.value!.value).toBe(2);
    });
  });

  describe('D-16 a typed message mid-walk', () => {
    const OLD_B = `${OLD_TEXT}, 200k/người`;
    const NEW_B = `${NEW_TEXT}, 500k/người`;
    async function atParty() {
      const c = await opened(OLD_B, NEW_B);
      const prefs = await c.step('Giữ thông tin cũ và cập nhật');
      const party = await c.step(prefs.followUps[0]!.options[0]!.text);
      expect(fields(party)).toEqual(['reconcile_partySize']);
      return c;
    }

    for (const typed of ['4 người', 'cho 4 người nhé', '3 người thôi']) {
      it(`"${typed}" is the answer: no model call, the walk goes on`, async () => {
        const c = await atParty();
        const next = await c.step(typed);
        expect(next.jevCalls).toHaveLength(0);
        expect(fields(next)).toEqual(['reconcile_area']);
        expect(stored(next).values.partySize!.value).toMatchObject({
          value: Number(typed.match(/\d/)![0]),
          provenance: 'typed',
        });
      });
    }

    it('a sentence suspends: the relation is asked and settled choices hold', async () => {
      const c = await atParty();
      const interrupted = await c.step('thôi, tìm nhà hàng cho 4 người', {
        answers: relation('unclear'),
      });
      expect(interrupted.jevCalls[0]!.questions).toContain('turn_relation');
      expect(interrupted.jevCalls[0]!.state.resolved).toBeDefined();
      expect(fields(interrupted)).toEqual(['turn_relation']);
      const st = stored(interrupted);
      expect(st.status).toBe('suspended');
      expect(st.values.preferences!.value!.keys).toEqual({ outdoor: 'confirmed' });
      // Pending items keep both values; nothing defaulted.
      expect(st.values.partySize!.pending!.map((p) => p.value)).toEqual([3, 2]);
      expect(st.values.area!.pending).toHaveLength(1);
    });

    it('answer_pending applies what it asserts and resumes at the next item', async () => {
      const c = await atParty();
      const next = await c.step('mình muốn cho 4 người được chứ', {
        answers: relation('answer_pending'),
      });
      expect(fields(next)).toEqual(['reconcile_area']);
      expect(stored(next).status).toBe('asking');
      expect(stored(next).values.partySize!.value).toMatchObject({ value: 4, provenance: 'typed' });
    });

    it('a bare value for another pending field records it, the open item stays asked', async () => {
      const c = await atParty();
      const next = await c.step('300k/người');
      expect(next.jevCalls).toHaveLength(0);
      expect(fields(next)).toEqual(['reconcile_partySize']);
      expect(stored(next).values.budget!.value).toMatchObject({
        value: { amount: 300_000 },
        provenance: 'typed',
      });
      // Answer the party, then the area: budget is never asked again.
      const area = await c.step(next.followUps[0]!.options[0]!.text);
      expect(fields(area)).toEqual(['reconcile_area']);
      const done = await c.step(area.followUps[0]!.options[0]!.text);
      expect(done.followUps.map((g) => g.field)).not.toContain('reconcile_budget');
      expect(stored(done).status).toBe('final');
    });
  });

  describe('D-15/D-16 repeated interruption', () => {
    it('suspended → new_request → keep: the pair is asked again with the new value in front', async () => {
      const c = await opened();
      const prefs = await c.step('Giữ thông tin cũ và cập nhật');
      await c.step(prefs.followUps[0]!.options[0]!.text);
      const next = await c.step('thôi tìm quán cà phê cho 4 người', {
        answers: [relation('new_request'), ranked],
      });
      expect(fields(next)).toEqual(['reconcile_mode']);
      expect(stored(next).values.partySize!.pending!.map((p) => p.value)).toEqual([4, 3, 2]);
    });

    it('suspended → unclear → continue: same index, same queue, no model call', async () => {
      const c = await opened();
      const prefs = await c.step('Giữ thông tin cũ và cập nhật');
      const party = await c.step(prefs.followUps[0]!.options[0]!.text);
      const before = stored(party);
      const unclear = await c.step('hay là thôi nhỉ', { answers: relation('unclear') });
      const proceed = unclear.followUps[0]!.options[0]!.text;
      const back = await c.step(proceed);
      expect(back.jevCalls).toHaveLength(0);
      expect(back.text).toBe(party.text);
      expect(stored(back).status).toBe('asking');
      expect(stored(back).asked).toBe(before.asked);
      expect(stored(back).items).toEqual(before.items);
      expect(stored(back).values).toEqual(before.values);
    });

    it('suspended → unclear → "new request": the message alone, the walk ends', async () => {
      const c = await opened();
      const prefs = await c.step('Giữ thông tin cũ và cập nhật');
      await c.step(prefs.followUps[0]!.options[0]!.text);
      const unclear = await c.step('hay là tìm nhà hàng', { answers: relation('unclear') });
      const r = await c.step(unclear.followUps[0]!.options[1]!.text);
      expect(r.jevRequests).toEqual(['hay là tìm nhà hàng']);
      expect(r.trace.reconcile).toBeUndefined();
    });

    it('typing under "new or update?" asks that again, with what it said applied', async () => {
      const c = await opened();
      const r = await c.step('cho 4 người nhé', { answers: relation('answer_pending') });
      expect(fields(r)).toEqual(['reconcile_mode']);
      expect(stored(r).asked).toBeNull();
      expect(stored(r).values.partySize!.value).toMatchObject({ value: 4, provenance: 'typed' });
    });

    it('{2,3} → 4 → 5: every candidate reachable in stages, none dropped or defaulted', async () => {
      const c = await opened();
      const prefs = await c.step('Giữ thông tin cũ và cập nhật');
      await c.step(prefs.followUps[0]!.options[0]!.text);
      await c.step('thôi tìm quán cà phê cho 4 người', {
        answers: [relation('new_request'), ranked],
      });
      await c.step('Giữ thông tin cũ và cập nhật');
      const interrupted = await c.step('thôi tìm quán cà phê cho 5 người', {
        answers: [relation('new_request'), ranked],
      });
      expect(stored(interrupted).values.partySize!.pending!.map((p) => p.value)).toEqual([
        5, 4, 3, 2,
      ]);
      // The wishes come first; the stages begin at the party size.
      const prefs2 = await c.step('Giữ thông tin cũ và cập nhật');
      expect(fields(prefs2)).toEqual(['reconcile_preferences']);
      const stage1 = await c.step(prefs2.followUps[0]!.options[0]!.text);
      expect(stage1.followUps[0]!.options.map((o) => o.label)).toEqual([
        '5 người',
        '4 người',
        'Giá trị khác…',
      ]);
      const stage2 = await c.step('Giá trị khác…');
      expect(stage2.followUps[0]!.options.map((o) => o.label)).toEqual(['3 người', '2 người']);
      const typed = await c.step('6 người');
      expect(stored(typed).values.partySize!.value).toMatchObject({
        value: 6,
        provenance: 'typed',
      });
    });
  });

  describe('D-15 after the join', () => {
    it('an area asked after a dropped one is answered bare, and the area holds', async () => {
      const c = await opened();
      const prefs = await c.step('Giữ thông tin cũ và cập nhật');
      const party = await c.step(prefs.followUps[0]!.options[0]!.text);
      const area = await c.step(party.followUps[0]!.options[1]!.text);
      const dropped = await c.step(area.followUps[0]!.options[1]!.text);
      expect(fields(dropped)).toContain('area');
      const r = await c.step('Bến Thành', { answers: relation('answer_pending') });
      expect(r.searches[0]!.administrativeArea).toMatchObject({ communeCode: '26734' });
      expect(stored(r).values.partySize!.value!.value).toBe(2);
    });

    it('a long chain of continuations stays readable', async () => {
      const c = await walked();
      let last: Run | null = null;
      for (let i = 0; i < 8; i += 1) {
        last = await c.step(`${i < 4 ? 'rẻ' : 'gần'} hơn chút ${i}`, {
          answers: relation('answer_pending'),
        });
      }
      expect(stored(last!).status).toBe('final');
      expect(stored(last!).values.partySize!.value!.value).toBe(2);
      expect((last!.trace.episodeRefs as unknown[]).length).toBeLessThanOrEqual(8);
    });
  });

  describe('D-9 provenance', () => {
    it('stated old, inferred new: the old stays, nothing asked for it', async () => {
      // Jev answered a restaurant the new message never named.
      const c = await opened(OLD_TEXT, 'Cho tôi chỗ ngoài trời cho 2 người ở Hà Nội', intent(), {
        ...freshAnswers,
        category: { type: 'choice', choice: 'category:restaurant' },
        'mood:romantic': { type: 'noul', noul: 0.9 },
      });
      expect(stored(c.first).items.map((i) => i.field)).not.toContain('category');
      expect(stored(c.first).values.category!.value).toMatchObject({
        value: 'category:cafe',
        provenance: 'stated',
      });
    });

    it('both inferred: the newest stands as assumed; the owner example asks three items', async () => {
      const c = await opened(OLD_TEXT, NEW_TEXT, intent({ occasion: 'couple' }), {
        ...freshAnswers,
        occasion: { type: 'choice', choice: 'group' },
      });
      expect(stored(c.first).items.map((i) => i.field)).toEqual([
        'preferences',
        'partySize',
        'area',
      ]);
      expect(stored(c.first).values.occasion!.value).toMatchObject({
        value: 'group',
        provenance: 'inferred',
      });
    });

    it('"hẹn hò" then "sinh nhật": both said, the occasion is asked', async () => {
      const c = await opened(
        'cà phê hẹn hò ở Hà Nội',
        'cà phê sinh nhật ở Hà Nội',
        intent({ occasion: 'date', moods: [] }),
        { ...ranked, occasion: { type: 'choice', choice: 'birthday' } },
      );
      expect(stored(c.first).items).toEqual([{ field: 'occasion', kind: 'changed' }]);
    });

    it('a wish no term matches reads as inferred: the stated one stays settled', async () => {
      const c = await opened(OLD_TEXT, 'quán cà phê cozy cho 2 người ở Hà Nội', intent(), {
        ...ranked,
        'setting:outdoor': { type: 'noul', noul: 0.9 },
      });
      const prefs = stored(c.first).values.preferences!;
      expect(prefs.pending).toBeUndefined();
      expect(prefs.value!.keys).toEqual({ romantic: 'stated' });
    });

    it('a mixed set: only the stated key competes, the inferred one stays assumed', async () => {
      const c = await opened(OLD_TEXT, 'quán cà phê ngoài trời cho 2 người ở Hà Nội', intent(), {
        ...ranked,
        'setting:outdoor': { type: 'noul', noul: 0.9 },
        'mood:quiet': { type: 'noul', noul: 0.9 },
      });
      const prefs = stored(c.first).values.preferences!;
      expect(prefs.pending!.map((p) => p.value)).toEqual([
        { moods: [], settings: ['outdoor'] },
        { moods: ['romantic'], settings: [] },
      ]);
      const chosen = await c.step('Giữ thông tin cũ và cập nhật');
      const next = await c.step(chosen.followUps[0]!.options[0]!.text);
      const payload = next.trace.reconcile as Stored;
      expect(payload.values.preferences!.value!.keys).toEqual({
        outdoor: 'confirmed',
        quiet: 'inferred',
      });
    });
  });

  describe('A-F-03 no promotion, on either model path', () => {
    it('a contradicting Jev answer moves nothing from assumed to settled', async () => {
      const c = await opened(OLD_TEXT, NEW_TEXT, intent({ occasion: 'couple' }), {
        ...freshAnswers,
        occasion: { type: 'choice', choice: 'group' },
      });
      const prefs = await c.step('Giữ thông tin cũ và cập nhật');
      const party = await c.step(prefs.followUps[0]!.options[0]!.text);
      const area = await c.step(party.followUps[0]!.options[1]!.text);
      await c.step(area.followUps[0]!.options[0]!.text);
      const next = await c.step('rẻ hơn chút', {
        answers: relation('answer_pending', {
          occasion: { type: 'choice', choice: 'couple' },
          category: { type: 'choice', choice: 'category:restaurant' },
          'mood:romantic': { type: 'noul', noul: 0.99 },
        }),
      });
      const st = stored(next);
      expect(st.values.occasion!.value).toMatchObject({ value: 'group', provenance: 'inferred' });
      expect(st.values.category!.value!.value).toBe('category:cafe');
      expect(st.values.preferences!.value!.value).toEqual({ moods: [], settings: ['outdoor'] });
      const call = resolvedOf(next.jevCalls[0]!);
      expect(call.assumed.occasion).toBe('group');
      expect(call.settled.occasion).toBeUndefined();
    });

    it('a relevance answer changes no stored value', async () => {
      const { done } = await walked({ places: 6 });
      const before = JSON.stringify(stored(done).values);
      expect(before).toContain('outdoor');
      const c = await walked({
        places: 6,
        answers: { c1: { type: 'noul', noul: 1 }, 'mood:romantic': { type: 'noul', noul: 1 } },
      });
      expect(JSON.stringify(stored(c.done).values)).toBe(before);
    });
  });

  describe('D-19 negation, on the original message', () => {
    it('"3 người thì không nhé" with 2 chosen: asked again, 2 kept', async () => {
      const c = await walked();
      const r = await c.step('3 người thì không nhé', { answers: relation('answer_pending') });
      expect(fields(r)).toEqual(['reconcile_partySize']);
      expect(stored(r).values.partySize!.pending!.map((p) => p.value)).toEqual([2]);
    });

    it('"không 3 người đâu, 4 người": 3 rejected, 4 asserted', async () => {
      const c = await walked();
      const r = await c.step('không 3 người đâu, 4 người', { answers: relation('answer_pending') });
      expect(stored(r).values.partySize!.value!.value).toBe(4);
    });

    it('a quoted number never asserts', async () => {
      const c = await walked();
      const r = await c.step('“3 người” thì đông quá', { answers: relation('answer_pending') });
      expect(stored(r).values.partySize!.value!.value).toBe(2);
    });
  });

  describe('D-17 area and time', () => {
    it('a bare old "Hà Nội", new without an area: keep or drop', async () => {
      const c = await opened('cà phê lãng mạn Hà Nội', 'cà phê ngoài trời');
      expect(stored(c.first).items).toContainEqual({ field: 'area', kind: 'old_only' });
    });

    it('an old area that never resolved is no item; its question fires after the join', async () => {
      const c = await opened('cà phê lãng mạn ở Sài Gòn', 'cà phê ngoài trời');
      expect(stored(c.first).items.map((i) => i.field)).toEqual(['preferences']);
      expect(stored(c.first).values.area!.value!.value).toMatchObject({ kind: 'scope_choice' });
      const prefs = await c.step('Giữ thông tin cũ và cập nhật');
      const done = await c.step(prefs.followUps[0]!.options[0]!.text);
      expect(fields(done)).toContain('area_scope');
    });

    it('"thứ 7 tối" vs "thứ 7" is a change of time', async () => {
      const c = await opened('cà phê lãng mạn thứ 7 tối', 'cà phê lãng mạn thứ 7');
      expect(stored(c.first).items).toEqual([{ field: 'time', kind: 'changed' }]);
    });

    it('a lone "tối" answers the time item; in a sentence it does not', async () => {
      const bare = await opened('cà phê lãng mạn thứ 7 sáng', 'cà phê lãng mạn thứ 7 chiều');
      await bare.step('Giữ thông tin cũ và cập nhật');
      const answered = await bare.step('tối');
      expect(answered.jevCalls).toHaveLength(0);
      expect(stored(answered).values.time!.value).toMatchObject({
        value: { timeHint: 'saturday', dayPart: 'evening' },
        provenance: 'typed',
      });
      const sentence = await opened('cà phê lãng mạn thứ 7 sáng', 'cà phê lãng mạn thứ 7 chiều');
      await sentence.step('Giữ thông tin cũ và cập nhật');
      const unread = await sentence.step('mình đi ăn tối đã nhé', {
        answers: relation('unclear'),
      });
      expect(unread.jevCalls).toHaveLength(1);
      expect(stored(unread).status).toBe('suspended');
    });
  });

  describe('D-11 the in-turn hard stop', () => {
    const usage = (costUsd: number | null) => ({ inputTokens: 1, outputTokens: 1, costUsd });

    it('known spend at the ceiling: the second classification is skipped, deterministically', async () => {
      const metrics: string[] = [];
      const oldUser: HistoryRow = { ...said(OLD_TEXT), id: 'u1' };
      const r = await turn('thôi, tìm cà phê ở Hà Nội', {
        answers: [relation('new_request')],
        history: [
          oldUser,
          {
            role: 'assistant',
            text: 'Kết quả.',
            follow_ups: [],
            trace: { intent: intent(), episodeRefs: [{ id: 'u1', allowBareArea: false }] },
          },
        ],
        archive: [oldUser],
        usage: usage(0.005),
        metrics,
      });
      expect(r.jevCalls).toHaveLength(1);
      expect(r.trace.budgetGuard).toBe('second_decision');
      expect(r.trace.jevDecisionCalls).toBeUndefined();
      expect(metrics).toContain('assistant_fallbacks_total:budget_guard');
    });

    it('relevance is skipped when it no longer fits: unranked, no call', async () => {
      const r = await turn('cà phê lãng mạn ở Hà Nội', {
        answers: { ...ranked, 'mood:romantic': { type: 'noul', noul: 0.9 } },
        places: 6,
        usage: usage(0.0048),
      });
      expect(r.jevCalls).toHaveLength(1);
      expect(r.trace.budgetGuard).toBe('relevance');
      expect(cards(r)).toBeGreaterThan(0);
    });

    it('Haiku is skipped when it no longer fits: a deterministic reply, not a fallback notice', async () => {
      const composer = { calls: 0 };
      const r = await turn('cà phê ở Hà Nội', {
        answers: ranked,
        usage: usage(0.004),
        composer,
      });
      expect(composer.calls).toBe(0);
      expect(r.trace.budgetGuard).toBe('haiku');
      expect(r.frames.some((f) => f.type === 'notice' && f.notice.kind === 'fallback')).toBe(false);
      expect(r.text.length).toBeGreaterThan(0);
    });

    it('under the ceiling every step runs', async () => {
      const composer = { calls: 0 };
      const r = await turn('cà phê ở Hà Nội', { answers: ranked, usage: usage(0.0001), composer });
      expect(composer.calls).toBe(1);
      expect(r.trace.budgetGuard).toBeUndefined();
    });

    it('a call that reported no cost counts at its own worst case, not as zero', async () => {
      const composer = { calls: 0 };
      // Decision worst case + compose worst case fit 0.005; the guard read them.
      const r = await turn('cà phê ở Hà Nội', { answers: ranked, usage: usage(null), composer });
      expect(r.costs.jevCostUsd).toBeNull();
      expect(composer.calls).toBe(1);
      expect(r.trace.jevUnknownCost).toBe(true);
    });
  });

  describe('D-18 unknown tokens stay null', () => {
    const none = { inputTokens: null, outputTokens: null, costUsd: 0.0001 };

    it('no usage: null, not 0', async () => {
      const r = await turn('cà phê ở Hà Nội', { answers: ranked, usage: none });
      expect(r.costs.jevInputTokens).toBeNull();
      expect((r.costs as unknown as { jevOutputTokens: unknown }).jevOutputTokens).toBeNull();
    });

    it('input and output are independent', async () => {
      const r = await turn('cà phê ở Hà Nội', {
        answers: ranked,
        usage: { inputTokens: 5, outputTokens: null, costUsd: 0.0001 },
      });
      expect(r.costs.jevInputTokens).toBe(5);
      expect((r.costs as unknown as { jevOutputTokens: unknown }).jevOutputTokens).toBeNull();
    });

    it("a failed second call: null, not the first call's count", async () => {
      const oldUser: HistoryRow = { ...said(OLD_TEXT), id: 'u1' };
      const r = await turn('thôi, tìm cà phê ở Hà Nội', {
        answers: [relation('new_request'), 'throw'],
        history: [
          oldUser,
          {
            role: 'assistant',
            text: 'Kết quả.',
            follow_ups: [],
            trace: { intent: intent(), episodeRefs: [{ id: 'u1', allowBareArea: false }] },
          },
        ],
        archive: [oldUser],
      });
      expect(r.jevCalls).toHaveLength(2);
      expect(r.costs.jevInputTokens).toBeNull();
    });
  });
});
