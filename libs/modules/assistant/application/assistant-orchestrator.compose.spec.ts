import { describe, expect, it } from 'vitest';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { newTurnState } from './turn-state';
import type { AssistantFrameInput } from '../domain/assistant.types';

/**
 * GoGo-BE#717 A-R3-03 — the first-text deadline is about text the person
 * sees. A model that says one word and stalls, while the sanitizer holds that
 * word back (it may start a place's name), must still end in the
 * deterministic reply at the deadline. The LLM here is a stub that streams
 * one delta and then waits for its abort: no inference is involved.
 */
const answers = {
  in_scope: { type: 'noul', noul: 0.99 },
  needs_clarification: { type: 'noul', noul: 0.01 },
  conflicting: { type: 'noul', noul: 0.01 },
  category: { type: 'choice', choice: 'category:restaurant' },
  occasion: { type: 'choice', choice: 'not_stated' },
  assistant_intent: { type: 'choice', choice: 'recommend_places' },
  action: { type: 'choice', choice: 'none' },
  needs_unverified_attribute: { type: 'noul', noul: 0.01 },
};

describe('first-text deadline counts only visible text (A-R3-03)', () => {
  it('held-back model text does not keep the turn waiting past the deadline', async () => {
    const placeId = '00000000-0000-4000-8000-000000000001';
    const llm = {
      model: 'anthropic/claude-haiku-5.5',
      async *stream(req: { signal: AbortSignal }) {
        yield { type: 'delta', text: 'Nhà' };
        await new Promise((_resolve, reject) =>
          req.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      },
    };
    const orchestrator = new AssistantOrchestrator(
      {
        ASSISTANT_FIRST_TEXT_TIMEOUT_MS: 3_000,
        ASSISTANT_JEV_TIMEOUT_MS: 1_000,
        ASSISTANT_MAX_OUTPUT_TOKENS: 100,
      } as never,
      { history: async () => [], insertProposal: async () => ({}) } as never,
      {
        taxonomy: async () => ({ category: [], mood: [], setting: [], suitability: [] }),
        labels: () => new Map<string, string>(),
      } as never,
      { search: async () => ({ results: [{ id: placeId }] }) } as never,
      {
        placeTags: async () => new Map(),
        placeCard: async () => ({
          kind: 'place',
          placeId,
          available: true,
          facts: { name: 'Nhà Lá Café' },
        }),
      } as never,
      {
        resolve: async () => ({
          kind: 'resolved',
          value: {
            area: { datasetVersion: 'v', provinceCode: '01', communeCode: null },
            label: 'Hà Nội',
          },
        }),
      } as never,
      {} as never,
      { recordByokViolation: async () => undefined } as never,
      {
        decide: async () => ({
          model: 'typesafe/jev-1.14',
          answers,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 },
        }),
      } as never,
      llm as never,
    );
    const frames: AssistantFrameInput[] = [];
    const state = newTurnState();
    const started = Date.now();
    const outcome = await Promise.race([
      orchestrator.run(
        {
          messageId: 'm',
          ledgerId: 'l',
          conversationId: 'c',
          userId: 'u',
          text: 'Nhà hàng ở Hà Nội',
          locale: 'vi',
          context: null,
        },
        state,
        {
          emit: async (f) => {
            frames.push(f);
            if (f.type === 'delta') state.textStarted = true;
          },
        },
        new AbortController().signal,
      ),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 6_000)),
    ]);
    expect(outcome).not.toBe('hung');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toMatchObject({ status: 'fallback' });
    expect(frames.find((f) => f.type === 'notice')).toMatchObject({
      notice: { reason: 'timeout' },
    });
  }, 10_000);
});
