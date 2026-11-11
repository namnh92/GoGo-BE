import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoopMetrics } from '@gogo/observability';
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

async function compose(
  areas: AssistantAreaResolver,
  timeout = 1000,
  modelWork: () => Promise<void> = async () => undefined,
) {
  const stream = vi.fn(async function* () {
    await modelWork();
    yield { type: 'delta', text: '[P1] nằm gần khu Bến Thành' };
    yield { type: 'done', finishReason: 'stop' };
  });
  const metrics = new NoopMetrics();
  const observe = vi.spyOn(metrics, 'observe');
  const increment = vi.spyOn(metrics, 'increment');
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
    metrics,
  );
  const warn = vi.spyOn(orchestrator['logger'], 'warn').mockImplementation(() => undefined);
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
  return { outcome, text: chunks.join(''), stream, state, observe, increment, warn };
}

describe('#854 published administrative vocabulary in composition', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('measures only the model attempt after a slow vocabulary preflight', async () => {
    vi.useFakeTimers();
    const areas = new AssistantAreaResolver({
      snapshot: async () => {
        await vi.advanceTimersByTimeAsync(100);
        return v5Query().snapshot();
      },
    } as never);
    const result = await compose(areas, 1000, async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(result.outcome).toEqual({ kind: 'ok' });
    expect(result.observe).toHaveBeenCalledWith('assistant_provider_duration_seconds', 0.025, {
      provider: 'haiku',
      outcome: 'ok',
    });
    expect(result.increment).not.toHaveBeenCalledWith(
      'assistant_vocabulary_preflight_failures_total',
      expect.anything(),
    );
  });

  it('still attributes an attempted model failure to Haiku', async () => {
    const result = await compose(new AssistantAreaResolver(v5Query() as never), 1000, async () => {
      throw new Error('model unavailable');
    });
    expect(result.outcome).toEqual({ kind: 'fallback', reason: 'provider_unavailable' });
    expect(result.state.costs.haikuCalls).toBe(1);
    expect(result.observe).toHaveBeenCalledWith(
      'assistant_provider_duration_seconds',
      expect.any(Number),
      { provider: 'haiku', outcome: 'provider_unavailable' },
    );
    expect(result.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'assistant.haiku_failed' }),
    );
    expect(result.increment).not.toHaveBeenCalled();
  });
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
    expect
      .soft(result.observe)
      .not.toHaveBeenCalledWith(
        'assistant_provider_duration_seconds',
        expect.any(Number),
        expect.objectContaining({ provider: 'haiku' }),
      );
    expect
      .soft(result.warn)
      .not.toHaveBeenCalledWith(expect.objectContaining({ event: 'assistant.haiku_failed' }));
    expect
      .soft(result.increment)
      .toHaveBeenCalledWith('assistant_vocabulary_preflight_failures_total', {
        outcome: 'unavailable',
      });
    expect.soft(result.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'assistant.vocabulary_preflight_failed',
        outcome: 'unavailable',
      }),
    );
    expect(result.text).toBe('');
    expect(result.stream).not.toHaveBeenCalled();
    expect(result.state.costs.haikuCalls).toBe(0);
  });

  it('bounds a stalled dataset read by the first-text deadline without a paid call', async () => {
    const areas = new AssistantAreaResolver({
      snapshot: () => new Promise(() => undefined),
    } as never);
    const result = await compose(areas, 30);
    expect(result.outcome).toEqual({ kind: 'fallback', reason: 'timeout' });
    expect
      .soft(result.observe)
      .not.toHaveBeenCalledWith(
        'assistant_provider_duration_seconds',
        expect.any(Number),
        expect.objectContaining({ provider: 'haiku' }),
      );
    expect
      .soft(result.warn)
      .not.toHaveBeenCalledWith(expect.objectContaining({ event: 'assistant.haiku_failed' }));
    expect
      .soft(result.increment)
      .toHaveBeenCalledWith('assistant_vocabulary_preflight_failures_total', {
        outcome: 'timeout',
      });
    expect.soft(result.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'assistant.vocabulary_preflight_failed',
        outcome: 'timeout',
      }),
    );
    expect(result.text).toBe('');
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
