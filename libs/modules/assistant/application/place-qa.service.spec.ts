import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoopMetrics } from '@gogo/observability';
import { PlaceQaService } from './place-qa.service';
import { PlaceAnswerReader } from './place-answer-reader';
import { applyFrame, newTurnState } from './turn-state';
import { makeQaPending } from '../domain/place-qa/pending';
import { resolvePlaceNameOutcome } from '../domain/place-qa/resolution';
import { FIXTURE_A, FIXTURE_B, FIXTURE_C, fictionalPlace } from '../domain/place-qa/fixtures';
import type { TurnInput } from './assistant-orchestrator.service';
import type { AssistantFrameInput } from '../domain/assistant.types';
const now = Date.parse('2026-11-11T10:00:00Z');
afterEach(() => vi.restoreAllMocks());
export function qaFixture() {
  const input: TurnInput = {
    messageId: FIXTURE_C,
    ledgerId: 'l',
    conversationId: 'c',
    userId: 'u',
    text: 'Fictional Lantern giá bao nhiêu?',
    locale: 'vi',
    context: null,
  };
  const repo = {
    markPlaceQa: vi.fn(async () => FIXTURE_A),
    clearPlaceQa: vi.fn(async () => true),
    latestAssistant: vi.fn(async (): Promise<any> => null),
    findMessage: vi.fn(async () => ({
      id: FIXTURE_A,
      role: 'user',
      text: input.text,
      locale: 'vi',
    })),
  };
  const facts = { places: new Map([[FIXTURE_A, fictionalPlace()]]) };
  const search = {
    resolvePlaceName: vi.fn(async (_name: string, _options?: unknown) =>
      resolvePlaceNameOutcome({
        candidates: [{ id: FIXTURE_A, exact: true, score: 1 }],
        overflow: false,
        areaMismatch: false,
      }),
    ),
    placeFacts: vi.fn(async () => facts),
  };
  const availability = { placeQaEnabled: vi.fn(async () => true) };
  const areas = { resolve: vi.fn(async () => ({ kind: 'none' })) };
  const metrics = { ...new NoopMetrics(), increment: vi.fn(), observe: vi.fn(), time: vi.fn() };
  const service = new PlaceQaService(
    repo as never,
    search as never,
    areas as never,
    availability as never,
    metrics,
  );
  const state = newTurnState();
  const frames: AssistantFrameInput[] = [];
  const run = async () =>
    service.handle(
      input,
      state,
      {
        emit: async (f) => {
          frames.push(f);
          applyFrame(state, { ...f, messageId: input.messageId, seq: frames.length } as never);
        },
      },
      new AbortController().signal,
      now + 15000,
    );
  const rendered = async () =>
    (
      await new PlaceAnswerReader({ placeFacts: async () => facts }).page(
        [{ id: input.messageId, text: state.text, trace: state.trace, locale: 'vi' }],
        'history',
      )
    ).get(input.messageId)!;
  const setPending = (kind: 'choice' | 'confirm' | 'narrow' | 'referent' = 'choice') => {
    const p = makeQaPending({
      kind,
      questionMessageId: FIXTURE_A,
      assistantMessageId: FIXTURE_B,
      now,
      topic: 'hours',
      args: { day: 'weekday', d: 3 },
      candidates: [FIXTURE_A],
    });
    repo.latestAssistant.mockResolvedValue({
      id: FIXTURE_B,
      status: 'complete',
      trace: { route: 'place_qa', placeQa: { pending: p } },
    });
    return p;
  };
  return {
    input,
    repo,
    search,
    availability,
    areas,
    metrics,
    service,
    state,
    frames,
    run,
    rendered,
    setPending,
  };
}
describe('S3 producer and control precedence', () => {
  it.each([true, false])('owner-approved vi-065 respects QA flag %s', async (enabled) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.text = 'Mấy giờ thì quán Highlands đóng cửa?';
    f.availability.placeQaEnabled.mockResolvedValue(enabled);
    f.search.resolvePlaceName.mockResolvedValue(
      resolvePlaceNameOutcome({ candidates: [], overflow: false, areaMismatch: false }),
    );
    expect(await f.run()).toBe(enabled);
    if (enabled) {
      expect(f.state.trace).toMatchObject({
        route: 'place_qa',
        placeQa: { topic: 'hours', outcome: 'not_found' },
      });
      expect(f.state.costs).toMatchObject({ jevCalls: 0, haikuCalls: 0, jevCostUsd: 0 });
    } else {
      expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
      expect(f.search.resolvePlaceName).not.toHaveBeenCalled();
      expect(f.state.trace.route).not.toBe('place_qa');
    }
  });
  it('fences route before resolution, emits S1 references, and records known zero cost', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.search.resolvePlaceName.mockImplementation(async () => {
      expect(f.repo.markPlaceQa).toHaveBeenCalledOnce();
      expect(f.state.trace.route).toBe('place_qa');
      return resolvePlaceNameOutcome({
        candidates: [{ id: FIXTURE_A, exact: true, score: 1 }],
        overflow: false,
        areaMismatch: false,
      });
    });
    expect(await f.run()).toBe(true);
    expect((await f.rendered()).text).toContain('12000–24000 VND/người');
    expect(JSON.stringify([f.state.text, f.state.trace, f.frames])).not.toMatch(
      /Fictional Lantern|12000|Fictional Street/,
    );
    expect(f.state.costs).toMatchObject({
      jevCalls: 0,
      haikuCalls: 0,
      jevCostUsd: 0,
      haikuUpstreamCostUsd: 0,
      haikuOpenrouterCostUsd: 0,
    });
    expect(f.state.trace).not.toHaveProperty('intent');
    expect(f.state.trace).not.toHaveProperty('episodeRefs');
  });
  it('legacy district always confirms even one exact match', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.text = 'Fictional Lantern mở cửa mấy giờ ở Quận 1?';
    f.search.resolvePlaceName.mockImplementation(async (_name: any, o: any) =>
      resolvePlaceNameOutcome(
        {
          candidates: [{ id: FIXTURE_A, exact: true, score: 1 }],
          overflow: false,
          areaMismatch: false,
        },
        o,
      ),
    );
    await f.run();
    expect((await f.rendered()).text).toContain('GoGo không tra theo quận/huyện cũ');
    expect(f.state.trace.placeQa).toMatchObject({
      outcome: 'confirm',
      pending: { topic: 'hours' },
    });
  });
  it.each(['disabled', 'stale', 'expired', 'foreign_option', 'foreign_source'] as const)(
    '%s structured control makes no resolver/fact lookup',
    async (mode) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const f = qaFixture();
      const p = f.setPending();
      f.input.replyToMessageId = mode === 'stale' ? FIXTURE_C : FIXTURE_B;
      f.input.followUpOptionId = mode === 'foreign_option' ? 'invented' : 'pick_1';
      if (mode === 'disabled') f.availability.placeQaEnabled.mockResolvedValue(false);
      if (mode === 'expired') p.expiresAt = new Date(now).toISOString();
      if (mode === 'foreign_source') f.repo.findMessage.mockResolvedValue(null as never);
      await f.run();
      expect(f.search.resolvePlaceName).not.toHaveBeenCalled();
      expect(f.search.placeFacts).not.toHaveBeenCalled();
      expect(f.state.trace.placeQa).toMatchObject({
        outcome: mode === 'disabled' ? 'disabled' : 'stale_choice',
      });
    },
  );
  it('valid bound selection keeps the original topic and rechecks selected facts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.setPending();
    f.input.replyToMessageId = FIXTURE_B;
    f.input.followUpOptionId = 'pick_1';
    await f.run();
    expect(f.state.trace.placeQa).toMatchObject({
      topic: 'hours',
      args: { d: 3 },
      outcome: 'answer',
    });
    expect(f.search.placeFacts).toHaveBeenCalledWith([FIXTURE_A], expect.anything());
  });
  it.each(['answer', 'narrow', 'not_found'] as const)(
    'bare-name narrow + current area keeps QA exclusion and emits %s',
    async (outcome) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const f = qaFixture();
      const p = f.setPending('narrow');
      p.topic = 'overview';
      p.args = {};
      f.repo.findMessage.mockResolvedValue({
        id: FIXTURE_A,
        role: 'user',
        text: 'Bát Diệp',
        locale: 'vi',
      });
      f.input.text = 'Phường Cầu Giấy, Hà Nội';
      f.areas.resolve.mockResolvedValue({
        kind: 'resolved',
        value: { area: { datasetVersion: 'fixture', provinceCode: '01', communeCode: '00001' } },
      } as never);
      f.search.resolvePlaceName.mockResolvedValue(
        resolvePlaceNameOutcome({
          candidates: outcome === 'answer' ? [{ id: FIXTURE_A, exact: true, score: 1 }] : [],
          overflow: outcome === 'narrow',
          areaMismatch: false,
        }),
      );
      expect(await f.run()).toBe(true);
      expect(f.repo.clearPlaceQa).not.toHaveBeenCalled();
      expect(f.state.trace.route).toBe('place_qa');
      expect(f.state.trace.placeQa).toMatchObject({ outcome });
      expect(f.search.resolvePlaceName).toHaveBeenCalledWith('Bát Diệp', expect.anything());
      expect((await f.rendered()).text.length).toBeGreaterThan(0);
      if (outcome === 'narrow')
        expect(f.state.trace.placeQa).toMatchObject({
          pending: { questionMessageId: FIXTURE_A, createdAt: p.createdAt, expiresAt: p.expiresAt },
        });
    },
  );
  it.each(['price', 'hours', 'amenity'] as const)(
    'referent name reply preserves %s semantics and original lifetime/source',
    async (topic) => {
      vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
      const f = qaFixture();
      const p = f.setPending('referent');
      f.repo.markPlaceQa.mockResolvedValue(FIXTURE_C);
      p.topic = topic;
      p.args =
        topic === 'hours'
          ? { day: 'date', date: '2026-11-12', d: 4, tz: 'Asia/Ho_Chi_Minh' }
          : topic === 'amenity'
            ? { k: 'wifi' }
            : {};
      f.repo.findMessage.mockResolvedValue({
        id: FIXTURE_A,
        role: 'user',
        text: 'Giá bao nhiêu?',
        locale: 'vi',
      });
      f.input.text = 'Quán Sao Lạ';
      // Two exact branches keep the pending state observable before selection.
      f.search.resolvePlaceName.mockResolvedValue(
        resolvePlaceNameOutcome({
          candidates: [FIXTURE_A, FIXTURE_B].map((id) => ({ id, exact: true, score: 1 })),
          overflow: false,
          areaMismatch: false,
        }),
      );
      await f.run();
      expect(f.state.trace.placeQa).toMatchObject({
        topic,
        args: p.args,
        outcome: 'choice',
        pending: {
          topic,
          args: p.args,
          questionMessageId: FIXTURE_A,
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
        },
      });
      // A unique result must answer the original question too.
      f.search.resolvePlaceName.mockResolvedValue(
        resolvePlaceNameOutcome({
          candidates: [{ id: FIXTURE_A, exact: true, score: 1 }],
          overflow: false,
          areaMismatch: false,
        }),
      );
      await f.run();
      expect(f.state.trace.placeQa).toMatchObject({ topic, args: p.args });
      expect(f.state.trace.placeAnswerGroup).toMatchObject({ kind: 'answer' });
    },
  );
  it('structured none near expiry cannot renew the deadline for later area refinement', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 30 * 60_000 - 1);
    const f = qaFixture();
    const p = f.setPending();
    f.input.replyToMessageId = FIXTURE_B;
    f.input.followUpOptionId = 'none';
    await f.run();
    const next = (f.state.trace.placeQa as { pending: typeof p }).pending;
    expect(next).toMatchObject({ createdAt: p.createdAt, expiresAt: p.expiresAt });
    clock.mockReturnValue(now + 30 * 60_000 + 1);
    const later = qaFixture();
    later.repo.latestAssistant.mockResolvedValue({
      id: FIXTURE_C,
      status: 'complete',
      trace: { route: 'place_qa', placeQa: { pending: next } },
    });
    later.input.text = 'Phường Cầu Giấy, Hà Nội';
    later.search.resolvePlaceName.mockResolvedValue(
      resolvePlaceNameOutcome({
        candidates: [],
        overflow: false,
        areaMismatch: false,
      }),
    );
    await later.run();
    expect(later.state.trace.placeQa).toMatchObject({ outcome: 'stale_choice' });
    // An expired state may probe a genuinely new name, never the old source.
    expect(later.search.resolvePlaceName).toHaveBeenCalledWith(later.input.text, expect.anything());
    expect(later.search.placeFacts).not.toHaveBeenCalled();
  });
  it('typed ordinal requires confirmation; ambiguity retries once then clears', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.setPending();
    f.input.text = '1';
    await f.run();
    expect(f.state.trace.placeQa).toMatchObject({ outcome: 'confirm' });
    expect(f.search.placeFacts).not.toHaveBeenCalled();
    const retry = qaFixture();
    retry.search.resolvePlaceName.mockResolvedValue(
      resolvePlaceNameOutcome({ candidates: [], overflow: false, areaMismatch: false }),
    );
    const p = retry.setPending();
    retry.input.text = 'ờ';
    await retry.run();
    expect(retry.state.trace.placeQa).toMatchObject({
      outcome: 'retry',
      pending: { retryCount: 1 },
    });
    p.retryCount = 1;
    await retry.run();
    expect(retry.state.trace.placeQa).toMatchObject({ outcome: 'restate' });
    expect((retry.state.trace.placeQa as any).pending).toBeUndefined();
  });
  it('new recommendation/action exits old pending even with flag off', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.setPending();
    f.availability.placeQaEnabled.mockResolvedValue(false);
    f.input.text = 'Tạo kèo ở Quán Sao Lạ';
    expect(await f.run()).toBe(false);
    expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
  });
  it('named unresolved venue never falls back to the opened place', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.context = { kind: 'place', id: FIXTURE_B };
    f.search.resolvePlaceName.mockResolvedValue(
      resolvePlaceNameOutcome({ candidates: [], overflow: false, areaMismatch: false }),
    );
    expect(await f.run()).toBe(true);
    expect(f.search.placeFacts).not.toHaveBeenCalled();
    expect(f.state.trace.placeQa).toMatchObject({ outcome: 'not_found' });
    expect((await f.rendered()).text).toContain('chưa tìm thấy');
  });
  it('resolver failure keeps the durable association and fails instead of not-found', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.search.resolvePlaceName.mockRejectedValue(new Error('fixture failure'));
    await expect(f.run()).rejects.toThrow('fixture failure');
    expect(f.state.trace).toMatchObject({
      route: 'place_qa',
      questionMessageId: FIXTURE_A,
      placeQa: { row: 1, outcome: 'read_error' },
    });
  });
});

