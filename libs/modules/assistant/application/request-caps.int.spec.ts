import { PlaceQaService } from './place-qa.service';
import { resolvePlaceNameOutcome } from '../domain/place-qa/resolution';
import { describe, expect, it, vi } from 'vitest';
import {
  OpenRouterAssistantLlmAdapter,
  OpenRouterDecisionProvider,
  type AssistantLlmPort,
  type DecisionProviderPort,
  buildChatBody,
} from '@gogo/providers';
import { AssistantOrchestrator, type TurnInput } from './assistant-orchestrator.service';
import { newTurnState, type TurnState, type TurnSink } from './turn-state';
import type { AssistantConfig } from './assistant.config';
import { parseIntentFacts, type IntentTaxonomy } from '../../search/domain/intent';
import {
  buildComposerMessages,
  type GroundedAnswerContext,
  type HistoryTurn,
} from '../domain/grounding';
import type { AssistantDecision, PendingClarification } from '../domain/decision';
import type { ResolvedPayload } from '../domain/reconcile';

/** Contract integration of real builders, orchestrator stages, adapters and HTTP
 * serialization. HTTP answers 503: proves bounded dispatch and deterministic
 * fallback, never live inference or DEV acceptance. Database QA is separate. */
const input: TurnInput = {
  messageId: 'm',
  ledgerId: 'l',
  conversationId: 'c',
  userId: 'u',
  text: 'Cà phê yên tĩnh',
  locale: 'vi',
  context: null,
};
const ctx: GroundedAnswerContext = {
  route: 'recommend_places',
  locale: 'vi',
  constraints: [],
  preferences: { moods: [], settings: [], occasion: null },
  places: [],
  guide: [],
  plan: null,
  pendingAction: null,
  clarification: [],
  unverifiableRequirement: false,
  conflicting: false,
};
const empty: IntentTaxonomy = { category: [], mood: [], setting: [], suitability: [] };
const signal = () => new AbortController().signal;

type Stages = {
  decide(
    input: TurnInput,
    text: string,
    facts: ReturnType<typeof parseIntentFacts>,
    previous: string | null,
    taxonomy: IntentTaxonomy,
    signal: AbortSignal,
    budgetMs: number,
    state: TurnState,
    pending?: PendingClarification | null,
    resolved?: ResolvedPayload | null,
  ): Promise<AssistantDecision>;
  rankByRelevance(
    text: string,
    ids: string[],
    signal: AbortSignal,
    budgetMs: number,
    state: TurnState,
    labels: Map<string, string>,
    resolved?: ResolvedPayload | null,
  ): Promise<string[]>;
  compose(
    input: TurnInput,
    ctx: GroundedAnswerContext,
    history: HistoryTurn[],
    state: TurnState,
    sink: TurnSink,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ kind: string; reason?: string }>;
};

function fixture(
  model = 'typesafe/jev-1.14',
  withQa = false,
  configuredModel = model,
  temperature = 0.3,
) {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response('{}', { status: 503 });
  });
  const decision = new OpenRouterDecisionProvider({
    apiKey: 'contract-only',
    model,
    timeoutMs: 1000,
    fetchImpl,
  });
  const llm = new OpenRouterAssistantLlmAdapter({
    apiKey: 'contract-only',
    fetchImpl,
    temperature,
  });
  const decide = vi.spyOn(decision, 'decide');
  const stream = vi.spyOn(llm, 'stream');
  const increment = vi.fn();
  const repo = {
    latestAssistant: async () => null,
    persistQaEnabled: async () => true,
    markPlaceQa: async () => 'm',
  };
  const search = {
    resolvePlaceName: async () =>
      resolvePlaceNameOutcome({ candidates: [], overflow: false, areaMismatch: false }),
  };
  const availability = { placeQaEnabled: async () => true };
  const areas = {
    administrativeNames: async () => new Set<string>(),
    resolve: async () => ({ kind: 'none' }),
  };
  const qa = withQa
    ? new PlaceQaService(repo as never, search as never, areas as never, availability as never)
    : undefined;
  const orchestrator = new AssistantOrchestrator(
    {
      ASSISTANT_FIRST_TEXT_TIMEOUT_MS: 15_000,
      ASSISTANT_JEV_MODEL: configuredModel,
      ASSISTANT_JEV_TIMEOUT_MS: 1000,
      ASSISTANT_MAX_OUTPUT_TOKENS: 600,
    } as AssistantConfig,
    repo as never,
    {} as never,
    search as never,
    {
      placeTags: async (ids: string[]) =>
        new Map(ids.map((id) => [id, { categories: ['cafe'], moods: [], settings: [] }])),
      placeCard: async () => ({ facts: { name: 'Cà phê' } }),
    } as never,
    areas as never,
    {} as never,
    availability as never,
    decision as DecisionProviderPort,
    llm as AssistantLlmPort,
    { increment, observe: vi.fn(), time: vi.fn() } as never,
    undefined,
    qa,
  );
  return {
    orchestrator,
    stages: orchestrator as unknown as Stages,
    decide,
    stream,
    bodies,
    increment,
  };
}

