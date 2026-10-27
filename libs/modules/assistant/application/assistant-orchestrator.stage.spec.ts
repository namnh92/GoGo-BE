import { describe, expect, it } from 'vitest';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { newTurnState } from './turn-state';

/**
 * GoGo-BE#717 A-R2-06 — a stage the first-text deadline abandoned must not
 * start a paid call afterwards. The decision provider is a counting stub: no
 * inference happens here, only whether a second call is ever placed.
 */
const answers = {
  in_scope: { type: 'noul', noul: 0.99 },
  needs_clarification: { type: 'noul', noul: 0.01 },
  conflicting: { type: 'noul', noul: 0.01 },
  category: { type: 'choice', choice: 'category:restaurant' },
  occasion: { type: 'choice', choice: 'not_stated' },
  'mood:romantic': { type: 'noul', noul: 0.95 },
  assistant_intent: { type: 'choice', choice: 'recommend_places' },
  action: { type: 'choice', choice: 'none' },
  needs_unverified_attribute: { type: 'noul', noul: 0.01 },
};

describe('abandoned retrieval places no paid call (A-R2-06)', () => {
  it('relevance ranking that resumes after the deadline never calls Jev', async () => {
    let decideCalls = 0;
    const decisions = {
      decide: async () => {
        decideCalls += 1;
        return {
          model: 'typesafe/jev-1.14',
          answers,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 },
        };
      },
    };
    const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const config = {
      ASSISTANT_FIRST_TEXT_TIMEOUT_MS: 5_300,
      ASSISTANT_JEV_TIMEOUT_MS: 5_000,
      ASSISTANT_MAX_OUTPUT_TOKENS: 100,
    };
    const orchestrator = new AssistantOrchestrator(
      config as never,
      { history: async () => [], insertProposal: async () => ({}) } as never,
      {
        taxonomy: async () => ({
          category: [{ key: 'category:restaurant', label: 'nhà hàng' }],
          mood: [{ key: 'mood:romantic', label: 'lãng mạn' }],
          setting: [],
          suitability: [],
        }),
        labels: () => new Map<string, string>(),
      } as never,
      { search: async () => ({ results: ids.map((id) => ({ id })) }) } as never,
      {
        // The tag read stalls past the deadline, then answers.
        placeTags: () => new Promise((r) => setTimeout(() => r(new Map()), 5_600)),
        placeCard: async (id: string) => ({
          kind: 'place',
          placeId: id,
          available: true,
          facts: { name: 'X' },
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
      {} as never,
      decisions as never,
      null,
    );
    const outcome = await orchestrator.run(
      {
        messageId: 'm',
        ledgerId: 'l',
        conversationId: 'c',
        userId: 'u',
        text: 'Nhà hàng lãng mạn ở Hà Nội',
        locale: 'vi',
        context: null,
      },
      newTurnState(),
      { emit: async () => undefined },
      new AbortController().signal,
    );
    expect(outcome.status).toBe('fallback');
    expect(decideCalls).toBe(1);
    // Let the abandoned stage resume and finish.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(decideCalls).toBe(1);
  }, 15_000);
});