describe('QA-only CMS vocabulary wiring', () => {
  it('loads a new amenity synonym after fencing and emits its stable key, with S2 absence preserved', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.text = 'Fictional Lantern có sân riêng không?';
    const qaVocabulary = vi.fn(async () => {
      expect(f.repo.markPlaceQa).toHaveBeenCalled();
      return [{ kind: 'amenity', key: 'courtyard', terms: ['sân riêng'] }];
    });
    const service = new PlaceQaService(
      f.repo as never,
      f.search as never,
      f.areas as never,
      f.availability as never,
      f.metrics,
      { qaVocabulary } as never,
    );
    await service.handle(
      f.input,
      f.state,
      {
        emit: async (frame) =>
          applyFrame(f.state, { ...frame, messageId: f.input.messageId, seq: 1 } as never),
      },
      new AbortController().signal,
      now + 15000,
    );
    expect(qaVocabulary).toHaveBeenCalledOnce();
    expect(f.state.trace.placeQa).toMatchObject({
      topic: 'amenity',
      args: { k: 'courtyard' },
      outcome: 'no_data',
    });
  });
});

/** One fictional conversation over several turns: each turn reads the previous
 * turn's persisted trace and the user messages by id, as the repository does. */
function qaConversation() {
  const users = new Map<string, { id: string; role: 'user'; text: string; locale: 'vi' }>();
  const places = new Map([
    [FIXTURE_A, fictionalPlace(FIXTURE_A, 'Song Ngọc')],
    [FIXTURE_B, fictionalPlace(FIXTURE_B, 'Song Ngọc')],
  ]);
  let previous: { id: string; status: 'complete'; trace: Record<string, unknown> } | null = null;
  let n = 0;
  const send = async (
    text: string,
    configure: (f: ReturnType<typeof qaFixture>) => void = () => {},
  ) => {
    n += 1;
    const f = qaFixture();
    const userId = `0000000${n}-0000-4000-8000-00000000000a`;
    const assistantId = `0000000${n}-0000-4000-8000-00000000000b`;
    users.set(userId, { id: userId, role: 'user', text, locale: 'vi' });
    f.input.text = text;
    f.input.messageId = assistantId;
    f.repo.markPlaceQa.mockResolvedValue(userId);
    f.repo.findMessage.mockImplementation(
      (async (_u: string, _c: string, id: string) => users.get(id) ?? null) as never,
    );
    f.repo.latestAssistant.mockResolvedValue(previous);
    f.search.placeFacts.mockImplementation((async () => ({ places })) as never);
    configure(f);
    const handled = await f.run();
    if (handled)
      previous = { id: assistantId, status: 'complete', trace: structuredClone(f.state.trace) };
    const view = (
      await new PlaceAnswerReader({ placeFacts: async () => ({ places }) }).page(
        [{ id: assistantId, text: f.state.text, trace: f.state.trace, locale: 'vi' }],
        'history',
      )
    ).get(assistantId)!;
    const qa = f.state.trace.placeQa as
      { outcome: string; topic: string; args: unknown; pending?: Record<string, any> } | undefined;
    return { f, userId, assistantId, handled, view, qa };
  };
  return { send, users, places };
}
const exact = (...ids: string[]) =>
  resolvePlaceNameOutcome({
    candidates: ids.map((id) => ({ id, exact: true, score: 1 })),
    overflow: false,
    areaMismatch: false,
  });
