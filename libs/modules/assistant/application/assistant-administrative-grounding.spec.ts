import { describe, expect, it, vi } from 'vitest';
import { AssistantAreaResolver } from './area-resolver.service';
import { v5Query } from './area.fixture';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { newTurnState } from './turn-state';
import type { GroundedAnswerContext } from '../domain/grounding';
import { placeToken } from '../domain/place-tokens';

const PLACE = '11111111-1111-4111-8111-111111111111';
const ctx: GroundedAnswerContext = {
  route: 'recommend_places',
  locale: 'vi',
  constraints: [],
  preferences: { moods: [], settings: [], occasion: null },
  places: [
    { position: 1, placeId: PLACE, name: "Pizza 4P's Bến Thành", categories: [], moods: [] },
  ],
  guide: [],
  plan: null,
  pendingAction: null,
  clarification: [],
  unverifiableRequirement: false,
  conflicting: false,
};

async function compose(areas: AssistantAreaResolver, timeout = 1000) {
  const stream = vi.fn(async function* () {
    yield { type: 'delta', text: '[P1] nằm gần khu Bến Thành' };
    yield { type: 'done', finishReason: 'stop' };
  });
  const stub = {} as never;
  const orchestrator = new AssistantOrchestrator(
    { ASSISTANT_MAX_OUTPUT_TOKENS: 100 } as never,
    stub,
    stub,
    stub,
    stub,
    areas,
    stub,
    stub,
    null,
    { model: 'test', stream } as never,
  );
  const state = newTurnState();
  const chunks: string[] = [];
  const outcome = await orchestrator['compose'](
    {
      messageId: 'm',
      ledgerId: 'l',
      conversationId: 'c',
      userId: 'u',
      text: 'gợi ý',
      locale: 'vi',
      context: null,
    },
    ctx,
    [],
    state,
    {
      emit: async (frame) => {
        if (frame.type === 'delta') {
          chunks.push(frame.text);
          state.textStarted = true;
        }
      },
    },
    new AbortController().signal,
    Date.now() + timeout,
  );
  return { outcome, text: chunks.join(''), stream, state };
}

describe('#854 published administrative vocabulary in composition', () => {
  it('wires the published snapshot vocabulary into the production sanitizer', async () => {
    const result = await compose(new AssistantAreaResolver(v5Query() as never));
    expect(result.outcome).toEqual({ kind: 'ok' });
    expect(result.text).toBe(`${placeToken(PLACE)} nằm gần khu Bến Thành`);
    expect(result.stream).toHaveBeenCalledOnce();
  });

  it('uses deterministic fallback without a model call if the dataset is unavailable', async () => {
    const areas = new AssistantAreaResolver({
      snapshot: async () => {
        throw new Error('unavailable');
      },
    } as never);
    const result = await compose(areas);
    expect(result.outcome).toEqual({ kind: 'fallback', reason: 'provider_unavailable' });
    expect(result.stream).not.toHaveBeenCalled();
    expect(result.state.costs.haikuCalls).toBe(0);
  });

  it('bounds a stalled dataset read by the first-text deadline without a paid call', async () => {
    const areas = new AssistantAreaResolver({
      snapshot: () => new Promise(() => undefined),
    } as never);
    const result = await compose(areas, 30);
    expect(result.outcome).toEqual({ kind: 'fallback', reason: 'timeout' });
    expect(result.stream).not.toHaveBeenCalled();
    expect(result.state.costs.haikuCalls).toBe(0);
  });

  it('caches by immutable snapshot identity and refreshes on publication', async () => {
    const snapshot = await v5Query().snapshot();
    const query = { snapshot: vi.fn().mockResolvedValue(snapshot) };
    const areas = new AssistantAreaResolver(query as never);
    const first = await areas.administrativeNames();
    expect(first.has('ben thanh')).toBe(true);
    expect(first.has('phuong ben thanh')).toBe(true);
    expect(first.has('thu duc')).toBe(true);
    expect(await areas.administrativeNames()).toBe(first);
    const next = {
      ...snapshot,
      currentSearch: snapshot.currentSearch.filter(({ unit }) => unit.name !== 'Bến Thành'),
    };
    query.snapshot.mockResolvedValue(next);
    const refreshed = await areas.administrativeNames();
    expect(refreshed).not.toBe(first);
    expect(refreshed.has('ben thanh')).toBe(false);
  });
});