describe('#905 bounded request stage integration', () => {
  it.each(['decision', 'relevance'] as const)(
    'the final %s adapter guard preserves zero cost on model-config drift',
    async (step) => {
      const f = fixture(`typesafe/${'x'.repeat(40_000)}`, false, 'typesafe/jev-1.14');
      const state = newTurnState();
      const start = vi.fn();
      state.billing = { start };
      if (step === 'decision') {
        expect(
          await f.stages.decide(
            input,
            input.text,
            parseIntentFacts(input.text),
            null,
            empty,
            signal(),
            1000,
            state,
          ),
        ).toMatchObject({ source: 'fallback', fallbackReason: 'invalid_response' });
      } else {
        expect(
          await f.stages.rankByRelevance(input.text, ['1'], signal(), 10_000, state, new Map()),
        ).toEqual(['1']);
      }
      expect(f.decide).toHaveBeenCalledOnce();
      expect(f.bodies).toEqual([]);
      expect(start).not.toHaveBeenCalled();
      expect(state.costs.jevCalls).toBe(0);
      expect(state.jevInFlight).toBe(0);
      expect(state.trace.jevUnknownCost).toBeUndefined();
      expect(state.trace.requestBytes).toEqual({ step, reason: 'request_bytes' });
    },
  );

  it('Haiku checks its actual temperature/body after preflight and records no paid attempt', async () => {
    const f = fixture('typesafe/jev-1.14', false, undefined, Number.MAX_VALUE);
    const padded = { ...ctx, pendingAction: '' };
    const overhead = Buffer.byteLength(
      JSON.stringify(
        buildChatBody('anthropic/claude-haiku-5.5', {
          messages: buildComposerMessages(padded, [], input.text),
          maxOutputTokens: 600,
          signal: signal(),
        }),
      ),
    );
    padded.pendingAction = 'x'.repeat(49_152 - overhead);
    // Nonempty action adds a fixed suffix absent for the empty value.
    const sized = Buffer.byteLength(
      JSON.stringify(
        buildChatBody('anthropic/claude-haiku-5.5', {
          messages: buildComposerMessages(padded, [], input.text),
          maxOutputTokens: 600,
          signal: signal(),
        }),
      ),
    );
    padded.pendingAction = padded.pendingAction.slice(
      0,
      padded.pendingAction.length - (sized - 49_152),
    );
    const state = newTurnState();
    const start = vi.fn();
    state.billing = { start };
    expect(
      await f.stages.compose(
        input,
        padded,
        [],
        state,
        { emit: vi.fn() },
        signal(),
        Date.now() + 10_000,
      ),
    ).toEqual({ kind: 'fallback', reason: 'invalid_output' });
    expect(f.stream).toHaveBeenCalledOnce();
    expect(f.bodies).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expect(state.costs.haikuCalls).toBe(0);
    expect(state.trace.requestBytes).toEqual({ step: 'haiku', reason: 'request_bytes' });
  });

  it('place_qa exits the real orchestrator with zero model adapter calls', async () => {
    const f = fixture('typesafe/jev-1.14', true);
    const state = newTurnState();
    await f.orchestrator.run(
      { ...input, text: 'Fictional Lantern giá bao nhiêu?' },
      state,
      { emit: vi.fn() },
      signal(),
    );
    expect(state.trace.route).toBe('place_qa');
    expect(state.costs).toMatchObject({ jevCalls: 0, haikuCalls: 0, jevCostUsd: 0 });
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.stream).not.toHaveBeenCalled();
    expect(f.bodies).toEqual([]);
  });

  it('truncated taxonomy/resolved dispatches a bounded exact Jev HTTP body', async () => {
    const f = fixture();
    const state = newTurnState();
    const taxonomy = {
      ...empty,
      mood: Array.from({ length: 300 }, (_, i) => ({
        key: `m${i}`,
        label: 'Thư giãn 😀'.repeat(100),
      })),
    };
    const resolved = {
      settled: { area: '😀\u0000'.repeat(10_000) },
      assumed: {},
      open: [],
      labels: {},
    };
    const result = await f.stages.decide(
      input,
      input.text,
      parseIntentFacts(input.text),
      null,
      taxonomy,
      signal(),
      1000,
      state,
      null,
      resolved,
    );
    expect(result.source).toBe('fallback');
    expect(f.decide).toHaveBeenCalledOnce();
    expect(f.bodies).toHaveLength(1);
    expect(Buffer.byteLength(f.bodies[0]!)).toBeLessThanOrEqual(32_768);
    expect(JSON.parse(f.bodies[0]!).state.resolved.settled.area.length).toBeLessThan(
      resolved.settled.area.length,
    );
    expect(state.costs.jevCalls).toBe(1);
  });

  it('relevance tags are bounded before the exact body is dispatched', async () => {
    const f = fixture();
    const ids = ['1', '2', '3', '4', '5', '6'];
    const kept = await f.stages.rankByRelevance(
      input.text,
      ids,
      signal(),
      10_000,
      newTurnState(),
      new Map([['cafe', '😀'.repeat(20_000)]]),
    );
    expect(kept).toEqual(ids);
    expect(f.bodies).toHaveLength(1);
    expect(Buffer.byteLength(f.bodies[0]!)).toBeLessThanOrEqual(16_384);
  });

  it('oversized history/tags dispatches at most the Haiku byte envelope and falls back on 503', async () => {
    const f = fixture();
    const labels = Array.from({ length: 500 }, (_, i) => `${i} 😀`.repeat(20));
    const result = await f.stages.compose(
      input,
      { ...ctx, preferences: { moods: labels, settings: labels, occasion: null } },
      Array.from({ length: 100 }, () => ({ role: 'user', text: '😀'.repeat(10_000) })),
      newTurnState(),
      { emit: vi.fn() },
      signal(),
      Date.now() + 10_000,
    );
    expect(result).toEqual({ kind: 'fallback', reason: 'provider_unavailable' });
    expect(f.bodies).toHaveLength(1);
    expect(Buffer.byteLength(f.bodies[0]!)).toBeLessThanOrEqual(49_152);
  });

  it.each(['decision', 'relevance', 'haiku'] as const)(
    'irreducible %s overflow skips the adapter and records only closed labels',
    async (step) => {
      const f = fixture(step === 'haiku' ? 'typesafe/jev-1.14' : `typesafe/${'x'.repeat(40_000)}`);
      const state = newTurnState();
      const start = vi.fn();
      state.billing = { start };
      if (step === 'decision') {
        const result = await f.stages.decide(
          input,
          input.text,
          parseIntentFacts(input.text),
          null,
          empty,
          signal(),
          1000,
          state,
        );
        expect(result).toMatchObject({ source: 'fallback', fallbackReason: 'invalid_response' });
      } else if (step === 'relevance') {
        expect(
          await f.stages.rankByRelevance(
            input.text,
            ['1', '2'],
            signal(),
            10_000,
            state,
            new Map(),
          ),
        ).toEqual(['1', '2']);
      } else {
        expect(
          await f.stages.compose(
            input,
            { ...ctx, pendingAction: 'x'.repeat(60_000) },
            [],
            state,
            { emit: vi.fn() },
            signal(),
            Date.now() + 10_000,
          ),
        ).toEqual({ kind: 'fallback', reason: 'invalid_output' });
      }
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.stream).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(f.bodies).toEqual([]);
      expect(state.costs.jevCalls + state.costs.haikuCalls).toBe(0);
      expect(state.trace.requestBytes).toEqual({ step, reason: 'request_bytes' });
      expect(f.increment).toHaveBeenCalledWith('assistant_fallbacks_total', {
        reason: 'request_bytes',
      });
    },
  );
});
