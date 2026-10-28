import { describe, expect, it } from 'vitest';
import type { AssistantFrame } from '../domain/assistant.types';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { newTurnState } from './turn-state';

/**
 * GoGo-BE#713 DEV acceptance 2026-10-28, owner decision the same day: places
 * are searched by the new administrative address only (province + commune,
 * no district since the 2025 merger). An area the assistant cannot place is
 * never guessed; the reply asks the person to re-enter it as a new address.
 * The decision provider is a stub: no inference happens here.
 */
const answers = {
  in_scope: { type: 'noul', noul: 0.99 },
  needs_clarification: { type: 'noul', noul: 0.01 },
  conflicting: { type: 'noul', noul: 0.01 },
  category: { type: 'choice', choice: 'category:cafe' },
  occasion: { type: 'choice', choice: 'not_stated' },
  assistant_intent: { type: 'choice', choice: 'recommend_places' },
  action: { type: 'choice', choice: 'none' },
  needs_unverified_attribute: { type: 'noul', noul: 0.01 },
};

async function reply(text: string, locale: 'vi' | 'en' = 'vi'): Promise<string> {
  const frames: AssistantFrame[] = [];
  const orchestrator = new AssistantOrchestrator(
    {
      ASSISTANT_FIRST_TEXT_TIMEOUT_MS: 5_000,
      ASSISTANT_JEV_TIMEOUT_MS: 4_000,
      ASSISTANT_MAX_OUTPUT_TOKENS: 100,
    } as never,
    { history: async () => [], insertProposal: async () => ({}) } as never,
    {
      taxonomy: async () => ({
        category: [{ key: 'category:cafe', label: 'cà phê' }],
        mood: [],
        setting: [],
        suitability: [],
      }),
      labels: () => new Map<string, string>(),
    } as never,
    { search: async () => ({ results: [] }) } as never,
    { placeTags: async () => new Map(), placeCard: async () => null } as never,
    { resolve: async () => ({ kind: 'none' }) } as never,
    {} as never,
    {} as never,
    {
      decide: async () => ({
        model: 'typesafe/jev-1.14',
        answers,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 },
      }),
    } as never,
    null,
  );
  await orchestrator.run(
    {
      messageId: 'm',
      ledgerId: 'l',
      conversationId: 'c',
      userId: 'u',
      text,
      locale,
      context: null,
    },
    newTurnState(),
    { emit: async (f: AssistantFrame) => void frames.push(f) } as never,
    new AbortController().signal,
  );
  return frames
    .filter((f): f is Extract<AssistantFrame, { type: 'delta' }> => f.type === 'delta')
    .map((f) => f.text)
    .join('');
}

describe('an area the assistant cannot place asks for the new address (owner 2026-10-28)', () => {
  it('an old district name: not recognised, re-enter as a new address', async () => {
    const text = await reply('Quán cà phê yên tĩnh ở Quận 1');
    expect(text).toMatch(/chưa nhận ra khu vực/);
    expect(text).toMatch(/địa chỉ hành chính mới/);
    expect(text).toMatch(/phường\/xã và tỉnh\/thành phố/);
  });

  it('no area at all: asks for one, as a new address', async () => {
    const text = await reply('🦄 quán xyzqwv ở đâu');
    expect(text).toMatch(/khu vực nào/);
    expect(text).toMatch(/địa chỉ hành chính mới/);
  });

  it('English replies say the same', async () => {
    const text = await reply('A quiet cafe in District 1', 'en');
    expect(text).toMatch(/new administrative address/);
  });
});
