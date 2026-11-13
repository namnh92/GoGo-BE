import { worstCases } from '../eval/cost-bound';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { OpenRouterDecisionProvider } from '@gogo/providers';
import { OpenRouterAssistantLlmAdapter, buildChatBody } from '@gogo/providers';
import { buildAssistantDecisionRequest, buildRelevanceRequest } from './decision';
import { buildComposerMessages, systemPrompt, type GroundedAnswerContext } from './grounding';
import { AssistantTaxonomyService } from '../application/taxonomy.service';
import type { IntentTaxonomy } from '../../search/domain/intent';
import { SEED_TAXONOMY } from '../../search/eval/seed-taxonomy';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jevBody = (request: ReturnType<typeof buildAssistantDecisionRequest>) => ({
  model: 'typesafe/jev-1.14',
  state: request.state,
  questions: request.questions,
});
const empty: IntentTaxonomy = { category: [], mood: [], setting: [], suitability: [] };
const options = { previousRequest: null, openedFrom: null };
const base: GroundedAnswerContext = {
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
const term = (i: number) => ({
  key: `term_${String(i).padStart(4, '0')}`,
  label: 'Yên tĩnh 😀 '.repeat(10),
});

/** Uses the real seed literal, then the production taxonomy read/mapping path.
 * No database or model inference is needed for these request-shape contracts. */
async function seedTaxonomy(): Promise<IntentTaxonomy> {
  const source = readFileSync('libs/database/src/seed.ts', 'utf8');
  const literal = source
    .slice(
      source.indexOf('= {', source.indexOf('const TAXONOMY')) + 2,
      source.indexOf('\n\nconst SERVICE_AREAS'),
    )
    .replace(/;\s*$/, '');
  const seed = runInNewContext(`(${literal})`) as Record<
    string,
    { keys: string[]; labelsVi: Record<string, string> }
  >;
  const rows = ['category', 'mood', 'setting', 'suitability'].flatMap((kind) =>
    seed[kind]!.keys.map((key) => ({
      kind,
      key,
      label: seed[kind]!.labelsVi[key] ?? key,
      synonyms: [],
    })),
  );
  const service = new AssistantTaxonomyService({ execute: async () => ({ rows }) } as never);
  return service.taxonomy();
}

function realisticContext(): GroundedAnswerContext {
  return {
    ...base,
    constraints: [{ name: 'party_size', value: '4', origin: 'explicit' }],
    preferences: { moods: ['Thư giãn', 'Ấm cúng'], settings: ['Trong nhà'], occasion: 'Nhóm bạn' },
    places: [1, 2, 3].map((position) => ({
      position,
      placeId: `place-${position}`,
      name: 'Cà phê yên tĩnh',
      categories: ['Cà phê'],
      moods: ['Thư giãn'],
    })),
    guide: [1, 2, 3].map((index) => ({
      index,
      title: 'Hướng dẫn GoGo',
      heading: 'Lập kèo',
      excerpt: 'Chọn địa điểm phù hợp. '.repeat(60),
    })),
    plan: { roomTitle: 'Cuối tuần cùng bạn', roomType: 'group', status: 'draft', stopCount: 3 },
  };
}

const history = Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 ? ('assistant' as const) : ('user' as const),
  text: 'Cà phê yên tĩnh. '.repeat(40),
}));

