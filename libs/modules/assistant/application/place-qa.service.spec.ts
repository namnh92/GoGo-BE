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