const currentArea = {
  kind: 'resolved',
  value: { area: { datasetVersion: 'fixture', provinceCode: '01', communeCode: '00001' } },
} as never;

describe('Fable fix round — Sol F-02: old client types the emitted confirm option', () => {
  it('two-turn confirmation: emitted ordinal for a choice, then the emitted singleton confirm text, answers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    const choice = await c.send('Song Ngọc mở cửa mấy giờ thứ tư?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    expect(choice.qa).toMatchObject({ outcome: 'choice', topic: 'hours' });
    // The client ignores replyToMessageId/followUpOptionId and types the option text.
    const first = await c.send(choice.view.followUps[0]!.options[1]!.text);
    expect(first.qa).toMatchObject({ outcome: 'confirm', pending: { kind: 'confirm' } });
    expect(first.qa!.pending!.slots[0].candidateIds).toEqual([FIXTURE_B]);
    expect(first.f.search.placeFacts).not.toHaveBeenCalled();
    const emitted = first.view.followUps[0]!.options[0]!.text;
    const second = await c.send(emitted);
    expect(second.qa).toMatchObject({ outcome: 'answer', topic: 'hours', args: choice.qa!.args });
    expect(second.qa!.pending).toBeUndefined();
    // Eligibility is re-read for exactly the confirmed candidate before answering.
    expect(second.f.search.placeFacts).toHaveBeenCalledWith([FIXTURE_B], expect.anything());
    expect(second.f.state.trace.placeAnswerGroup).toMatchObject({
      kind: 'answer',
      cards: [FIXTURE_B],
    });
  });
  it('the exact place name confirms a singleton confirm without an invented prefix', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    c.places.set(FIXTURE_A, fictionalPlace(FIXTURE_A, 'Fictional Lantern'));
    await c.send('Fictional Lantren giá bao nhiêu?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(
        resolvePlaceNameOutcome({
          candidates: [{ id: FIXTURE_A, exact: false, score: 0.6 }],
          overflow: false,
          areaMismatch: false,
        }),
      ),
    );
    const named = await c.send('Fictional Lantern', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(
        resolvePlaceNameOutcome({ candidates: [], overflow: false, areaMismatch: false }),
      ),
    );
    expect(named.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
    expect(named.view.text).toContain('12000–24000 VND/người');
  });
  it('legacy-district confirm (§4.4) is answered after the emitted option text, with the original topic', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    const confirm = await c.send('Song Ngọc mở cửa mấy giờ thứ tư ở Quận 1?', (f) =>
      f.search.resolvePlaceName.mockImplementation(async (_name: any, o: any) =>
        resolvePlaceNameOutcome(
          {
            candidates: [{ id: FIXTURE_A, exact: true, score: 1 }],
            overflow: false,
            areaMismatch: false,
          },
          o,
        ),
      ),
    );
    expect(confirm.qa).toMatchObject({ outcome: 'confirm', topic: 'hours' });
    expect(confirm.view.text).toContain('GoGo không tra theo quận/huyện cũ');
    const answered = await c.send(confirm.view.followUps[0]!.options[0]!.text);
    expect(answered.qa).toMatchObject({
      outcome: 'answer',
      topic: 'hours',
      args: confirm.qa!.args,
    });
    expect(answered.f.search.placeFacts).toHaveBeenCalledWith([FIXTURE_A], expect.anything());
  });
  it('a confirmed candidate that became unavailable is rechecked and never answered with facts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    const choice = await c.send('Song Ngọc giá bao nhiêu?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    const confirm = await c.send(choice.view.followUps[0]!.options[0]!.text);
    const emitted = confirm.view.followUps[0]!.options[0]!.text;
    c.places.set(FIXTURE_A, { ...fictionalPlace(FIXTURE_A, 'Song Ngọc'), available: false });
    const closed = await c.send(emitted);
    expect(closed.qa).toMatchObject({ outcome: 'unavailable' });
    expect(closed.view.text).not.toMatch(/12000|VND/);
  });
  it('an ordinal outside a singleton confirm is not a confirmation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    const choice = await c.send('Song Ngọc giá bao nhiêu?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    await c.send(choice.view.followUps[0]!.options[0]!.text);
    const other = await c.send('2', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(
        resolvePlaceNameOutcome({ candidates: [], overflow: false, areaMismatch: false }),
      ),
    );
    expect(other.qa).toMatchObject({ outcome: 'retry' });
    expect(other.f.search.placeFacts).toHaveBeenCalledTimes(1);
    expect(other.f.state.trace.placeAnswerGroup).toMatchObject({ kind: 'notice' });
  });
});