// Fixed numeric acceptance envelopes let this file run unchanged on re-design.
describe('#905 payload exceeds cap regression', () => {
  it('oversized taxonomy has a deterministic whole-request bound and matching question keys', () => {
    const taxonomy = { ...empty, mood: Array.from({ length: 500 }, (_, i) => term(i)) };
    const request = buildAssistantDecisionRequest('Cà phê yên tĩnh', options, taxonomy);
    expect(bytes(jevBody(request))).toBeLessThanOrEqual(32_768);
    expect(
      buildAssistantDecisionRequest('Cà phê yên tĩnh', options, {
        ...taxonomy,
        mood: [...taxonomy.mood].reverse(),
      }),
    ).toEqual(request);
    const state = request.state.taxonomy as { mood: Record<string, string> };
    expect(
      Object.keys(request.questions)
        .filter((key) => key.startsWith('mood:'))
        .map((key) => key.slice(5)),
    ).toEqual(Object.keys(state.mood));
  });

  it('oversized taxonomy keys are dropped whole, never turned into new identifiers', () => {
    const terms = Array.from({ length: 100 }, (_, i) => ({
      key: `${i}_${'😀'.repeat(1000)}`,
      label: 'Thư giãn',
    }));
    const request = buildAssistantDecisionRequest('Cà phê', options, { ...empty, mood: terms });
    expect(bytes(jevBody(request))).toBeLessThanOrEqual(32_768);
    const mood = (request.state.taxonomy as { mood: Record<string, string> }).mood;
    const originalKeys = new Set(terms.map((t) => t.key));
    for (const key of Object.keys(mood)) expect(originalKeys.has(key)).toBe(true);
    expect(Object.keys(mood).length).toBeLessThan(terms.length);
  });

  it('oversized resolved lists and label maps retain the same ordered subset', () => {
    const keys = Array.from({ length: 500 }, (_, i) => `mood_${String(i).padStart(4, '0')}`);
    const labels = Object.fromEntries(keys.map((key) => [key, 'Yên tĩnh 😀'.repeat(40)]));
    const resolved = {
      settled: { moods: keys, partySize: 4 },
      assumed: { occasion: 'group' },
      open: ['area'],
      labels,
    };
    const request = buildAssistantDecisionRequest('Cà phê', { ...options, resolved }, empty);
    const reversed = {
      ...resolved,
      settled: { partySize: 4, moods: [...keys].reverse() },
      labels: Object.fromEntries(Object.entries(labels).reverse()),
    };
    expect(bytes(jevBody(request))).toBeLessThanOrEqual(32_768);
    expect(
      buildAssistantDecisionRequest('Cà phê', { ...options, resolved: reversed }, empty),
    ).toEqual(request);
    const kept = request.state.resolved as { settled: { moods?: string[] } };
    expect(kept.settled.moods?.every((key) => keys.includes(key))).toBe(true);
  });

  it('oversized resolved content is bounded in decision and relevance without mutating it', () => {
    const resolved = {
      settled: { area: '😀\u0000'.repeat(40_000) },
      assumed: {},
      labels: {},
      open: [],
    };
    const original = JSON.stringify(resolved);
    const decision = buildAssistantDecisionRequest('Cà phê', { ...options, resolved }, empty);
    expect(bytes(jevBody(decision))).toBeLessThanOrEqual(32_768);
    expect(
      bytes(
        jevBody(buildRelevanceRequest('Cà phê', [{ key: 'c1', description: 'Cà phê' }], resolved)),
      ),
    ).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(resolved)).toBe(original);
    expect(JSON.stringify(decision)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/i);
  });

  it('oversized candidate labels are bounded in the relevance request', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      key: `c${i + 1}`,
      description: 'Cà phê 😀\u0000'.repeat(10_000),
    }));
    expect(bytes(jevBody(buildRelevanceRequest('Cà phê', candidates)))).toBeLessThanOrEqual(16_384);
    expect(buildRelevanceRequest('Cà phê', candidates)).toEqual(
      buildRelevanceRequest('Cà phê', candidates),
    );
  });

  it('oversized constraints, preferences, tags and history fit the complete Haiku body', () => {
    const labels = Array.from({ length: 500 }, (_, i) => term(i).label + i);
    const ctx: GroundedAnswerContext = {
      ...realisticContext(),
      constraints: labels.map((value, i) => ({
        name: `constraint_${i}`,
        value,
        origin: 'explicit',
      })),
      preferences: { moods: labels, settings: labels, occasion: '😀'.repeat(10_000) },
      places: [1, 2, 3].map((position) => ({
        position,
        placeId: String(position),
        name: '😀'.repeat(1000),
        categories: labels,
        moods: labels,
      })),
    };
    const request = {
      messages: buildComposerMessages(ctx, history, '😀\u0000'.repeat(10_000)),
      maxOutputTokens: 600,
      signal: new AbortController().signal,
    };
    expect(bytes(buildChatBody('anthropic/claude-haiku-5.5', request))).toBeLessThanOrEqual(49_152);
    const reversed = {
      ...ctx,
      constraints: [...ctx.constraints].reverse(),
      preferences: {
        ...ctx.preferences,
        moods: [...labels].reverse(),
        settings: [...labels].reverse(),
      },
      places: ctx.places.map((p) => ({
        ...p,
        categories: [...labels].reverse(),
        moods: [...labels].reverse(),
      })),
    };
    expect(buildComposerMessages(reversed, history, '😀\u0000'.repeat(10_000))).toEqual(
      request.messages,
    );
  });

  it('Jev over-cap final body never starts billing or dispatches HTTP', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const start = vi.fn();
    const adapter = new OpenRouterDecisionProvider({
      apiKey: 'contract-fixture',
      model: 'typesafe/jev-1.14',
      timeoutMs: 1000,
      fetchImpl,
    });
    await expect(
      adapter.decide(
        { state: { request: 'x'.repeat(40_000) }, questions: {} },
        { billing: { start } },
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('Haiku over-cap final body never starts billing or dispatches HTTP', async () => {
    const fetchImpl = vi.fn(async () => new Response(''));
    const start = vi.fn();
    const adapter = new OpenRouterAssistantLlmAdapter({ apiKey: 'contract-fixture', fetchImpl });
    await expect(
      (async () => {
        for await (const event of adapter.stream({
          messages: [{ role: 'system', content: 'x'.repeat(50_000) }],
          maxOutputTokens: 600,
          signal: new AbortController().signal,
          billing: { start },
        }))
          void event;
      })(),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

it('#905 realistic request shapes and measurements', async () => {
  const taxonomy = await seedTaxonomy();
  const decision = buildAssistantDecisionRequest(
    'Cà phê yên tĩnh cho nhóm bạn',
    {
      previousRequest: 'Cuối tuần đi đâu?',
      openedFrom: 'plan',
      pending: { question: 'Bạn muốn đi đâu?', latest: 'Cà phê yên tĩnh cho nhóm bạn' },
      resolved: { settled: { partySize: 4 }, assumed: {}, open: ['area'], labels: {} },
    },
    taxonomy,
  );
  const relevance = buildRelevanceRequest(
    'Cà phê yên tĩnh cho nhóm bạn',
    Array.from({ length: 6 }, (_, i) => ({
      key: `c${i + 1}`,
      description: 'Cà phê yên tĩnh (Cà phê, Thư giãn, Ấm cúng, Trong nhà)',
    })),
  );
  const messages = buildComposerMessages(
    realisticContext(),
    history,
    'Cà phê yên tĩnh. '.repeat(150),
  );
  const haiku = buildChatBody('anthropic/claude-haiku-5.5', {
    messages,
    maxOutputTokens: 600,
    signal: new AbortController().signal,
  });
  const evalDecision = buildAssistantDecisionRequest(
    'Cà phê yên tĩnh cho nhóm bạn',
    options,
    SEED_TAXONOMY,
  );
  const worst = worstCases(taxonomy, 600);
  const worstBytes = {
    decision: bytes(jevBody(worst.decision as ReturnType<typeof buildAssistantDecisionRequest>)),
    relevance: bytes(jevBody(worst.relevance as ReturnType<typeof buildAssistantDecisionRequest>)),
    haiku: bytes(
      buildChatBody('anthropic/claude-haiku-5.5', {
        messages: worst.compose,
        maxOutputTokens: 600,
        signal: new AbortController().signal,
      }),
    ),
  };
  expect(worstBytes.decision).toBeLessThanOrEqual(32_768);
  expect(worstBytes.relevance).toBeLessThanOrEqual(16_384);
  expect(worstBytes.haiku).toBeLessThanOrEqual(49_152);
  // eslint-disable-next-line no-console -- scalar byte counts only, no prompts or labels
  console.info(
    '905 measurements',
    JSON.stringify({
      counts: Object.fromEntries(
        ['category', 'mood', 'setting', 'suitability'].map((k) => [
          k,
          taxonomy[k as keyof typeof empty]!.length,
        ]),
      ),
      taxonomyBytes: bytes(taxonomy),
      worstBytes,
      systemBytes: Buffer.byteLength(systemPrompt('vi')),
      decisionBytes: bytes(jevBody(decision)),
      relevanceBytes: bytes(jevBody(relevance)),
      haikuBytes: bytes(haiku),
      evalDecisionBytes: bytes(jevBody(evalDecision)),
    }),
  );
  expect({
    decision: digest(jevBody(decision)),
    relevance: digest(jevBody(relevance)),
    haiku: digest(haiku),
  }).toMatchSnapshot();
});
