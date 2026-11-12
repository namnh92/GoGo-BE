import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoopMetrics } from '@gogo/observability';
import { PlaceQaService } from './place-qa.service';
import { PlaceAnswerReader } from './place-answer-reader';
import { applyFrame, newTurnState } from './turn-state';
import { confirmText, isTypedConfirm, makeQaPending } from '../domain/place-qa/pending';
import { placeNameVariants, resolvePlaceNameOutcome } from '../domain/place-qa/resolution';
import { FIXTURE_A, FIXTURE_B, FIXTURE_C, fictionalPlace } from '../domain/place-qa/fixtures';
import { firstTextGuard, type TurnInput } from './assistant-orchestrator.service';
import { qaProbeOf } from '../domain/place-qa/classifier';
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
    persistQaEnabled: vi.fn(async () => true),
    settleQaProbe: vi.fn(async (_id: string, _enabled: boolean) => false),
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
      Date.now() + 15000,
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
    expect((await f.rendered()).text).toContain('12.000–24.000 VND/người');
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
      Date.now() + 15000,
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
  const users = new Map<string, { id: string; role: 'user'; text: string; locale: 'vi' | 'en' }>();
  const places = new Map<string, ReturnType<typeof fictionalPlace>>([
    [FIXTURE_A, { ...fictionalPlace(FIXTURE_A, 'Song Ngọc'), areaLabel: 'Phường Ba Đình, Hà Nội' }],
    [
      FIXTURE_B,
      { ...fictionalPlace(FIXTURE_B, 'Song Ngọc'), areaLabel: 'Phường Cầu Giấy, Hà Nội' },
    ],
  ]);
  let previous: {
    id: string;
    status: 'complete';
    locale: 'vi' | 'en';
    trace: Record<string, unknown>;
  } | null = null;
  let n = 0;
  const send = async (
    text: string,
    configure: (f: ReturnType<typeof qaFixture>) => void = () => {},
  ) => {
    n += 1;
    const f = qaFixture();
    const userId = `0000000${n}-0000-4000-8000-00000000000a`;
    const assistantId = `0000000${n}-0000-4000-8000-00000000000b`;
    f.input.text = text;
    f.input.messageId = assistantId;
    f.repo.markPlaceQa.mockResolvedValue(userId);
    f.repo.findMessage.mockImplementation(
      (async (_u: string, _c: string, id: string) => users.get(id) ?? null) as never,
    );
    f.repo.latestAssistant.mockResolvedValue(previous);
    f.search.placeFacts.mockImplementation((async () => ({ places })) as never);
    f.search.resolvePlaceName.mockImplementation(async () => exact(...places.keys()));
    configure(f);
    users.set(userId, { id: userId, role: 'user', text, locale: f.input.locale });
    const handled = await f.run();
    if (handled)
      previous = {
        id: assistantId,
        status: 'complete',
        locale: f.input.locale,
        trace: structuredClone(f.state.trace),
      };
    const view = (
      await new PlaceAnswerReader({ placeFacts: async () => ({ places }) }).page(
        [{ id: assistantId, text: f.state.text, trace: f.state.trace, locale: f.input.locale }],
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

describe('Sol fix round (r5)', () => {
  it.each([true, false])('latches flag %s before route, reads or frames', async (enabled) => {
    const f = qaFixture();
    f.availability.placeQaEnabled.mockResolvedValue(enabled);
    f.repo.persistQaEnabled.mockImplementation(async () => {
      expect(f.availability.placeQaEnabled).toHaveBeenCalledOnce();
      expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
      expect(f.repo.latestAssistant).not.toHaveBeenCalled();
      expect(f.search.resolvePlaceName).not.toHaveBeenCalled();
      expect(f.frames).toEqual([]);
      throw new Error('producer died after flag observation');
    });
    await expect(f.run()).rejects.toThrow('producer died after flag observation');
    expect(f.repo.persistQaEnabled).toHaveBeenCalledWith(
      f.input.userId,
      f.input.conversationId,
      f.input.messageId,
      enabled,
      expect.objectContaining({ signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) }),
    );
    expect(f.state.qaEnabled).toBe(enabled);
    expect(f.state.qaDecided).toBeUndefined();
    expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
  });

  it.each(['deadline', 'stop'] as const)('bounds a stalled flag latch by %s', async (mode) => {
    vi.useFakeTimers();
    try {
      const f = qaFixture();
      const controller = new AbortController();
      let writeSignal: AbortSignal | undefined;
      f.repo.persistQaEnabled.mockImplementation((async (...args: any[]) => {
        writeSignal = args[4].signal;
        return new Promise(() => {});
      }) as never);
      const deadlineAt = Date.now() + 100;
      const work = f.service
        .handle(f.input, f.state, { emit: async () => {} }, controller.signal, deadlineAt)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(writeSignal).toBeDefined();
      if (mode === 'stop') controller.abort(new Error('stopped'));
      else await vi.advanceTimersByTimeAsync(100);
      expect(await work).toBeInstanceOf(Error);
      expect(writeSignal!.aborted).toBe(true);
      expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
      expect(f.search.resolvePlaceName).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps unequivocal ordinary commands free of flag and latch work', async () => {
    const f = qaFixture();
    f.input.text = 'Gợi ý quán cafe ở Hà Nội';
    expect(await f.run()).toBe(false);
    expect(f.availability.placeQaEnabled).not.toHaveBeenCalled();
    expect(f.repo.persistQaEnabled).not.toHaveBeenCalled();
  });

  it.each(['omitted', 'changed'] as const)(
    'accepts the English emitted confirm text with %s follow-up locale',
    async (mode) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const c = qaConversation();
      c.places.delete(FIXTURE_B);
      const confirm = await c.send('Price of Song Ngọc in Quận 1?', (f) => {
        f.input.locale = 'en';
        f.search.resolvePlaceName.mockImplementation(async (name, options) => {
          expect(name).toBe('Song Ngọc');
          expect(options).toMatchObject({ area: { kind: 'legacy' } });
          return resolvePlaceNameOutcome(
            {
              candidates: [{ id: FIXTURE_A, exact: true, score: 1 }],
              overflow: false,
              areaMismatch: false,
            },
            { area: { kind: 'legacy' } },
          );
        });
      });
      expect(confirm.qa).toMatchObject({ outcome: 'confirm', topic: 'price' });
      const emitted = confirm.view.followUps[0]!.options[0]!.text;
      expect(emitted).toMatch(/^Confirm Song Ngọc · /u);
      // The service receives vi both for the request default and explicit change.
      const reply = await c.send(emitted, (f) => {
        if (mode === 'changed') f.input.locale = 'vi';
      });
      expect(reply.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
      expect(reply.f.state.trace.placeQa).toMatchObject({ candidateIds: [FIXTURE_A] });
      expect(reply.f.input.locale).toBe('vi');
      expect(reply.view.text).toContain('12.000–24.000 VND/người');
    },
  );
});

describe('Fable fix round — Sol F-02: old client types the emitted confirm option', () => {
  it('two-turn confirmation: legacy typed ordinal for a choice, then the emitted singleton confirm text, answers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    const choice = await c.send('Song Ngọc mở cửa mấy giờ thứ tư?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    expect(choice.qa).toMatchObject({ outcome: 'choice', topic: 'hours' });
    // A legacy client sends an ordinal without the source-bound id pair.
    const first = await c.send('2');
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
  it('the exact place name re-asks for the complete name + area confirmation', async () => {
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
    expect(named.qa).toMatchObject({ outcome: 'confirm', topic: 'price' });
    expect(named.view.text).not.toContain('12.000–24.000 VND/người');
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
    const _choice = await c.send('Song Ngọc giá bao nhiêu?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    const confirm = await c.send('1');
    const emitted = confirm.view.followUps[0]!.options[0]!.text;
    c.places.set(FIXTURE_A, { ...fictionalPlace(FIXTURE_A, 'Song Ngọc'), available: false });
    const closed = await c.send(emitted);
    expect(closed.qa).toMatchObject({ outcome: 'retry' });
    expect(closed.view.text).not.toMatch(/12000|VND/);
  });
  it('round 2: a stale ordinal of the earlier choice never confirms the other branch', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    const _choice = await c.send('Song Ngọc giá bao nhiêu?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    const confirmB = await c.send('2');
    expect(confirmB.qa!.pending!.slots[0].candidateIds).toEqual([FIXTURE_B]);
    // Old client taps A's chip from the earlier message: the bare ordinal "1".
    const stale = await c.send('1');
    expect(stale.qa).toMatchObject({ outcome: 'confirm' });
    expect(stale.qa!.pending!.slots[0].candidateIds).toEqual([FIXTURE_B]);
    expect(stale.f.search.placeFacts).not.toHaveBeenCalled();
    expect(stale.f.state.trace.placeAnswerGroup).toMatchObject({ kind: 'clarification' });
    // The emitted confirm text identifies the candidate of THIS confirmation.
    const emitted = stale.view.followUps[0]!.options[0]!.text;
    expect(emitted).toContain('Song Ngọc');
    expect(emitted).not.toMatch(/^\d+$/);
    // An emitted confirm text of an earlier confirmation (another message) is
    // not this one's, even for an identically named branch.
    expect(confirmB.view.followUps[0]!.options[0]!.text).toBe(emitted);
    // Same complete unique identity still denotes the same branch, not a source id.
    const same = await c.send(emitted);
    expect(same.qa).toMatchObject({ outcome: 'answer' });
  });
  it('an ordinal outside a singleton confirm is not a confirmation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    const _choice = await c.send('Song Ngọc giá bao nhiêu?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    await c.send('1');
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
      expect(refined.view.text).toContain('12.000–24.000 VND/người');
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

describe('Fable fix round 2 — fence decisions stay inside the guarded producer', () => {
  it.each([
    [true, 'structured', '1', null, 'control'],
    [false, 'explicit recommendation', 'Gợi ý quán cafe ở Hà Nội giá 100k', null, null],
    [false, 'QA-shaped question', 'Fictional Lantern giá bao nhiêu?', null, 'question'],
    [false, 'deictic question', 'Giá bao nhiêu?', null, 'question'],
    [false, 'bare text', 'Cầu Giấy', null, 'name'],
    [
      false,
      'long free text',
      'ừ thì mình cũng chưa biết nữa để mình nghĩ thêm rồi nói sau nha bạn ơi',
      null,
      'reply',
    ],
  ] as const)('qaProbeOf(%s, %s) is pure and reads nothing', (structured, _n, text, ctx, probe) => {
    expect(qaProbeOf(text, ctx, 'vi', structured)).toBe(probe);
  });
  it('a name-only probe writes no fence and sets no route until the whole name qualifies', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.text = 'Fictional Lantern';
    f.search.resolvePlaceName.mockImplementation(async () => {
      expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
      expect(f.state.trace).toEqual({});
      return resolvePlaceNameOutcome({
        candidates: [{ id: FIXTURE_A, exact: true, score: 1 }],
        overflow: false,
        areaMismatch: false,
      });
    });
    expect(await f.run()).toBe(true);
    expect(f.repo.markPlaceQa).toHaveBeenCalledOnce();
    expect(f.state.trace).toMatchObject({
      route: 'place_qa',
      placeQa: { class: 'name_only', topic: 'overview', outcome: 'answer' },
    });
    expect(f.state.qaDecided).toBe(true);
  });
  it('an unqualified probe is an ordinary turn: nothing written, nothing to undo', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.text = 'Cầu Giấy';
    f.search.resolvePlaceName.mockResolvedValue(
      resolvePlaceNameOutcome({ candidates: [], overflow: false, areaMismatch: false }),
    );
    expect(await f.run()).toBe(false);
    expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
    expect(f.state.trace).toEqual({});
    expect(f.state.costs).toMatchObject({ jevCostUsd: null, haikuUpstreamCostUsd: null });
    expect(f.frames).toEqual([]);
    expect(f.state.qaDecided).toBe(true);
  });
  // §4.3 row 1: a read error is never "not found" and never a silent fallback;
  // §3.1: nothing qualified the name, so the failed turn is not a QA turn.
  it('a probe read error fails the turn undecided and unfenced', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.text = 'Cầu Giấy';
    f.search.resolvePlaceName.mockRejectedValue(new Error('fixture failure'));
    await expect(f.run()).rejects.toThrow('fixture failure');
    expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
    expect(f.state.trace).toEqual({});
    expect(f.state.qaDecided).toBeUndefined();
  });
  it.each([
    ['flag on', true, 'Fictional Lantern giá bao nhiêu?', true],
    ['flag off', false, 'Fictional Lantern giá bao nhiêu?', false],
    ['flag off', false, 'Gợi ý quán cafe ở Hà Nội giá 100k', false],
  ] as const)('%s: the producer records that it decided (%s → %s)', async (_n, on, text, qa) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.input.text = text;
    f.availability.placeQaEnabled.mockResolvedValue(on);
    expect(await f.run()).toBe(qa);
    expect(f.state.qaDecided).toBe(true);
    expect(f.state.trace.route).toBe(qa ? 'place_qa' : undefined);
  });
  it.each([['latestAssistant', 'Cầu Giấy']] as const)(
    'a stalled %s read ends at the one first-text deadline, with no fence and no new allowance (%s)',
    async (read, text) => {
      vi.useFakeTimers();
      try {
        const f = qaFixture();
        f.input.text = text;
        f.repo.latestAssistant.mockReturnValue(new Promise(() => {}));
        const deadline = Date.now() + 15_000;
        const guard = firstTextGuard(deadline, new AbortController().signal);
        const settled = guard
          .run(() =>
            f.service.handle(f.input, f.state, { emit: async () => {} }, guard.signal, deadline),
          )
          .then(
            () => 'resolved',
            (e: unknown) => (e as Error).name,
          );
        await vi.advanceTimersByTimeAsync(14_999);
        expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await settled).toBe('FirstTextDeadlineError');
        expect(f.repo.markPlaceQa).not.toHaveBeenCalled();
        expect(f.state.trace).toEqual({});
        expect(f.state.qaDecided).toBeUndefined();
        expect(f.search.resolvePlaceName).not.toHaveBeenCalled();
        guard.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('Fable fix round 2 — open decision at the first-text deadline, and confirm text', () => {
  it.each([
    ['question', true, true],
    ['question', false, false],
    ['name', true, false],
    ['reply', true, false],
  ] as const)(
    'settleUndecided(%s, flag %s) passes enabled=%s and adopts the result',
    async (probe, on, sent) => {
      const f = qaFixture();
      f.input.qaProbe = probe;
      f.availability.placeQaEnabled.mockResolvedValue(on);
      f.repo.settleQaProbe.mockResolvedValue(sent || probe !== 'question');
      const qa = await f.service.settleUndecided(f.input, f.state);
      expect(f.repo.settleQaProbe).toHaveBeenCalledWith(
        f.input.messageId,
        sent,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          deadlineAt: expect.any(Number),
        }),
      );
      expect(f.availability.placeQaEnabled).toHaveBeenCalledTimes(probe === 'question' ? 1 : 0);
      expect(f.state.qaDecided).toBe(true);
      expect(qa).toBe(sent || probe !== 'question');
      expect(f.state.trace.route).toBe(qa ? 'place_qa' : undefined);
    },
  );
  it.each([
    ['already decided', 'question', true],
    ['no marker', null, false],
    ['structured control', 'control', false],
  ] as const)('settleUndecided reads and writes nothing when %s', async (_n, probe, decided) => {
    const f = qaFixture();
    f.input.qaProbe = probe;
    if (decided) f.state.qaDecided = true;
    expect(await f.service.settleUndecided(f.input, f.state)).toBe(false);
    expect(f.repo.settleQaProbe).not.toHaveBeenCalled();
    expect(f.availability.placeQaEnabled).not.toHaveBeenCalled();
  });
  it('a flag read that never returns is bounded and defaults disabled', async () => {
    vi.useFakeTimers();
    try {
      const f = qaFixture();
      f.input.qaProbe = 'question';
      f.availability.placeQaEnabled.mockReturnValue(new Promise<boolean>(() => {}));
      f.repo.settleQaProbe.mockResolvedValue(false);
      const settled = f.service.settleUndecided(f.input, f.state);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await settled).toBe(false);
      expect(f.repo.settleQaProbe).toHaveBeenCalledWith(
        f.input.messageId,
        false,
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['Cafe Gợi Ý Quán Ngon', 'Nhà hàng Tìm Quán Cafe', 'Best Restaurant Recommend'])(
    'the emitted confirm text of a place named "%s" is QA control, not a new request',
    async (name) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      for (const locale of ['vi', 'en'] as const) {
        const text = confirmText(locale, name, 'Phường Ba Đình, Hà Nội')!;
        expect(isTypedConfirm(text)).toBe(true);
        expect(qaProbeOf(text, null, locale, false)).toBe('control');
      }
      const c = qaConversation();
      c.places.set(FIXTURE_A, {
        ...fictionalPlace(FIXTURE_A, name),
        areaLabel: 'Phường Ba Đình, Hà Nội',
      });
      c.places.set(FIXTURE_B, {
        ...fictionalPlace(FIXTURE_B, name),
        areaLabel: 'Phường Cầu Giấy, Hà Nội',
      });
      const _choice = await c.send('Song Ngọc giá bao nhiêu?', (f) =>
        f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
      );
      const confirm = await c.send('2');
      const emitted = confirm.view.followUps[0]!.options[0]!.text;
      expect(emitted).toContain(name);
      const answered = await c.send(emitted);
      expect(answered.handled).toBe(true);
      expect(answered.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
      expect(answered.f.search.placeFacts).toHaveBeenCalledWith([FIXTURE_B], expect.anything());
    },
  );
});

describe('Astra amendment regressions', () => {
  it.each(['Gợi ý quán cafe ở Hà Nội', 'Tạo kèo ở Song Ngọc', 'GoGo tạo kèo thế nào?', 'cafe'])(
    'A3 bypasses failed QA dependencies: %s',
    async (text) => {
      const f = qaFixture();
      f.input.text = text;
      f.availability.placeQaEnabled.mockRejectedValue(new Error('QA flag unavailable'));
      f.repo.latestAssistant.mockRejectedValue(new Error('QA latest unavailable'));
      expect(await f.run()).toBe(false);
      expect(f.state.qaDecided).toBe(true);
      expect(f.availability.placeQaEnabled).not.toHaveBeenCalled();
      expect(f.repo.latestAssistant).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])('A3 fresh question skips latest with flag %s', async (enabled) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = qaFixture();
    f.availability.placeQaEnabled.mockResolvedValue(enabled);
    f.repo.latestAssistant.mockRejectedValue(new Error('unneeded read failed'));
    expect(await f.run()).toBe(enabled);
    expect(f.repo.latestAssistant).not.toHaveBeenCalled();
  });
  it('A6 flag rejection takes the ordinary path without a QA route', async () => {
    const f = qaFixture();
    f.availability.placeQaEnabled.mockRejectedValue(new Error('flag read failed'));
    expect(await f.run()).toBe(false);
    expect(f.state.trace.route).toBeUndefined();
    expect(f.state.qaDecided).toBe(true);
  });
  it('A6 recovery flag rejection is disabled, never enabled', async () => {
    const f = qaFixture();
    f.input.qaProbe = 'question';
    f.availability.placeQaEnabled.mockRejectedValue(new Error('flag read failed'));
    await f.service.settleUndecided(f.input, f.state);
    expect(f.repo.settleQaProbe.mock.calls[0]?.[1]).toBe(false);
  });
  it.each([true, false])(
    'A5 stalled settlement ends within the cleanup budget (flag %s)',
    async (enabled) => {
      vi.useFakeTimers();
      try {
        const f = qaFixture();
        f.input.qaProbe = 'question';
        f.availability.placeQaEnabled.mockResolvedValue(enabled);
        f.repo.settleQaProbe.mockReturnValue(new Promise(() => {}));
        const result = f.service.settleUndecided(f.input, f.state).then(
          () => 'resolved',
          () => 'rejected',
        );
        await vi.advanceTimersByTimeAsync(1501);
        expect(await Promise.race([result, Promise.resolve('pending')])).toBe('rejected');
        expect(f.state.trace.route).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('A2 reader emits the owner name + area copy without a code', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    c.places.set(FIXTURE_A, {
      ...fictionalPlace(FIXTURE_A, 'Song Ngọc'),
      areaLabel: 'Phường Ba Đình, Hà Nội',
    });
    const _choice = await c.send('Song Ngọc giá bao nhiêu?', (f) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B)),
    );
    const confirm = await c.send('1');
    expect(confirm.view.followUps[0]!.options[0]!.text).toBe(
      'Xác nhận Song Ngọc · Phường Ba Đình, Hà Nội',
    );
  });
  it('A2 identical name + area across branches never confirms from emitted text', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    for (const id of [FIXTURE_A, FIXTURE_B])
      c.places.set(id, { ...fictionalPlace(id, 'Song Ngọc'), areaLabel: 'Phường Ba Đình, Hà Nội' });
    const configure = (f: ReturnType<typeof qaFixture>) =>
      f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B));
    const choice = await c.send('Song Ngọc giá bao nhiêu?', configure);
    const confirm = await c.send(choice.view.followUps[0]!.options[0]!.text, configure);
    const reply = await c.send(confirm.view.followUps[0]!.options[0]!.text, configure);
    expect(reply.qa?.outcome).not.toBe('answer');
    expect(reply.f.state.trace.placeAnswerGroup).not.toMatchObject({ kind: 'answer' });
  });
});

describe('Astra cleanup cancellation and authoritative disabled decision', () => {
  it.each(['Stop', 'ceiling'])(
    'A5 %s cancels settlement immediately; late completion cannot mutate route',
    async (_reason) => {
      const f = qaFixture();
      f.input.qaProbe = 'question';
      let finish!: (qa: boolean) => void;
      let signal: AbortSignal | undefined;
      f.repo.settleQaProbe.mockImplementation((async (
        _id: string,
        _enabled: boolean,
        options: { signal: AbortSignal },
      ) => {
        signal = options.signal;
        return new Promise<boolean>((resolve) => {
          finish = resolve;
        });
      }) as never);
      const controller = new AbortController();
      const work = f.service.settleUndecided(f.input, f.state, controller.signal);
      const rejected = expect(work).rejects.toBeDefined();
      for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
      expect(finish).toBeDefined();
      controller.abort();
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(f.state.qaSettlementUncertain).toBe(true);
      finish(true);
      await Promise.resolve();
      expect(f.state.trace.route).toBeUndefined();
      expect(f.state.qaDecided).not.toBe(true);
    },
  );
  it('A6 deadline recovery retains an observed disabled value without resampling', async () => {
    const f = qaFixture();
    f.input.qaProbe = 'question';
    f.state.qaEnabled = false;
    f.availability.placeQaEnabled.mockResolvedValue(true);
    expect(await f.service.settleUndecided(f.input, f.state)).toBe(false);
    expect(f.availability.placeQaEnabled).not.toHaveBeenCalled();
    expect(f.repo.settleQaProbe).toHaveBeenCalledWith(f.input.messageId, false, expect.anything());
  });
  it('A6 stalled producer flag defaults disabled at 1.5s and ignores late true', async () => {
    vi.useFakeTimers();
    try {
      const f = qaFixture();
      let release!: (enabled: boolean) => void;
      f.availability.placeQaEnabled.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const work = f.service.handle(
        f.input,
        f.state,
        { emit: async () => {} },
        new AbortController().signal,
        Date.now() + 15000,
      );
      await vi.advanceTimersByTimeAsync(1500);
      expect(await work).toBe(false);
      release(true);
      await Promise.resolve();
      expect(f.state.qaEnabled).toBe(false);
      expect(f.state.qaDecided).toBe(true);
      expect(f.state.trace.route).toBeUndefined();
      expect(f.repo.latestAssistant).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

it('Astra A2: a text-only confirmation after an ordinary turn is stale control, never a model input', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const f = qaFixture();
  f.input.text = 'Xác nhận Song Ngọc · Phường Ba Đình, Hà Nội';
  f.repo.latestAssistant.mockResolvedValue({ id: FIXTURE_B, status: 'complete', trace: {} });
  expect(qaProbeOf(f.input.text, null, 'vi', false)).toBe('control');
  expect(await f.run()).toBe(true);
  expect(f.state.trace.placeQa).toMatchObject({ outcome: 'stale_choice' });
  expect(f.search.resolvePlaceName).not.toHaveBeenCalled();
  expect(f.search.placeFacts).not.toHaveBeenCalled();
});

it('Astra A2: stale name + other-area text cannot confirm the latest branch', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const c = qaConversation();
  const configure = (f: ReturnType<typeof qaFixture>) =>
    f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A, FIXTURE_B));
  await c.send('Song Ngọc giá bao nhiêu?', configure);
  const confirmA = await c.send('1');
  const oldText = confirmA.view.followUps[0]!.options[0]!.text;
  await c.send('Song Ngọc giá bao nhiêu?', configure);
  const confirmB = await c.send('2');
  expect(confirmB.view.followUps[0]!.options[0]!.text).not.toBe(oldText);
  const stale = await c.send(oldText);
  expect(stale.qa?.outcome).toBe('retry');
  expect(stale.view.text).not.toContain('VND');
});

it('Astra amendment regressions A2: the concrete 574568 legacy collision cannot confirm another branch', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  // At 00f691f1, FNV-1a modulo 1e6 gives 574568 for BOTH:
  // (0000018d-0000-4000-8000-00000000000b, FIXTURE_A) and
  // (000009f8-0000-4000-8000-00000000000b, FIXTURE_B).
  // The old text-only client sends branch A's earlier chip to latest branch B.
  const f = qaFixture();
  const latestId = '000009f8-0000-4000-8000-00000000000b';
  f.input.text = 'Xác nhận Song Ngọc (574568)';
  const pending = makeQaPending({
    kind: 'confirm',
    questionMessageId: FIXTURE_A,
    assistantMessageId: latestId,
    now,
    topic: 'price',
    args: {},
    candidates: [FIXTURE_B],
  });
  f.repo.latestAssistant.mockResolvedValue({
    id: latestId,
    status: 'complete',
    trace: {
      route: 'place_qa',
      placeQa: { pending },
    },
  });
  f.search.placeFacts.mockResolvedValue({
    places: new Map([
      [
        FIXTURE_B,
        {
          ...fictionalPlace(FIXTURE_B, 'Song Ngọc'),
          areaLabel: 'Phường Cầu Giấy, Hà Nội',
        },
      ],
    ]),
  });
  expect(await f.run()).toBe(true);
  expect(f.state.trace.placeQa).toMatchObject({ outcome: 'retry' });
  expect(f.state.trace.placeAnswerGroup).not.toMatchObject({ kind: 'answer' });
  expect(f.state.text).not.toContain('VND');
});

describe('GoGo-BE#875 typed confirmation from the emitted chip', () => {
  it('revalidates the en-dash canonical name against the stored ASCII-dash family', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    c.places.delete(FIXTURE_B);
    c.places.set(FIXTURE_A, {
      ...fictionalPlace(FIXTURE_A, 'Mizu – Bến Sương'),
      areaLabel: 'Phường Cầu Giấy, Hà Nội',
    });
    const lookup = (name: string) =>
      resolvePlaceNameOutcome({
        candidates: [
          {
            id: FIXTURE_A,
            score: 0.8,
            exact: placeNameVariants(name).includes('mizu - ben suong'),
          },
        ],
        overflow: false,
        areaMismatch: false,
      });
    const first = await c.send('Mizuu Bến Sương giá bao nhiêu?', (f) =>
      f.search.resolvePlaceName.mockImplementation(async (name) => lookup(name)),
    );
    expect(first.qa).toMatchObject({ outcome: 'confirm', topic: 'price' });
    const text = first.view.followUps[0]!.options[0]!.text;
    expect(text).toBe('Xác nhận Mizu – Bến Sương · Phường Cầu Giấy, Hà Nội');
    expect(isTypedConfirm(text)).toBe(true);
    const next = await c.send(text, (f) =>
      f.search.resolvePlaceName.mockImplementation(async (name) => lookup(name)),
    );
    expect(next.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
    expect(next.view.cards.map((card) => card.placeId)).toEqual([FIXTURE_A]);
  });
});

describe('GoGo-BE#875 question to resolved group', () => {
  it('The Workshop Coffee ở đâu? offers only the two exact cards despite fuzzy overflow', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    for (const id of [FIXTURE_A, FIXTURE_B])
      c.places.set(id, fictionalPlace(id, 'The Workshop Coffee'));
    const result = await c.send('The Workshop Coffee ở đâu?', (f) =>
      f.search.resolvePlaceName.mockImplementation(async (span) => {
        expect(span).toBe('The Workshop Coffee');
        return resolvePlaceNameOutcome({
          candidates: [
            ...[FIXTURE_A, FIXTURE_B].map((id) => ({ id, score: 1, exact: true })),
            ...Array.from({ length: 9 }, (_, i) => ({
              id: `coffee-${i}`,
              score: 0.6,
              exact: false,
            })),
          ],
          overflow: true,
          areaMismatch: false,
        });
      }),
    );
    expect(result.qa).toMatchObject({ outcome: 'choice', topic: 'address' });
    expect(result.f.state.trace.placeQa).toMatchObject({ row: 4 });
    expect(result.view.cards.map((card) => card.placeId).sort()).toEqual(
      [FIXTURE_A, FIXTURE_B].sort(),
    );
    expect(result.view.followUps[0]!.field).toBe('place_choice');
  });
  it.each([
    ['Mizu – Bến Sương mở cửa mấy giờ?', 'Mizu – Bến Sương', 'mizu - ben suong', 'hours'],
    [
      'Giá vé Rạp Sao Mộc Bến Sương bao nhiêu?',
      'Rạp Sao Mộc Bến Sương',
      'rap sao moc ben suong',
      'price',
    ],
  ])('%s answers the exact venue despite fuzzy siblings', async (question, name, key, topic) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    c.places.set(FIXTURE_A, {
      ...fictionalPlace(FIXTURE_A, name),
      areaLabel: 'Phường Cầu Giấy, Hà Nội',
    });
    const result = await c.send(question, (f) =>
      f.search.resolvePlaceName.mockImplementation(async (span) =>
        resolvePlaceNameOutcome({
          candidates: [
            { id: FIXTURE_A, score: 0.8, exact: placeNameVariants(span).includes(key) },
            { id: FIXTURE_B, score: 0.6, exact: false },
          ],
          overflow: false,
          areaMismatch: false,
        }),
      ),
    );
    expect(result.qa).toMatchObject({ outcome: 'answer', topic });
    expect(result.view.cards.map((card) => card.placeId)).toEqual([FIXTURE_A]);
  });
});

describe('GoGo-BE#876 continuation exact precedence', () => {
  for (const mode of ['pending', 'recovery'] as const) {
    it.each([1, 2, 3, 4, 8])(
      `${mode}: %i exact candidates win over fuzzy overflow`,
      async (count) => {
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const c = qaConversation();
        const first = await c.send(mode === 'pending' ? 'Giờ mở cửa' : 'Song Ngọc ở đâu?', (f) =>
          f.search.resolvePlaceName.mockResolvedValue(exact(FIXTURE_A)),
        );
        expect(first.qa).toMatchObject({
          outcome: mode === 'pending' ? 'clarify_referent' : 'answer',
        });
        const ids = Array.from(
          { length: count },
          (_, i) => `87600000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        );
        for (const id of ids) c.places.set(id, fictionalPlace(id, 'Rạp Sao Mộc'));
        const result = await c.send('Rạp Sao Mộc', (f) =>
          f.search.resolvePlaceName.mockResolvedValue(
            resolvePlaceNameOutcome({
              candidates: [
                ...ids.map((id) => ({ id, exact: true, score: 1 })),
                ...Array.from({ length: 9 }, (_, i) => ({
                  id: `fuzzy-${i}`,
                  exact: false,
                  score: 0.6,
                })),
              ],
              overflow: count <= 3,
              areaMismatch: false,
            }),
          ),
        );
        const outcome = count === 1 ? 'answer' : count <= 3 ? 'choice' : 'narrow';
        expect(result.qa).toMatchObject({
          outcome,
          topic: mode === 'pending' ? 'hours' : 'overview',
        });
        expect(result.f.state.trace.placeQa).toMatchObject({
          row: count === 1 ? 3 : count <= 3 ? 4 : 2,
        });
        expect(result.view.cards.map((card) => card.placeId)).toEqual(count <= 3 ? ids : []);
        if (count > 1)
          expect(result.qa!.pending).toMatchObject({
            kind: outcome,
            questionMessageId: mode === 'pending' ? first.userId : result.userId,
          });
        if (count <= 3 && count > 1) expect(result.qa!.pending!.slots[0].candidateIds).toEqual(ids);
      },
    );
  }
});

describe('GoGo-BE#876 bare venue-name answers', () => {
  it.each(['Rạp Bao Nhiêu', 'Rạp Là Bao Nhiêu', 'Rạp Vé Bao Nhiêu', 'Rạp Vé'])(
    '%s uses whole-name equality and overview',
    async (name) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const c = qaConversation();
      c.places.set(FIXTURE_A, fictionalPlace(FIXTURE_A, name));
      const result = await c.send(name, (f) =>
        f.search.resolvePlaceName.mockImplementation(async (span) => {
          expect(span).toBe(name);
          return exact(FIXTURE_A);
        }),
      );
      expect(result.qa).toMatchObject({ outcome: 'answer', topic: 'overview' });
      expect(result.view.cards.map((card) => card.placeId)).toEqual([FIXTURE_A]);
    },
  );
});

describe('GoGo-BE#877 typed choice continuation', () => {
  function duplicateBranches(c: ReturnType<typeof qaConversation>, address = true) {
    for (const [i, id] of [FIXTURE_A, FIXTURE_B].entries()) {
      const name = 'The Workshop Coffee';
      c.places.set(id, {
        ...fictionalPlace(id, name),
        areaLabel: 'Phường Ba Đình, Hà Nội',
        hasIdentityCollision: true,
        card: {
          kind: 'place',
          placeId: id,
          available: true,
          facts: { name, ...(address ? { addressText: `${i ? 27 : 12} Đường Mây` } : {}) },
        },
      });
    }
  }
  it('retains the original topic and confirms only the addressed branch, without ids', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    duplicateBranches(c);
    const first = await c.send('The Workshop Coffee giá bao nhiêu?');
    expect(first.view.followUps[0]!.options[1]!.text).toBe('The Workshop Coffee · 27 Đường Mây');
    const confirm = await c.send(first.view.followUps[0]!.options[1]!.text);
    expect(confirm.qa).toMatchObject({ outcome: 'confirm', topic: 'price' });
    expect(confirm.qa!.pending!.slots[0].candidateIds).toEqual([FIXTURE_B]);
    expect(confirm.view.followUps[0]!.options[0]!.text).toContain('27 Đường Mây');
    const answer = await c.send(confirm.view.followUps[0]!.options[0]!.text);
    expect(answer.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
    expect(answer.f.state.trace.placeAnswerGroup).toMatchObject({ cards: [FIXTURE_B] });
  });
  it.each([true, false])(
    'a duplicate bare name re-asks with both branches (address=%s)',
    async (address) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const c = qaConversation();
      duplicateBranches(c, address);
      await c.send('The Workshop Coffee giá bao nhiêu?');
      const again = await c.send('The Workshop Coffee');
      expect(again.qa).toMatchObject({ outcome: 'choice', topic: 'price' });
      expect(again.f.state.trace.placeAnswerGroup).toMatchObject({ cards: [FIXTURE_A, FIXTURE_B] });
      expect(again.view.text).not.toContain('VND');
    },
  );
  it('same-name branches with no address never authorize an ambiguous text confirmation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    duplicateBranches(c, false);
    await c.send('The Workshop Coffee giá bao nhiêu?');
    const confirm = await c.send('1');
    const again = await c.send(confirm.view.followUps[0]!.options[0]!.text);
    expect(again.qa?.outcome).not.toBe('answer');
    expect(again.view.text).not.toContain('VND');
  });
  it('a stale ordinal retains branch B when both choice texts have the same area discriminator', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    duplicateBranches(c, false);
    const choice = await c.send('The Workshop Coffee giá bao nhiêu?');
    expect(choice.view.followUps[0]!.options.slice(0, 2).map((o) => o.text)).toEqual([
      'The Workshop Coffee · Phường Ba Đình, Hà Nội',
      'The Workshop Coffee · Phường Ba Đình, Hà Nội',
    ]);
    const confirmB = await c.send('2');
    expect(confirmB.qa!.pending!.slots[0].candidateIds).toEqual([FIXTURE_B]);
    const stale = await c.send('1');
    expect(stale.qa).toMatchObject({ outcome: 'confirm' });
    expect(stale.qa!.pending!.slots[0].candidateIds).toEqual([FIXTURE_B]);
    expect(stale.view.text).not.toContain('VND');
    const ambiguous = await c.send(stale.view.followUps[0]!.options[0]!.text);
    expect(ambiguous.qa?.outcome).not.toBe('answer');
    expect(ambiguous.view.text).not.toContain('VND');
  });
  it('oversized addressed identities keep valid chip text and remain ambiguous without ids', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    duplicateBranches(c);
    for (const [i, id] of [FIXTURE_A, FIXTURE_B].entries()) {
      const p = c.places.get(id)!;
      c.places.set(id, {
        ...p,
        card: {
          ...p.card!,
          facts: { name: p.name, addressText: `${i + 1} ${'Đường Mây '.repeat(30)}` },
        },
      });
    }
    const first = await c.send('The Workshop Coffee giá bao nhiêu?');
    for (const option of first.view.followUps[0]!.options) {
      expect(option.text.length).toBeLessThanOrEqual(200);
      expect(Array.from(option.label).length).toBeLessThanOrEqual(40);
    }
    const again = await c.send(first.view.followUps[0]!.options[0]!.text);
    expect(again.qa).toMatchObject({ outcome: 'choice', topic: 'price' });
  });
  it('id pair selects the source-bound option even when its name text is duplicated', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = qaConversation();
    duplicateBranches(c, false);
    const first = await c.send('The Workshop Coffee giá bao nhiêu?');
    const selected = await c.send(first.view.followUps[0]!.options[0]!.text, (f) => {
      f.input.replyToMessageId = first.assistantId;
      f.input.followUpOptionId = first.view.followUps[0]!.options[1]!.id;
    });
    expect(selected.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
    expect(selected.f.state.trace.placeAnswerGroup).toMatchObject({ cards: [FIXTURE_B] });
  });
});