describe('Fable fix round — Astra F-01: referent continuation keeps the name-bearing source', () => {
  const start = async () => {
    const c = qaConversation();
    const question = await c.send('Giá bao nhiêu?');
    expect(question.qa).toMatchObject({ outcome: 'clarify_referent', topic: 'price' });
    const name = await c.send('Song Ngọc', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    expect(name.qa).toMatchObject({
      outcome: 'choice',
      topic: 'price',
      pending: { questionMessageId: question.userId },
    });
    return { c, question, name };
  };
  const area = (result = exact(FIXTURE_A)) =>
    [
      'Phường Cầu Giấy, Hà Nội',
      (f: ReturnType<typeof qaFixture>) => {
        f.areas.resolve.mockResolvedValue(currentArea);
        f.search.resolvePlaceName.mockResolvedValue(result);
      },
    ] as const;
  it.each(['choice → area', 'typed none → area', 'structured none → area'] as const)(
    '%s resolves the supplied name inside the area and answers the original question',
    async (path) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { c, question, name } = await start();
      if (path === 'typed none → area') {
        const none = await c.send('Không phải các quán này');
        expect(none.qa).toMatchObject({ outcome: 'narrow', topic: 'price' });
      }
      if (path === 'structured none → area') {
        const none = await c.send('Không phải các quán này', (f) => {
          f.input.replyToMessageId = name.assistantId;
          f.input.followUpOptionId = 'none';
        });
        expect(none.qa).toMatchObject({ outcome: 'narrow', topic: 'price' });
      }
      const refined = await c.send(...area());
      expect(refined.f.search.resolvePlaceName).toHaveBeenCalledTimes(1);
      expect(refined.f.search.resolvePlaceName).toHaveBeenCalledWith(
        'Song Ngọc',
        expect.objectContaining({ area: expect.objectContaining({ kind: 'current' }) }),
      );
      expect(refined.qa).toMatchObject({
        outcome: 'answer',
        topic: 'price',
        args: question.qa!.args,
      });
      expect(refined.view.text).toContain('12000–24000 VND/người');
    },
  );
  it('a branch choice inside the area keeps question, name source, topic and the original expiry', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const { c, question, name } = await start();
    const original = question.qa!.pending!;
    clock.mockReturnValue(now + 10 * 60_000);
    await c.send('Không phải các quán này');
    clock.mockReturnValue(now + 20 * 60_000);
    const refined = await c.send(...area(exact(FIXTURE_A, FIXTURE_B)));
    expect(refined.qa).toMatchObject({
      outcome: 'choice',
      topic: 'price',
      pending: {
        kind: 'choice',
        questionMessageId: question.userId,
        topic: 'price',
        createdAt: original.createdAt,
        expiresAt: original.expiresAt,
      },
    });
    expect(refined.qa!.pending!.slots[0].sourceMessageId).toBe(name.userId);
    const picked = await c.send('2', (f) => {
      f.input.replyToMessageId = refined.assistantId;
      f.input.followUpOptionId = 'pick_2';
    });
    expect(picked.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
    expect(picked.f.search.placeFacts).toHaveBeenCalledWith([FIXTURE_B], expect.anything());
    // The original 30-minute lifetime still ends on time.
    clock.mockReturnValue(now + 30 * 60_000 + 1);
    const late = await c.send('2', (f) => {
      f.input.replyToMessageId = refined.assistantId;
      f.input.followUpOptionId = 'pick_2';
    });
    expect(late.qa).toMatchObject({ outcome: 'stale_choice' });
  });
  it.each(['question', 'name'] as const)(
    'an inaccessible %s source invalidates the continuation before any lookup',
    async (lost) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { c, question, name } = await start();
      c.users.delete(lost === 'question' ? question.userId : name.userId);
      const refined = await c.send(...area());
      expect(refined.qa).toMatchObject({ outcome: 'stale_choice' });
      expect(refined.f.search.resolvePlaceName).not.toHaveBeenCalled();
      expect(refined.f.search.placeFacts).not.toHaveBeenCalled();
      const structured = await c.send('1', (f) => {
        f.input.replyToMessageId = name.assistantId;
        f.input.followUpOptionId = 'pick_1';
      });
      expect(structured.qa).toMatchObject({ outcome: 'stale_choice' });
      expect(structured.f.search.placeFacts).not.toHaveBeenCalled();
    },
  );
});

