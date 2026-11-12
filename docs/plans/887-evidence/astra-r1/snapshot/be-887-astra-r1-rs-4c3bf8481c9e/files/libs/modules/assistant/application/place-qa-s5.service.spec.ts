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
import type { PlaceFacts } from '../domain/place-qa/place-facts';
import type { TurnInput } from './assistant-orchestrator.service';
const now = Date.parse('2026-11-11T10:00:00Z');
afterEach(() => vi.restoreAllMocks());
function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const places = new Map([
    [A, fictionalPlace(A, 'Tiệm Bánh An Nhiên')],
    [B, fictionalPlace(B, 'Cà Phê Nhà Bên Hồ')],
    [C, fictionalPlace(C, 'Trà Nhà Mộc')],
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
  const aliases = new Map<string, string[]>([['Lakeside Coffee', [B]]]);
  const search = {
    resolvePlaceName: vi.fn(async (name: string, options?: any) =>
      resolvePlaceNameOutcome(
        {
          candidates: [...places.values()]
            .filter(
              (p) =>
                p.name === name ||
                aliases.get(name)?.includes(p.id) ||
                (name === 'Lakeside Coffe' && p.id === B),
            )
            .map((p) => ({
              id: p.id,
              exact: name !== 'Lakeside Coffe',
              score: name === 'Lakeside Coffe' ? 0.9 : 1,
            })),
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
    aliases,
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
describe('S5 pending aliases (#887 Astra F-01)', () => {
  it.each([
    'Lakeside Coffe ở đâu?',
    'Lakeside Coffe mở cửa ngày mai?',
    'Tiệm Bánh An Nhiên với Lakeside Coffe quán nào rẻ hơn?',
  ])('re-asks after a bare alias and retains the original question: %s', async (question) => {
    const f = fixture();
    const first = await f.send(question);
    expect(first.qa.pending.kind).toBe('confirm');
    const reply = await f.send('Lakeside Coffee');
    expect(reply.qa.outcome, 'SYMPTOM: a bare pending alias must re-ask confirmation').toBe(
      'confirm',
    );
    expect(reply.qa.pending).toMatchObject({
      questionMessageId: first.userId,
      topic: first.qa.pending.topic,
      args: first.qa.pending.args,
      slots: first.qa.pending.slots,
      activeSlot: first.qa.pending.activeSlot,
      createdAt: first.qa.pending.createdAt,
      expiresAt: first.qa.pending.expiresAt,
    });
    const done = await f.send(reply.view.followUps[0]!.options[0]!.text);
    expect(done.qa.topic).toBe(first.qa.topic);
    expect(done.qa.args).toEqual(first.qa.args);
    expect(done.view.cards.map((c) => c.placeId)).toEqual(question.includes('với') ? [A, B] : [B]);
    expect(done.state.costs).toMatchObject({ jevCalls: 0, haikuCalls: 0 });
  });
  it('keeps both pending branches for a shared alias', async () => {
    const f = fixture();
    f.update(C, { name: 'Cà Phê Nhà Bên Hồ' });
    f.aliases.set('Lakeside Coffee', [B, C]);
    const first = await f.send('Cà Phê Nhà Bên Hồ ở đâu?');
    expect(first.qa.pending.kind).toBe('choice');
    const reply = await f.send('Lakeside Coffee');
    expect(reply.qa.outcome).toBe('choice');
    expect(reply.qa.pending.questionMessageId).toBe(first.userId);
    expect(reply.qa.pending.topic).toBe('address');
    expect(reply.view.cards.map((c) => c.placeId)).toEqual([B, C]);
  });
  it('still treats an unrelated exact alias as a fresh name', async () => {
    const f = fixture();
    await f.send('Lakeside Coffe ở đâu?');
    f.aliases.set('AN Bakery', [A]);
    const reply = await f.send('AN Bakery');
    expect(reply.qa.topic).toBe('overview');
    expect(reply.view.cards.map((c) => c.placeId)).toEqual([A]);
  });
});
