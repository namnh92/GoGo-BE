import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaceQaService } from './place-qa.service';
import { PlaceAnswerReader } from './place-answer-reader';
import { applyFrame, newTurnState } from './turn-state';
import {
  FIXTURE_A as A,
  FIXTURE_B as B,
  FIXTURE_C as C,
  fictionalPlace,
} from '../domain/place-qa/fixtures';
import { resolvePlaceNameOutcome } from '../domain/place-qa/resolution';
import { PlaceQaClassifier } from '../domain/place-qa/classifier';
import { readQaPending } from '../domain/place-qa/pending';
import { parseReferenceGroup } from '../domain/place-qa/reference-group';
import type { PlaceFacts } from '../domain/place-qa/place-facts';
import type { TurnInput } from './assistant-orchestrator.service';
const now = Date.parse('2026-11-11T10:00:00Z');
afterEach(() => vi.restoreAllMocks());
function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const places = new Map([
    [A, fictionalPlace(A, 'Fictional Lantern')],
    [B, fictionalPlace(B, 'Fictional Orchid')],
    [C, fictionalPlace(C, 'Fictional Orchid')],
  ]);
  for (const p of places.values())
    places.set(p.id, { ...p, areaLabel: `Ward ${p.id[0]}, Province` });
  const update = (id: string, patch: Partial<PlaceFacts>) =>
    places.set(id, { ...places.get(id)!, ...patch });
  const users = new Map<string, any>();
  let latest: any = null;
  let currentQuestion = '';
  let enabled = true;
  const repo = {
    markPlaceQa: vi.fn(async () => currentQuestion),
    persistQaEnabled: vi.fn(async () => true),
    latestAssistant: vi.fn(async () => latest),
    findMessage: vi.fn(
      async (_user: string, _conversation: string, id: string) => users.get(id) ?? null,
    ),
  };
  const search = {
    resolvePlaceName: vi.fn(async (name: string, options?: any) =>
      resolvePlaceNameOutcome(
        {
          candidates: [...places.values()]
            .filter((p) => p.name === name)
            .map((p) => ({ id: p.id, exact: true, score: 1 })),
          overflow: false,
          areaMismatch: false,
        },
        options,
      ),
    ),
    placeFacts: vi.fn(async () => ({ places })),
  };
  const areas = { resolve: vi.fn(async () => ({ kind: 'none' })) };
  const service = new PlaceQaService(
    repo as never,
    search as never,
    areas as never,
    { placeQaEnabled: async () => enabled } as never,
  );
  const send = async (text: string, extra: Partial<TurnInput> = {}) => {
    const userId = randomUUID();
    const id = randomUUID();
    currentQuestion = userId;
    users.set(userId, { id: userId, role: 'user', text, locale: 'vi' });
    const state = newTurnState();
    const handled = await service.handle(
      {
        userId: 'u',
        conversationId: 'c',
        messageId: id,
        ledgerId: 'l',
        context: null,
        locale: 'vi',
        text,
        ...extra,
      },
      state,
      {
        emit: async (f) => {
          applyFrame(state, { ...f, messageId: id, seq: 1 } as never);
        },
      },
      new AbortController().signal,
      Date.now() + 15_000,
    );
    const view = (
      await new PlaceAnswerReader({ placeFacts: async () => ({ places }) }).page(
        [{ id, text: state.text, trace: state.trace, locale: 'vi' }],
        'history',
      )
    ).get(id)!;
    latest = {
      id,
      role: 'assistant',
      status: 'complete',
      locale: 'vi',
      trace: state.trace,
      cards: state.cards,
    };
    users.set(id, latest);
    return { handled, state, view, qa: state.trace.placeQa as any, id, userId };
  };
  return {
    send,
    update,
    search,
    places,
    users,
    repo,
    areas,
    latest: (value: any) => {
      latest = value;
    },
    flag: (value: boolean) => {
      enabled = value;
    },
  };
}
describe('S4 comparison and two-slot clarification', () => {
  it('renders distinct places with independent price policy and reference-only persistence', async () => {
    const f = fixture();
    f.places.delete(C);
    f.update(B, { facts: { ...f.places.get(B)!.facts, price: [] } });
    const r = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
    expect(r.view.text).toContain('Fictional Lantern: 12.000–24.000 VND/người');
    expect(r.view.text).toContain('Fictional Orchid: GoGo chưa có giá đã xác minh');
    expect(r.view.text).not.toMatch(/rẻ hơn|tốt hơn/);
    expect(r.state.cards).toEqual([
      { kind: 'place', placeId: A },
      { kind: 'place', placeId: B },
    ]);
    expect(parseReferenceGroup(r.state.trace.placeAnswerGroup, r.state.text)?.kind).toBe('compare');
    expect(JSON.stringify([r.state.text, r.state.trace])).not.toMatch(
      /Fictional|(?<![0-9a-fA-F:.-])12[.,]?000(?![0-9a-fA-FZ])|Ward/,
    );
    expect(r.state.costs).toMatchObject({ jevCalls: 0, haikuCalls: 0, jevCostUsd: 0 });
  });
  it.each(['structured', 'typed'])(
    'retains first resolved slot and topic through %s confirmation',
    async (mode) => {
      const f = fixture();
      const r = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
      expect(r.qa.pending).toMatchObject({
        activeSlot: 1,
        topic: 'price',
        slots: [{ resolvedPlaceId: A }, { candidateIds: [B, C] }],
      });
      expect(r.view.cards.map((c) => c.placeId)).toEqual([B, C]);
      let done;
      if (mode === 'structured')
        done = await f.send('1', {
          replyToMessageId: r.id,
          followUpOptionId: r.view.followUps[0]!.options[0]!.id,
        });
      else {
        const confirm = await f.send('1');
        expect(confirm.qa.pending.slots[0].resolvedPlaceId).toBe(A);
        expect(confirm.qa.pending.expiresAt).toBe(r.qa.pending.expiresAt);
        done = await f.send(confirm.view.followUps[0]!.options[0]!.text);
      }
      expect(done.qa.topic).toBe('price');
      expect(done.view.cards.map((c) => c.placeId)).toEqual([A, B]);
    },
  );
  it('slot 2 typed emitted choice text confirms only that branch and keeps slot 1', async () => {
    const f = fixture();
    const r = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
    const option = r.view.followUps[0]!.options[1]!;
    const typed = await f.send(option.text);
    expect(typed.qa.pending).toMatchObject({
      kind: 'confirm',
      activeSlot: 1,
      topic: 'price',
      slots: [{ resolvedPlaceId: A }, { candidateIds: [C] }],
    });
    const done = await f.send(typed.view.followUps[0]!.options[0]!.text);
    expect(done.view.cards.map((c) => c.placeId)).toEqual([A, C]);
  });
  it.each(['Quán 2'])(
    'slot 2 venues named %s re-ask the whole choice instead of guessing',
    async (name) => {
      const f = fixture();
      f.update(B, { name });
      f.update(C, { name });
      const r = await f.send(`Fictional Lantern với ${name} quán nào rẻ hơn?`);
      expect(r.qa.pending).toMatchObject({
        activeSlot: 1,
        slots: [{ resolvedPlaceId: A }, { candidateIds: [B, C] }],
      });
      const typed = await f.send(name);
      expect(typed.qa.outcome).not.toBe('stale_choice');
      expect(typed.qa.pending).toMatchObject({
        kind: 'choice',
        activeSlot: 1,
        slots: [{ resolvedPlaceId: A }, { candidateIds: [B, C] }],
      });
      expect(typed.view.cards.map((c) => c.placeId)).toEqual([B, C]);
    },
  );
  it('a topic label typed during a slot 2 choice never selects a branch', async () => {
    const f = fixture();
    const r = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
    const typed = await f.send('Giờ mở cửa');
    expect(typed.view.cards.map((c) => c.placeId)).not.toEqual([A, B]);
    expect(typed.view.cards.map((c) => c.placeId)).not.toEqual([A, C]);
    expect(typed.qa.pending).toMatchObject({
      activeSlot: 1,
      topic: 'price',
      slots: [{ resolvedPlaceId: A }, { candidateIds: [B, C] }],
      expiresAt: r.qa.pending.expiresAt,
    });
  });
  it('resolves both ambiguous slots separately', async () => {
    const f = fixture();
    f.update(A, { name: 'Fictional Orchid' });
    let r = await f.send('Fictional Orchid với Fictional Orchid quán nào rẻ hơn?');
    expect(r.qa.pending.activeSlot).toBe(0);
    r = await f.send('first', { replyToMessageId: r.id, followUpOptionId: 'pick_1' });
    expect(r.qa.pending).toMatchObject({ activeSlot: 1, slots: [{ resolvedPlaceId: A }, {}] });
    r = await f.send('second', { replyToMessageId: r.id, followUpOptionId: 'pick_2' });
    expect(r.view.cards.map((c) => c.placeId)).toEqual([A, B]);
  });
  it('never emits duplicate cards for the same id', async () => {
    const f = fixture();
    const r = await f.send('Fictional Lantern với Fictional Lantern quán nào rẻ hơn?');
    expect(r.qa.outcome).toBe('clarify_referent');
    expect(r.view.cards).toEqual([]);
  });
  it('a lost original question invalidates both slots', async () => {
    const f = fixture();
    const r = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
    f.users.delete(r.userId);
    f.search.placeFacts.mockClear();
    const stale = await f.send('1', { replyToMessageId: r.id, followUpOptionId: 'pick_1' });
    expect(stale.qa.outcome).toBe('stale_choice');
    expect(f.search.placeFacts).not.toHaveBeenCalled();
  });
});
describe('S4 previous-card referents', () => {
  it('context takes precedence over previous cards and ordinal', async () => {
    const f = fixture();
    f.places.delete(C);
    await f.send('So sánh Fictional Lantern với Fictional Orchid');
    const r = await f.send('Quán thứ 2 giá bao nhiêu?', { context: { kind: 'place', id: A } });
    expect(r.view.cards.map((c) => c.placeId)).toEqual([A]);
  });
  it('uses a sole previous card and scopes latest lookup', async () => {
    const f = fixture();
    await f.send('Thông tin về Fictional Lantern');
    const r = await f.send('Quán này giá bao nhiêu?');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([A]);
    expect(f.repo.latestAssistant).toHaveBeenLastCalledWith('u', 'c', r.id);
  });
  it.each(['Quán thứ 2 giá bao nhiêu?', 'Quán này giá bao nhiêu?'])(
    'handles ordinal or choice: %s',
    async (text) => {
      const f = fixture();
      f.places.delete(C);
      await f.send('So sánh Fictional Lantern với Fictional Orchid');
      const r = await f.send(text);
      expect(r.qa.outcome).toBe(text.includes('thứ') ? 'answer' : 'choice');
      expect(r.view.cards.map((c) => c.placeId)).toEqual(text.includes('thứ') ? [B] : [A, B]);
    },
  );
  it('rechecks accessibility and does not renumber an unavailable ordinal', async () => {
    const f = fixture();
    f.places.delete(C);
    await f.send('So sánh Fictional Lantern với Fictional Orchid');
    f.update(B, { available: false });
    const r = await f.send('Quán thứ 2 giá bao nhiêu?');
    expect(r.qa.outcome).toBe('clarify_referent');
    expect(r.view.cards).toEqual([]);
  });
  it('asks when latest accessible turn has no cards', async () => {
    const f = fixture();
    const r = await f.send('Quán này giá bao nhiêu?');
    expect(r.qa.outcome).toBe('clarify_referent');
  });
});
describe('S4 topic consumers and current policy', () => {
  it.each(['structured', 'typed'])(
    'answers the retained place with %s topic selection',
    async (mode) => {
      const f = fixture();
      const r = await f.send('Fictional Lantern giá bao nhiêu?');
      expect(r.view.followUps).toHaveLength(1);
      expect(r.view.followUps[0]!.field).toBe('place_topic');
      expect(r.view.followUps[0]!.options).toHaveLength(3);
      const o = r.view.followUps[0]!.options.find((o) => o.label === 'Giờ mở cửa')!;
      const next = await f.send(
        o.text,
        mode === 'structured' ? { replyToMessageId: r.id, followUpOptionId: o.id } : {},
      );
      expect(next.qa).toMatchObject({ topic: 'hours', outcome: 'answer' });
      expect(next.view.text).toContain('09:00');
      expect(next.view.cards.map((c) => c.placeId)).toEqual([A]);
      expect(next.qa.pending.expiresAt).toBe(r.qa.pending.expiresAt);
    },
  );
  it('retains both comparison places when selecting a topic', async () => {
    const f = fixture();
    f.places.delete(C);
    const r = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
    const next = await f.send('Địa chỉ');
    expect(next.qa).toMatchObject({ topic: 'address', outcome: 'answer' });
    expect(next.view.cards.map((c) => c.placeId)).toEqual([A, B]);
    expect(next.qa.pending.questionMessageId).toBe(r.userId);
  });
  it.each(['missing', 'unavailable', 'disabled', 'superseded', 'expired', 'source_deleted'])(
    'neutralizes %s topics',
    async (reason) => {
      const f = fixture();
      const r = await f.send('Fictional Lantern giá bao nhiêu?');
      const o = r.view.followUps[0]!.options[0]!;
      if (reason === 'missing') f.update(A, { facts: { ...f.places.get(A)!.facts, hours: [] } });
      if (reason === 'unavailable') f.update(A, { available: false });
      if (reason === 'disabled') f.flag(false);
      if (reason === 'superseded') await f.send('Thông tin về Fictional Lantern');
      if (reason === 'expired') vi.mocked(Date.now).mockReturnValue(now + 30 * 60_000);
      if (reason === 'source_deleted') f.users.delete(r.userId);
      const next = await f.send(o.text, { replyToMessageId: r.id, followUpOptionId: o.id });
      expect(next.qa.outcome).toBe(reason === 'disabled' ? 'disabled' : 'stale_choice');
      expect(next.view.cards).toEqual([]);
    },
  );
  it('topic ambiguity permits one retry without losing the resolved referent or expiry', async () => {
    const f = fixture();
    const original = await f.send('Fictional Lantern giá bao nhiêu?');
    const retry = await f.send('???');
    expect(retry.qa).toMatchObject({
      outcome: 'retry',
      pending: {
        kind: 'topic',
        retryCount: 1,
        expiresAt: original.qa.pending.expiresAt,
        slots: [{ resolvedPlaceId: A }],
      },
    });
    expect(readQaPending(retry.qa.pending, retry.id, now)).not.toBeNull();
    const next = await f.send('Giờ mở cửa');
    expect(next.qa).toMatchObject({ topic: 'hours', outcome: 'answer' });
  });
  it('deleting the previous-card assistant source invalidates a later choice', async () => {
    const f = fixture();
    f.places.delete(C);
    const source = await f.send('So sánh Fictional Lantern với Fictional Orchid');
    const choice = await f.send('Quán này ở đâu?');
    f.users.delete(source.id);
    const next = await f.send('1', { replyToMessageId: choice.id, followUpOptionId: 'pick_1' });
    expect(next.qa.outcome).toBe('stale_choice');
  });
  it('rejects malformed two-slot state', async () => {
    const f = fixture();
    const r = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
    const p = structuredClone(r.qa.pending);
    p.slots[1].slot = 0;
    expect(readQaPending(p, r.id, now)).toBeNull();
  });
});
describe('S4 comparison grammar', () => {
  it.each([
    ['So sánh Fictional Lantern với Fictional Orchid', 'overview'],
    ['Fictional Lantern với Fictional Orchid quán nào rẻ hơn?', 'price'],
    ['Compare Fictional Lantern with Fictional Orchid which is cheaper?', 'price'],
    ['So sánh Fictional Lantern với Fictional Orchid về giờ mở cửa', 'hours'],
  ])('%s', (text, topic) => {
    const c = new PlaceQaClassifier().classify(text, null, {
      now: new Date(now),
      locale: text.startsWith('Compare') ? 'en' : 'vi',
    });
    expect(c).toMatchObject({
      kind: 'compare',
      topic,
      spans: [{ text: 'Fictional Lantern' }, { text: 'Fictional Orchid' }],
    });
  });
});
