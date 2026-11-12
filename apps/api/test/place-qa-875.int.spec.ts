import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@gogo/database';
import { sql } from 'drizzle-orm';
import { ASSISTANT_LLM, type AssistantLlmPort, type DecisionProviderPort } from '@gogo/providers';
import { ASSISTANT_DECISION_PROVIDER } from '../../../libs/modules/assistant/application/assistant.config';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { SearchService } from '../../../libs/modules/search/application/search.service';
import {
  startAssistantFixture,
  parseSse,
  type AssistantFixture,
} from './support/assistant-fixture';
import { placeNameKeyIndex } from './support/place-name-key';

// Independent #875 regression fixtures. Do not copy or alter Layer A's corpus.
let f: AssistantFixture;
let decisions: ReturnType<typeof vi.spyOn>;
let llm: ReturnType<typeof vi.spyOn>;
const ids: Record<string, string> = {};
const names = {
  dash: 'Mizu – Bến Sương',
  exact: 'Rạp Sao Mộc Bến Sương',
  sibling1: 'Rạp Sao Mộc Bến Trăng',
  sibling2: 'Rạp Sao Mộc Bến Mây',
  duplicate1: 'The Moonlit Coffee',
  duplicate2: 'The Moonlit Coffee',
  confirm: 'Hoshizora – Trúc Tím',
};

beforeAll(async () => {
  f = await startAssistantFixture({
    OPENROUTER_API_KEY: 'fixture-never-sent',
    OPENROUTER_ASSISTANT_API_KEY: 'fixture-never-sent',
    ASSISTANT_USER_DAILY_MAX_MESSAGES: '1000',
    ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES: '600',
    ASSISTANT_MONTHLY_MAX_USD: '100',
  });
  await placeNameKeyIndex(f.db);
  decisions = vi
    .spyOn(f.app.get<DecisionProviderPort>(ASSISTANT_DECISION_PROVIDER), 'decide')
    .mockRejectedValue(new Error('QA must never call a model'));
  llm = vi.spyOn(f.app.get<AssistantLlmPort>(ASSISTANT_LLM), 'stream');
  const stamp = new Date('2025-02-03T10:00:00Z');
  for (const [key, name] of Object.entries(names)) {
    const [place] = await f.db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: 'trigger',
        status: 'published',
        geom: { x: 105.79, y: 21.03 },
        addressText: '12 Đường Hư Cấu',
        administrativeMappingStatus: 'VERIFIED',
        administrativeDatasetVersion: f.area.datasetVersion,
        provinceCode: f.area.provinceCode,
        communeCode: f.area.communeCode,
      })
      .returning();
    ids[key] = place!.id;
    await f.db.insert(schema.placePrices).values({
      placeId: place!.id,
      priceMin: 12000,
      priceMax: 24000,
      currency: 'VND',
      unit: 'per_person',
      confidence: '0.9',
      source: 'editor',
      verifiedAt: stamp,
    });
    await f.db.insert(schema.placeHours).values(
      Array.from({ length: 7 }, (_, dayOfWeek) => ({
        placeId: place!.id,
        dayOfWeek,
        openMinute: 540,
        closeMinute: 1380,
        source: 'editor' as const,
        verifiedAt: stamp,
      })),
    );
    await f.db.insert(schema.placeFieldProvenance).values({
      placeId: place!.id,
      field: 'address_text',
      sourceType: 'editorial',
      sourceReference: 'fictional merchant attestation',
      collectedAt: stamp,
      verifiedAt: stamp,
    });
  }
  await f.setFlag(true);
  await f.db
    .insert(schema.featureFlags)
    .values({
      key: 'assistant.place_qa.enabled',
      environment: 'all',
      platform: 'all',
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [
        schema.featureFlags.key,
        schema.featureFlags.environment,
        schema.featureFlags.platform,
      ],
      set: { enabled: true },
    });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await f?.close();
});

async function conversation() {
  const token = await f.register(`qa-875-${randomUUID()}@example.test`);
  const res = await f.inject({
    method: 'POST',
    url: '/v1/assistant/conversations',
    token,
    payload: { title: '875 fictional fixtures' },
  });
  expect(res.statusCode, 'admission setup is not regression proof').toBe(201);
  return { token, id: res.json().id as string };
}
async function turn(c: { token: string; id: string }, text: string) {
  const res = await f.inject({
    method: 'POST',
    url: `/v1/assistant/conversations/${c.id}/messages`,
    token: c.token,
    headers: { 'idempotency-key': randomUUID() },
    payload: { text }, // Deliberately no follow-up ids.
  });
  expect(res.statusCode, 'send setup is not regression proof').toBe(202);
  const id = res.json().assistantMessage.id as string;
  const stream = await f.sse(`/v1/assistant/conversations/${c.id}/messages/${id}/stream`, c.token);
  expect(stream.status).toBe(200);
  const frames = parseSse(stream.body);
  expect(frames.some((frame) => frame.event === 'done' && frame.data.status === 'complete')).toBe(
    true,
  );
  const history = await f.inject({
    method: 'GET',
    url: `/v1/assistant/conversations/${c.id}/messages?limit=50`,
    token: c.token,
  });
  expect(history.statusCode).toBe(200);
  const message = history.json().items.find((m: { id: string }) => m.id === id);
  const stored = await f.app.get(AssistantRepository).findMessageById(id);
  expect(stored?.trace?.route).toBe('place_qa');
  expect(decisions).not.toHaveBeenCalled();
  expect(llm).not.toHaveBeenCalled();
  return { message, stored, frames, qa: stored!.trace!.placeQa };
}

