import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@gogo/database';
import { SearchService } from '../../../libs/modules/search/application/search.service';
import { ASSISTANT_LLM, type AssistantLlmPort, type DecisionProviderPort } from '@gogo/providers';
import { ASSISTANT_DECISION_PROVIDER } from '../../../libs/modules/assistant/application/assistant.config';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { AssistantCardHydrator } from '../../../libs/modules/assistant/application/card-hydrator.service';
import {
  startAssistantFixture,
  parseSse,
  type AssistantFixture,
} from './support/assistant-fixture';
import { placeNameKeyIndex } from './support/place-name-key';

// Independent #877 regression fixtures. Do not copy or alter Layer A's corpus.
let f: AssistantFixture;
let decisions: ReturnType<typeof vi.spyOn>;
let llm: ReturnType<typeof vi.spyOn>;
const ids: Record<string, string> = {};
const names = {
  duplicate1: 'The Workshop Coffee',
  duplicate2: 'The Workshop Coffee',
  unique1: 'Mây Hồng Coffee',
  unique2: 'Mây Hồng Garden',
  price: 'CGV Vincom Đồng Khởi',
  control1: 'Quán 2',
  control2: 'Quán 3',
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
  const stamp = new Date('2026-10-20T00:00:00Z');
  for (const [key, name] of Object.entries(names)) {
    const [place] = await f.db
      .insert(schema.places)
      .values({
        ...(key.startsWith('control')
          ? { id: `87700000-0000-4000-8000-00000000000${key === 'control1' ? 1 : 2}` }
          : {}),
        name,
        nameNormalized: 'trigger',
        status: 'published',
        geom: { x: 105.79, y: 21.03 },
        addressText: `${key === 'duplicate2' ? 27 : 12} Đường Mây`,
        rating: '4.5',
        ratingCount: 2100,
        administrativeMappingStatus: 'VERIFIED',
        administrativeDatasetVersion: f.area.datasetVersion,
        provinceCode: f.area.provinceCode,
        communeCode: f.area.communeCode,
      })
      .returning();
    ids[key] = place!.id;
    await f.db.insert(schema.placePrices).values({
      placeId: place!.id,
      priceMin: 90000,
      priceMax: 180000,
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
  const token = await f.register(`qa-877-${randomUUID()}@example.test`);
  const res = await f.inject({
    method: 'POST',
    url: '/v1/assistant/conversations',
    token,
    payload: { title: '877 fictional fixtures' },
  });
  expect(res.statusCode, 'admission setup is not regression proof').toBe(201);
  return { token, id: res.json().id as string };
}
async function turn(
  c: { token: string; id: string },
  text: string,
  controls: { replyToMessageId?: string; followUpOptionId?: string } = {},
) {
  const res = await f.inject({
    method: 'POST',
    url: `/v1/assistant/conversations/${c.id}/messages`,
    token: c.token,
    headers: { 'idempotency-key': randomUUID() },
    payload: { text, ...controls },
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
  return { id, message, stored, frames, qa: stored!.trace!.placeQa };
}

describe('GoGo-BE#877 public send → SQL → SSE → history', () => {
  it('877-CARD: cards match the existing hydrator address, rating and per-person price', async () => {
    const result = await turn(await conversation(), `${names.duplicate1} ở đâu?`);
    expect(result.qa).toMatchObject({ outcome: 'choice' });
    for (const card of result.message.cards) {
      const expected = await f.app.get(AssistantCardHydrator).placeCard(card.placeId);
      expect(card).toEqual(expected);
      expect(card.facts).toMatchObject({
        providerRating: 4.5,
        providerRatingCount: 2100,
        providerRatingSource: 'google',
        priceMin: 90000,
        priceMax: 180000,
        currency: 'VND',
      });
      expect(card.facts.addressText).toMatch(/^(12|27) Đường Mây$/);
    }
    const live = result.frames
      .filter((frame) => frame.event === 'card')
      .map((frame) => frame.data.card);
    expect(live).toEqual(result.message.cards);
  });
  it('877-CHOICE: duplicates have distinct prompt, labels and name text; id pair selects the chip', async () => {
    const c = await conversation();
    const first = await turn(c, `${names.duplicate1} ở đâu?`);
    const options = first.message.followUps[0].options.slice(0, 2);
    expect(first.message.text).toContain('12 Đường Mây');
    expect(first.message.text).toContain('27 Đường Mây');
    expect(new Set(options.map((o: { text: string }) => o.text)).size).toBe(2);
    for (const [i, card] of first.message.cards.entries()) {
      expect(options[i].label).toMatch(new RegExp(`^${i + 1}\\. .+ · `));
      expect(Array.from(options[i].label).length).toBeLessThanOrEqual(40);
      expect(options[i].label).toContain(card.facts.addressText);
      expect(options[i].text).toBe(`${names.duplicate1} · ${card.facts.addressText}`);
    }
    const selected = await turn(c, options[1].text, {
      replyToMessageId: first.id,
      followUpOptionId: options[1].id,
    });
    expect(selected.qa).toMatchObject({
      outcome: 'answer',
      topic: 'address',
      candidateIds: [first.message.cards[1].placeId],
    });
  });
  it('877-TEXT: a distinct-name choice sends the name; ids remain authoritative over text', async () => {
    const c = await conversation();
    const first = await turn(c, 'Mây Hồng giá bao nhiêu?');
    expect(first.message.cards).toHaveLength(2);
    const options = first.message.followUps[0].options;
    expect(options[0].text).toBe(first.message.cards[0].facts.name);
    const selected = await turn(c, options[0].text, {
      replyToMessageId: first.id,
      followUpOptionId: options[1].id,
    });
    expect(selected.qa).toMatchObject({
      outcome: 'answer',
      topic: 'price',
      candidateIds: [first.message.cards[1].placeId],
    });
  });
  it('880-F-01: emitted Quán 2 never selects legacy ordinal candidate 2', async () => {
    const c = await conversation();
    // Both fixtures are fuzzy candidates for this absent name; tied scores use
    // the seeded UUID order so Quán 2 is option 1 and Quán 3 is option 2.
    const first = await turn(c, 'Quán 4 giá bao nhiêu?');
    expect(first.message.cards.map((card: { placeId: string }) => card.placeId)).toEqual([
      ids.control1,
      ids.control2,
    ]);
    expect(first.message.followUps[0].options[0].text).toBe('Quán 2');
    const reply = await turn(c, first.message.followUps[0].options[0].text);
    expect(reply.qa).toMatchObject({
      outcome: 'choice',
      topic: 'price',
      candidateIds: [ids.control1, ids.control2],
    });
    expect(reply.message.followUps[0].field).toBe('place_choice');
    expect(reply.message.cards.map((card: { placeId: string }) => card.placeId)).toEqual([
      ids.control1,
      ids.control2,
    ]);
    expect(reply.message.text).not.toContain('VND');
  });
  it('877-AMBIGUOUS: typed duplicate name without ids re-asks and never answers a branch', async () => {
    const c = await conversation();
    await turn(c, `${names.duplicate1} ở đâu?`);
    const reply = await turn(c, names.duplicate1);
    expect(reply.qa).not.toMatchObject({ outcome: 'answer' });
    expect(reply.message.cards.map((card: { placeId: string }) => card.placeId).sort()).toEqual(
      [ids.duplicate1, ids.duplicate2].sort(),
    );
    expect(reply.message.followUps[0].field).toBe('place_choice');
  });
  it('877-TYPED: emitted address text without ids asks for confirmation of exactly that branch', async () => {
    const c = await conversation();
    const first = await turn(c, `${names.duplicate1} ở đâu?`);
    const reply = await turn(c, first.message.followUps[0].options[1].text);
    expect(reply.qa).toMatchObject({
      outcome: 'confirm',
      topic: 'address',
      candidateIds: [first.message.cards[1].placeId],
    });
    const confirmOption = reply.message.followUps[0].options[0];
    const identity = await f.app.get(SearchService).placeFacts([first.message.cards[1].placeId], {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 2000,
    });
    expect(confirmOption.text).toBe(
      `Xác nhận ${names.duplicate1} · ${identity.places.get(first.message.cards[1].placeId)!.areaLabel}`,
    );
    expect(confirmOption.text).not.toContain('Đường Mây');
    const ambiguous = await turn(c, confirmOption.text);
    expect(ambiguous.qa).not.toMatchObject({ outcome: 'answer' });
    expect(ambiguous.qa).toMatchObject({
      pending: { slots: [{ candidateIds: [first.message.cards[1].placeId] }] },
    });
    const confirmAgain = await turn(c, first.message.followUps[0].options[1].text);
    const confirmed = await turn(c, confirmAgain.message.followUps[0].options[0].text, {
      replyToMessageId: confirmAgain.id,
      followUpOptionId: confirmAgain.message.followUps[0].options[0].id,
    });
    expect(confirmed.qa).toMatchObject({
      outcome: 'answer',
      topic: 'address',
      candidateIds: [first.message.cards[1].placeId],
    });
  });
  it('877-FORMAT: Vietnamese price and date keep reference tier and HH:mm hours', async () => {
    const result = await turn(await conversation(), `${names.price} giá bao nhiêu?`);
    expect(result.qa).toMatchObject({ outcome: 'answer', tier: 'verified_reference' });
    expect(result.message.text).toContain(
      '90.000–180.000 VND/người. Thông tin tham khảo, xác minh ngày 2026-10-20',
    );
    const hours = await turn(await conversation(), `${names.price} mở cửa mấy giờ?`);
    expect(hours.message.text).toContain('09:00–23:00');
    expect(hours.message.text).toContain('2026-10-20');
    const dated = await turn(await conversation(), `${names.price} mở cửa ngày 2026-12-25?`);
    expect(dated.qa).toMatchObject({ outcome: 'answer', tier: 'verified_reference' });
    expect(dated.message.text).toContain('09:00–23:00');
    expect(dated.message.text).toContain('2026-10-20');
    expect(dated.message.text).toContain('ngày được hỏi 2026-12-25');
  });
});