describe('Fable fix round — Sol F-01: admission fence before cancellable work', () => {
  it('admit writes the durable association with no signal; handle reuses its reads', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    await f.service.admit(f.input, f.state);
    expect(f.repo.markPlaceQa).toHaveBeenCalledOnce();
    expect(f.search.resolvePlaceName).not.toHaveBeenCalled();
    expect(f.state.trace).toMatchObject({
      route: 'place_qa',
      questionMessageId: FIXTURE_A,
      placeAnswerGroup: { kind: 'notice', message: 'read_error' },
    });
    // Unknown cost stays unknown until the producer runs; nothing is dispatched.
    expect(f.state.costs).toMatchObject({ jevCalls: 0, haikuCalls: 0, jevCostUsd: null });
    // A flag flip after admission cannot send a fenced turn to the model path.
    f.availability.placeQaEnabled.mockResolvedValue(false);
    expect(await f.run()).toBe(true);
    expect(f.availability.placeQaEnabled).toHaveBeenCalledOnce();
    expect(f.repo.latestAssistant).toHaveBeenCalledOnce();
    expect(f.repo.markPlaceQa).toHaveBeenCalledOnce();
    expect(f.state.trace.placeQa).toMatchObject({ outcome: 'answer', topic: 'price' });
    expect(f.state.trace.placeAnswerGroup).toMatchObject({ kind: 'answer' });
  });
  it.each([
    ['flag off', 'Fictional Lantern giá bao nhiêu?', false],
    ['recommendation', 'Gợi ý quán cafe ở Hà Nội giá 100k', true],
  ])('admit leaves a non-QA turn untouched (%s)', async (_name, text, enabled) => {
    const f = qaFixture();
    f.input.text = text;
    f.availability.placeQaEnabled.mockResolvedValue(enabled);
    await f.service.admit(f.input, f.state);
    expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
    expect(f.state.trace).toEqual({});
    expect(await f.run()).toBe(false);
    expect(f.state.trace).toEqual({});
    expect(f.availability.placeQaEnabled).toHaveBeenCalledOnce();
  });
  it.each(['structured control', 'typed reply to the latest QA turn'] as const)(
    'admit fences %s even with the flag off',
    async (mode) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const f = qaFixture();
      f.setPending();
      f.availability.placeQaEnabled.mockResolvedValue(false);
      f.input.text = '1';
      if (mode === 'structured control') {
        f.input.replyToMessageId = FIXTURE_B;
        f.input.followUpOptionId = 'pick_1';
      }
      await f.service.admit(f.input, f.state);
      expect(f.state.trace.route).toBe('place_qa');
      expect(f.repo.markPlaceQa).toHaveBeenCalledOnce();
      expect(await f.run()).toBe(true);
      expect(f.state.trace.placeQa).toMatchObject({ outcome: 'disabled' });
    },
  );
  it('a failed name-only probe after admission restores the ordinary turn completely', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.text = 'Cầu Giấy';
    f.search.resolvePlaceName.mockResolvedValue(
      resolvePlaceNameOutcome({ candidates: [], overflow: false, areaMismatch: false }),
    );
    await f.service.admit(f.input, f.state);
    expect(f.state.trace.route).toBe('place_qa');
    expect(await f.run()).toBe(false);
    expect(f.repo.clearPlaceQa).toHaveBeenCalledOnce();
    expect(f.state.trace).toEqual({});
    expect(f.state.costs).toMatchObject({ jevCostUsd: null, haikuUpstreamCostUsd: null });
    expect(f.frames).toEqual([]);
  });
});