describe('GoGo-BE#875 public send → real SQL → SSE → history', () => {
  it('answers the unique en-dash name using the stored ASCII-dash exact key', async () => {
    const stored = await f.db.execute(
      sql`select name_normalized from places where id=${ids['dash']}::uuid`,
    );
    expect(stored.rows[0]?.name_normalized).toBe('mizu - ben suong');
    const result = await turn(await conversation(), `${names.dash} mở cửa mấy giờ?`);
    expect(result.qa).toMatchObject({ row: 3, outcome: 'answer', candidateIds: [ids['dash']] });
    expect(result.message.cards.map((c: { placeId: string }) => c.placeId)).toEqual([ids['dash']]);
  });
  it('answers the whole ticket-price name rather than confirming shared-prefix siblings', async () => {
    const result = await turn(await conversation(), `Giá vé ${names.exact} bao nhiêu?`);
    expect(result.qa).toMatchObject({
      row: 3,
      topic: 'price',
      outcome: 'answer',
      candidateIds: [ids['exact']],
    });
    expect(
      result.message.followUps.every((g: { field: string }) => g.field !== 'place_confirm'),
    ).toBe(true);
  });
  it('offers both exact duplicate names as a choice with two cards', async () => {
    const result = await turn(await conversation(), `${names.duplicate1} ở đâu?`);
    expect(result.qa).toMatchObject({ row: 4, outcome: 'choice' });
    expect(result.message.cards.map((c: { placeId: string }) => c.placeId).sort()).toEqual(
      [ids['duplicate1'], ids['duplicate2']].sort(),
    );
    expect(result.message.followUps[0].field).toBe('place_choice');
  });
  it('case 3: The Workshop Coffee exact pair wins over a genuinely overflowing fuzzy channel', async () => {
    const name = 'The Workshop Coffee';
    const fuzzyNames = Array.from({ length: 10 }, (_, i) => `${name} Garden ${i + 1}`);
    const places = await f.db
      .insert(schema.places)
      .values(
        [name, name, ...fuzzyNames].map((name) => ({
          name,
          nameNormalized: 'trigger',
          status: 'published' as const,
          geom: { x: 105.79, y: 21.03 },
          administrativeMappingStatus: 'VERIFIED' as const,
          administrativeDatasetVersion: f.area.datasetVersion,
          provinceCode: f.area.provinceCode,
          communeCode: f.area.communeCode,
        })),
      )
      .returning();
    const exactIds = places
      .filter((p) => p.name === name)
      .map((p) => p.id)
      .sort();
    // Assert the real retrieval predicates at the production thresholds. Merely
    // seeding >8 coffee names does not prove they enter this query's fuzzy channel.
    const fuzzy = await f.db.transaction(async (tx) => {
      await tx.execute(sql`select
        set_config('pg_trgm.word_similarity_threshold', '0.3', true),
        set_config('pg_trgm.similarity_threshold', '0.3', true)`);
      return tx.execute(sql`select p.id from places p
        where p.name = any(array[${sql.join(
          fuzzyNames.map((name) => sql`${name}`),
          sql`, `,
        )}]::text[])
          and p.status = 'published'
          and (${'the workshop coffee'} <% p.name_normalized
            or p.name_normalized % ${'the workshop coffee'}
            or p.search_tsv @@ websearch_to_tsquery('simple', ${'the workshop coffee'}))`);
    });
    expect(fuzzy.rows).toHaveLength(10);
    const resolved = await f.app.get(SearchService).resolvePlaceName(name);
    expect(resolved.overflow).toBe(true);
    const result = await turn(await conversation(), `${name} ở đâu?`);
    expect(result.qa).toMatchObject({ row: 4, outcome: 'choice' });
    expect(result.qa).toMatchObject({ candidateIds: exactIds });
    expect(result.message.cards.map((c: { placeId: string }) => c.placeId).sort()).toEqual(
      exactIds,
    );
    expect(
      result.frames
        .filter((frame) => frame.event === 'card')
        .map((frame) => frame.data.card.placeId)
        .sort(),
    ).toEqual(exactIds);
    expect(result.message.followUps[0].field).toBe('place_choice');
    // Even a caller's smaller fuzzy cap cannot truncate the complete exact pair.
    const capped = await f.app.get(SearchService).resolvePlaceName(name, { limit: 1 });
    expect(capped).toMatchObject({ kind: 'choice', row: 4, overflow: true });
    expect(capped.candidates.map((c) => c.id).sort()).toEqual(exactIds);
  });
  it('answers a second turn containing the emitted singleton confirmation text without ids', async () => {
    const c = await conversation();
    const first = await turn(c, 'Hoshizoraa Trúc Tím giá bao nhiêu?');
    expect(first.qa).toMatchObject({ row: 5, outcome: 'confirm', candidateIds: [ids['confirm']] });
    const chip = first.message.followUps[0].options[0].text as string;
    const liveChip = first.frames.find((frame) => frame.event === 'follow_ups')?.data.groups[0]
      ?.options[0]?.text;
    expect(liveChip).toBe(chip);
    const facts = await f.app.get(SearchService).placeFacts([ids['confirm']!], {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 2000,
    });
    const area = facts.places.get(ids['confirm']!)!.areaLabel;
    expect(area).toBeTruthy();
    expect(chip).toBe(`Xác nhận ${names.confirm} · ${area}`);
    const second = await turn(c, chip);
    expect(second.qa).toMatchObject({
      class: 'control',
      row: 3,
      topic: 'price',
      outcome: 'answer',
      candidateIds: [ids['confirm']],
    });
    expect(second.message.cards.map((card: { placeId: string }) => card.placeId)).toEqual([
      ids['confirm'],
    ]);
    expect(JSON.stringify(second.stored?.trace)).not.toMatch(/Hoshizora|Trúc Tím/);
  });
});
