import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { startAssistantFixture, type AssistantFixture } from './support/assistant-fixture';
import { PlaceAnswerReader } from '../../../libs/modules/assistant/application/place-answer-reader';
import { SearchService } from '../../../libs/modules/search/application/search.service';
import { fixtureRow } from '../../../libs/modules/assistant/domain/place-qa/fixtures';
import { PLACE_FACTS_READER } from '../../../libs/modules/assistant/domain/place-qa/place-facts';

/**
 * #857/S2 confirm round. The real application graph, with NO test override of
 * the reader port: S1's PlaceAnswerReader must reach S2's SQL projection
 * through the production PLACE_FACTS_READER binding.
 */
let f: AssistantFixture;
beforeAll(async () => {
  f = await startAssistantFixture({
    OPENROUTER_API_KEY: 'fixture-jev-unused',
    OPENROUTER_ASSISTANT_API_KEY: 'fixture-haiku-unused',
  });
});
afterAll(async () => {
  await f?.close();
});

describe('S1 reader -> S2 projection, production Nest wiring', () => {
  it('Sol F-01: PlaceAnswerReader renders facts from the bound SearchService, not a load error', async () => {
    const id = f.places['quietRomantic']!;
    const reader = f.app.get(PlaceAnswerReader);
    const rendered = (await reader.page([fixtureRow('wiring-a', [id])], 'history')).get(
      'wiring-a',
    )!;
    expect(rendered.result).toBe('ok');
    expect(rendered.cards).toMatchObject([
      { kind: 'place', placeId: id, available: true, facts: { name: 'Ánh Trăng Bistro' } },
    ]);
    // The fixture's editor-verified per-person price reached the prose.
    expect(rendered.text).toMatch(/150[.,\s]?000/);
    expect(f.app.get(PLACE_FACTS_READER, { strict: false })).toBe(
      f.app.get(SearchService, { strict: false }),
    );
  });
  it('Sol F-03: one page read observes the fact duration once, on the S1 surface label', async () => {
    const metrics = f.app.get<MetricsPort>(METRICS, { strict: false });
    const observe = vi.spyOn(metrics, 'observe');
    try {
      const rendered = await f.app
        .get(PlaceAnswerReader)
        .page([fixtureRow('wiring-b', [f.places['cafe']!])], 'history');
      expect(rendered.get('wiring-b')!.result).toBe('ok');
      const durations = observe.mock.calls.filter(
        ([name]) => name === 'assistant_place_facts_duration_seconds',
      );
      expect(durations.map(([, , labels]) => labels)).toEqual([{ surface: 'history' }]);
    } finally {
      observe.mockRestore();
    }
  });
});
