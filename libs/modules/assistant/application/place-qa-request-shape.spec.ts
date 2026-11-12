import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { PlaceQaService } from './place-qa.service';
import { applyFrame, newTurnState } from './turn-state';
import { FIXTURE_A } from '../domain/place-qa/fixtures';

/** Diagnostic complements the SQL/public-boundary history exclusion proof.
 * Captures the complete adapter request objects as serialized on each call;
 * no artificial constant token counter or reconstructed prompt is involved.
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
afterEach(() => vi.restoreAllMocks());
async function requests(enabled: boolean) {
  const captured: { jev: string[]; haiku: string[] } = { jev: [], haiku: [] };
  const repo = { history: async () => [], latestAssistant: async () => null };
  const availability = { placeQaEnabled: async () => enabled };
  const taxonomy = {
    taxonomy: async () => ({
      category: [{ key: 'category:cafe', label: 'Cà phê' }],
      mood: [],
      setting: [],
      suitability: [],
    }),
    labels: () => new Map([['category:cafe', 'Cà phê']]),
  };
  const search = { search: async () => ({ results: [{ id: FIXTURE_A }] }) };
  const areas = {
    resolve: async () => ({
      kind: 'resolved',
      value: {
        area: { datasetVersion: 'v', provinceCode: '01', communeCode: null },
        label: 'Hà Nội',
      },
    }),
    administrativeNames: async () => new Set<string>(),
  };
  const hydrator = {
    placeTags: async () => new Map(),
    placeCard: async () => ({
      kind: 'place',
      placeId: FIXTURE_A,
      available: true,
      facts: { name: 'Fictional Lantern' },
    }),
  };
  const decisions = {
    decide: async (req: unknown) => {
      captured.jev.push(JSON.stringify(req));
      return {
        model: 'fixture-jev',
        answers,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      };
    },
  };
  const llm = {
    model: 'fixture-haiku',
    async *stream(req: unknown) {
      captured.haiku.push(JSON.stringify(req));
      yield { type: 'delta', text: 'Bạn xem địa điểm này nhé.' };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
  const qa = new PlaceQaService(
    repo as never,
    search as never,
    areas as never,
    availability as never,
  );
  const orchestrator = new AssistantOrchestrator(
    {
      ASSISTANT_FIRST_TEXT_TIMEOUT_MS: 15000,
      ASSISTANT_JEV_TIMEOUT_MS: 5000,
      ASSISTANT_MAX_OUTPUT_TOKENS: 100,
      ASSISTANT_TURN_COST_CEILING_USD: 0.05,
    } as never,
    repo as never,
    taxonomy as never,
    search as never,
    hydrator as never,
    areas as never,
    {} as never,
    availability as never,
    decisions as never,
    llm as never,
    undefined,
    undefined,
    qa,
  );
  const state = newTurnState();
  let seq = 0;
  await orchestrator.run(
    {
      messageId: 'm',
      ledgerId: 'l',
      userId: 'u',
      conversationId: 'c',
      text: 'Gợi ý quán cafe ở Hà Nội giá 100k',
      locale: 'vi',
      context: null,
    },
    state,
    { emit: async (f) => applyFrame(state, { ...f, messageId: 'm', seq: ++seq } as never) },
    new AbortController().signal,
  );
  return captured;
}
describe('non-QA model request invariance', () => {
  it('flag on/off produces byte-identical complete Jev AND Haiku requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-11T10:00:00Z'));
    const off = await requests(false),
      on = await requests(true);
    expect(off.jev.length).toBeGreaterThan(0);
    expect(off.haiku.length).toBeGreaterThan(0);
    expect(on).toEqual(off);
    expect(JSON.stringify(on)).not.toMatch(/place_qa|placeQa|place_confirm|pick_1|a1:/);
  });
});
