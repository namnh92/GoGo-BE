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
describe('S4 review round 1 (Opus + Fable advisor, Astra decisions 2026-11-12)', () => {
  const currentArea = {
    kind: 'resolved',
    value: { area: { datasetVersion: 'fixture', provinceCode: '01', communeCode: '00001' } },
  };
  const exactOutcome = (...ids: string[]) =>
    resolvePlaceNameOutcome({
      candidates: ids.map((id) => ({ id, exact: true, score: 1 })),
      overflow: false,
      areaMismatch: false,
    });
  const age = (r: { state: { trace: any } }) => {
    const p = r.state.trace.placeQa.pending;
    const ttl = Date.parse(p.expiresAt) - Date.parse(p.createdAt);
    p.createdAt = new Date(now - ttl).toISOString();
    p.expiresAt = new Date(now).toISOString();
  };
  it('F-01: area refinement of a reply-sourced compare slot keeps the partner', async () => {
    const f = fixture();
    const q = await f.send('Fictional Lantern với Zzz Không Có quán nào rẻ hơn?');
    expect(q.qa.pending).toMatchObject({ slots: [{ resolvedPlaceId: A }, {}] });
    const named = await f.send('Fictional Orchid');
    expect(named.view.cards.map((c) => c.placeId)).toEqual([B, C]);
    f.areas.resolve.mockResolvedValue(currentArea as never);
    f.search.resolvePlaceName.mockResolvedValueOnce(exactOutcome(C) as never);
    const refined = await f.send('Phường Một, Hà Nội');
    expect(refined.qa.topic).toBe('price');
    expect(refined.view.cards.map((c) => c.placeId)).toEqual([A, C]);
  });
  it('F-02: ordinal over a valid choice confirms that card with the new topic', async () => {
    const f = fixture();
    const choice = await f.send('Fictional Orchid giá bao nhiêu?');
    expect(choice.qa.outcome).toBe('choice');
    const r = await f.send('Quán thứ 2 có wifi không?');
    expect(r.qa.outcome).toBe('confirm');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([C]);
    expect(r.qa.pending).toMatchObject({
      kind: 'confirm',
      topic: 'amenity',
      slots: [{ candidateIds: [C] }],
      expiresAt: choice.qa.pending.expiresAt,
    });
  });
  it('F-02: a non-ordinal referent over a valid choice re-asks the same candidates', async () => {
    const f = fixture();
    await f.send('Fictional Orchid giá bao nhiêu?');
    const r = await f.send('Có wifi không?');
    expect(r.qa.outcome).toBe('choice');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([B, C]);
    expect(r.qa.pending).toMatchObject({ kind: 'choice', topic: 'amenity' });
  });
  it('F-02: compare partner survives an ordinal over the slot-2 choice; confirmation answers both', async () => {
    const f = fixture();
    const q = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
    const r = await f.send('Quán thứ 2 có wifi không?');
    expect(r.qa.pending).toMatchObject({
      kind: 'confirm',
      topic: 'amenity',
      activeSlot: 1,
      slots: [{ resolvedPlaceId: A }, { candidateIds: [C] }],
      expiresAt: q.qa.pending.expiresAt,
    });
    const done = await f.send('1', {
      replyToMessageId: r.id,
      followUpOptionId: r.view.followUps[0]!.options[0]!.id,
    });
    expect(done.qa.topic).toBe('amenity');
    expect(done.view.cards.map((c) => c.placeId)).toEqual([A, C]);
  });
  it('F-02: an expired clarification seeds a fresh confirm without the partner', async () => {
    const f = fixture();
    const q = await f.send('Fictional Lantern với Fictional Orchid quán nào rẻ hơn?');
    age(q);
    const r = await f.send('Quán thứ 2 có wifi không?');
    expect(r.qa.outcome).toBe('confirm');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([C]);
    expect(r.qa.pending.slots).toHaveLength(1);
    expect(r.qa.pending.expiresAt).not.toBe(q.qa.pending.expiresAt);
  });
  it('F-02: an out-of-range ordinal over clarification cards re-asks without cards', async () => {
    const f = fixture();
    await f.send('Fictional Orchid giá bao nhiêu?');
    const r = await f.send('Quán thứ 3 có wifi không?');
    expect(r.qa.outcome).toBe('clarify_referent');
    expect(r.view.cards).toEqual([]);
  });
  it.each(['Quán 2', 'Quán 3 Miền'])(
    'M-01: an exact venue named %s wins over the ordinal reading',
    async (name) => {
      const f = fixture();
      f.update(A, { name });
      await f.send('Fictional Orchid giá bao nhiêu?');
      const r = await f.send(`${name} giá bao nhiêu?`);
      expect(r.qa.outcome).toBe('answer');
      expect(r.view.cards.map((c) => c.placeId)).toEqual([A]);
    },
  );
  it('M-02: "Quán thứ 2" picks card 2 and today, never a Monday', async () => {
    const f = fixture();
    f.places.delete(C);
    const cards = await f.send('So sánh Fictional Lantern với Fictional Orchid');
    expect(cards.view.cards.map((c) => c.placeId)).toEqual([A, B]);
    const r = await f.send('Quán thứ 2 mở cửa mấy giờ?');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([B]);
    expect(r.qa.args).toMatchObject({ day: 'date', date: '2026-11-11' });
  });
  it('F-03: an hours chip selected after local midnight answers for the new day', async () => {
    const f = fixture();
    const before = Date.parse('2026-11-11T16:50:00Z'); // 23:50 Asia/Ho_Chi_Minh
    vi.spyOn(Date, 'now').mockReturnValue(before);
    const r = await f.send('Fictional Lantern giá bao nhiêu?');
    const hours = r.view.followUps.flatMap((g) => g.options).find((o) => /giờ/iu.test(o.label));
    expect(hours).toBeDefined();
    vi.spyOn(Date, 'now').mockReturnValue(before + 15 * 60_000); // 00:05 next day
    const chosen = await f.send(hours!.text, {
      replyToMessageId: r.id,
      followUpOptionId: hours!.id,
    });
    expect(chosen.qa.topic).toBe('hours');
    expect(chosen.qa.args).toMatchObject({ day: 'date', date: '2026-11-12' });
  });
  it('M-04: a compared venue named with a topic word does not pick the compare topic', async () => {
    const f = fixture();
    f.places.delete(C);
    f.update(B, { name: 'Cafe Đánh Giá' });
    const r = await f.send('So sánh Cafe Đánh Giá với Fictional Lantern');
    expect(r.qa.topic).toBe('overview');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([B, A]);
  });
  it('M-03: a duplicate compare unresolves the active slot for a later refinement', async () => {
    const f = fixture();
    const r = await f.send('Fictional Lantern với Fictional Lantern quán nào rẻ hơn?');
    expect(r.qa.outcome).toBe('clarify_referent');
    expect(r.qa.pending.slots[0].resolvedPlaceId).toBe(A);
    expect(r.qa.pending.slots[1].resolvedPlaceId).toBeUndefined();
  });
});
describe('S4 review round 2 (confirm round F-04/F-05)', () => {
  const currentArea = {
    kind: 'resolved',
    value: { area: { datasetVersion: 'fixture', provinceCode: '01', communeCode: '00001' } },
  };
  it.each(['Quán này giá bao nhiêu?', 'giá bao nhiêu?'])(
    'F-02 main row: a valid singleton confirm then "%s" confirms again, never answers',
    async (text) => {
      const f = fixture();
      await f.send('Fictional Orchid có wifi không?');
      const confirm = await f.send('1');
      expect(confirm.qa.outcome).toBe('confirm');
      expect(confirm.view.cards.map((c) => c.placeId)).toEqual([B]);
      const r = await f.send(text);
      expect(r.qa.outcome).toBe('confirm');
      expect(r.view.cards.map((c) => c.placeId)).toEqual([B]);
      expect(r.qa.pending).toMatchObject({ kind: 'confirm', topic: 'price' });
    },
  );
  it('F-02 legacy row: a legacy-district singleton confirm keeps the legacy gate', async () => {
    const f = fixture();
    const q = await f.send('Fictional Lantern ở Quận 1 có wifi không?');
    expect(q.qa.outcome).toBe('confirm');
    expect(q.state.trace.placeAnswerGroup).toMatchObject({ legacyArea: true });
    const r = await f.send('giá bao nhiêu?');
    expect(r.qa.outcome).toBe('confirm');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([A]);
    expect(r.state.trace.placeAnswerGroup).toMatchObject({ legacyArea: true });
  });
  it('an unavailable referenced clarification card re-asks without cards', async () => {
    const f = fixture();
    await f.send('Fictional Orchid giá bao nhiêu?');
    f.update(C, { available: false });
    const r = await f.send('Quán thứ 2 có wifi không?');
    expect(r.qa.outcome).toBe('clarify_referent');
    expect(r.view.cards).toEqual([]);
  });
  it('F-04: a broken pending lineage recovers no candidates', async () => {
    const f = fixture();
    const q = await f.send('Fictional Orchid giá bao nhiêu?');
    f.users.delete(q.userId);
    const r = await f.send('Quán thứ 2 có wifi không?');
    expect(r.qa.outcome).toBe('clarify_referent');
    expect(r.view.cards).toEqual([]);
  });
  it('F-04: a reply-sourced single-slot name stays bound through the ordinal confirm', async () => {
    const f = fixture();
    const asked = await f.send('giá bao nhiêu?');
    expect(asked.qa.outcome).toBe('clarify_referent');
    const named = await f.send('Fictional Orchid');
    expect(named.view.cards.map((c) => c.placeId)).toEqual([B, C]);
    expect(named.qa.pending).toMatchObject({
      questionMessageId: asked.userId,
      slots: [{ sourceMessageId: named.userId }],
    });
    const r = await f.send('Quán thứ 2 có wifi không?');
    expect(r.qa.pending.slots[0].sourceMessageId).toBe(named.userId);
    f.areas.resolve.mockResolvedValue(currentArea as never);
    f.search.resolvePlaceName.mockClear();
    await f.send('Phường Một, Hà Nội');
    expect(f.search.resolvePlaceName).toHaveBeenCalledWith('Fictional Orchid', expect.anything());
  });
  it('M-01: an exact family named like an ordinal gives a choice, never card 2', async () => {
    const f = fixture();
    f.update(B, { name: 'Quán 2' });
    f.update(C, { name: 'Quán 2' });
    f.places.delete(A);
    const r = await f.send('Quán 2 giá bao nhiêu?');
    expect(r.qa.outcome).toBe('choice');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([B, C]);
  });
  it('M-01: an exact name with a legacy area confirms instead of answering', async () => {
    const f = fixture();
    f.update(A, { name: 'Quán thứ 2' });
    const r = await f.send('Quán thứ 2 ở Quận 1 giá bao nhiêu?');
    expect(r.qa.outcome).toBe('confirm');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([A]);
  });
  it.each([
    ['Quán thứ 2 vào thứ 3 mở cửa mấy giờ?', B, { day: 'weekday', d: 2 }],
    ['Quán thứ 2 mở cửa mấy giờ?', B, { day: 'date', date: '2026-11-11' }],
  ] as const)('M-02: "%s" over ordinary cards', async (text, id, args) => {
    const f = fixture();
    f.places.delete(C);
    await f.send('So sánh Fictional Lantern với Fictional Orchid');
    const r = await f.send(text);
    // A direct answer for card N (no_data when the fixture lacks that day).
    expect(['answer', 'no_data']).toContain(r.qa.outcome);
    expect(r.view.cards.map((c) => c.placeId)).toEqual([id]);
    expect(r.qa.args).toMatchObject(args);
  });
  it('M-02: "Quán này thứ 2" over a sole card asks Monday', async () => {
    const f = fixture();
    await f.send('Fictional Lantern giá bao nhiêu?');
    const r = await f.send('Quán này thứ 2 mở cửa mấy giờ?');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([A]);
    expect(r.qa.args).toMatchObject({ day: 'weekday', d: 1 });
  });
  it('M-02: "Quán thứ 2 mở cửa" over clarification cards confirms card 2 for today', async () => {
    const f = fixture();
    await f.send('Fictional Orchid giá bao nhiêu?');
    const r = await f.send('Quán thứ 2 mở cửa mấy giờ?');
    expect(r.qa.outcome).toBe('confirm');
    expect(r.view.cards.map((c) => c.placeId)).toEqual([C]);
    expect(r.qa.pending).toMatchObject({
      topic: 'hours',
      args: { day: 'date', date: '2026-11-11' },
    });
  });
});
