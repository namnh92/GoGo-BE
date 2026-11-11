import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { ASSISTANT_LLM, type AssistantLlmPort, type DecisionProviderPort } from '@gogo/providers';
import { ASSISTANT_DECISION_PROVIDER } from '../../../libs/modules/assistant/application/assistant.config';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { AssistantTurnRunner } from '../../../libs/modules/assistant/application/assistant-turn-runner.service';
import { PlaceQaService } from '../../../libs/modules/assistant/application/place-qa.service';
import {
  startAssistantFixture,
  parseSse,
  type AssistantFixture,
} from './support/assistant-fixture';
import { placeNameKeyIndex } from './support/place-name-key';
import catalogue from '../../../libs/modules/assistant/eval/place-qa-fixtures.json';

/** GoGo-BE#873 Fable fix round. Public send / stop / SSE / history over the real
 * API, runner, repository and SQL catalogue; only the paid model adapters are
 * deterministic fixtures. Kept apart from the Layer A spec, whose bytes are
 * bound to the base/head evidence (scripts/eval/place-qa-layer-a-base.sh).
 */
let f: AssistantFixture;
const ids: Record<string, string> = {};
const stamp = new Date('2025-02-03T10:00:00Z');
const capture = { jev: [] as string[], haiku: [] as string[] };
let account = 0;
const QUESTION = 'Quán Sao Lạ giá bao nhiêu?';
const RECOMMEND = 'Gợi ý quán cafe ở Hà Nội giá 100k';

beforeAll(async () => {
  f = await startAssistantFixture({
    OPENROUTER_API_KEY: 'fixture-jev-never-sent',
    OPENROUTER_ASSISTANT_API_KEY: 'fixture-haiku-never-sent',
    ASSISTANT_USER_DAILY_MAX_MESSAGES: '1000',
    ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES: '600',
    ASSISTANT_MONTHLY_MAX_USD: '100',
  });
  await placeNameKeyIndex(f.db);
  const decisions = f.app.get<DecisionProviderPort>(ASSISTANT_DECISION_PROVIDER);
  vi.spyOn(decisions, 'decide').mockImplementation(async (req) => {
    capture.jev.push(JSON.stringify(req));
    return {
      model: 'fixture-jev',
      answers: {
        in_scope: { type: 'noul', noul: 0.99 },
        needs_clarification: { type: 'noul', noul: 0.01 },
        conflicting: { type: 'noul', noul: 0.01 },
        category: { type: 'choice', choice: 'cafe' },
        occasion: { type: 'choice', choice: 'not_stated' },
        assistant_intent: { type: 'choice', choice: 'recommend_places' },
        action: { type: 'choice', choice: 'none' },
        needs_unverified_attribute: { type: 'noul', noul: 0.01 },
        turn_relation: { type: 'choice', choice: 'new_request' },
      },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  });
  const llm = f.app.get<AssistantLlmPort>(ASSISTANT_LLM);
  vi.spyOn(llm, 'stream').mockImplementation(async function* (req) {
    capture.haiku.push(JSON.stringify(req));
    yield { type: 'delta', text: 'Bạn xem địa điểm trong thẻ nhé.' };
    yield { type: 'done', finishReason: 'stop' };
  });
  for (const [key, name] of Object.entries(catalogue.names)) {
    const [p] = await f.db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: 'trigger',
        status: 'published',
        geom: { x: 105.79, y: 21.03 },
        administrativeMappingStatus: 'VERIFIED',
        administrativeDatasetVersion: f.area.datasetVersion,
        provinceCode: f.area.provinceCode,
        communeCode: f.area.communeCode,
      })
      .returning();
    ids[key] = p!.id;
  }
  for (const key of ['lantern', 'branch_a', 'branch_b'])
    await f.db.insert(schema.placePrices).values({
      placeId: ids[key]!,
      priceMin: 12000,
      priceMax: 24000,
      currency: 'VND',
      unit: 'per_person',
      confidence: '0.9',
      source: 'editor',
      verifiedAt: stamp,
    });
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

type Conversation = { token: string; id: string };
async function conversation(): Promise<Conversation> {
  const token = await f.register(`qa-fence-${++account}@example.test`);
  const c = await f.inject({
    method: 'POST',
    url: '/v1/assistant/conversations',
    token,
    payload: { title: 'S3 fence fixture' },
  });
  expect(c.statusCode).toBe(201);
  return { token, id: c.json().id as string };
}
async function send(c: Conversation, text: string, control: Record<string, unknown> = {}) {
  const res = await f.inject({
    method: 'POST',
    url: `/v1/assistant/conversations/${c.id}/messages`,
    token: c.token,
    headers: { 'idempotency-key': randomUUID() },
    // Default is an old client: text only, no replyToMessageId / followUpOptionId.
    payload: { text, ...control },
  });
  expect(res.statusCode).toBe(202);
  return {
    id: res.json().assistantMessage.id as string,
    userId: res.json().userMessage.id as string,
  };
}
async function turn(c: Conversation, text: string, control: Record<string, unknown> = {}) {
  const sent = await send(c, text, control);
  const streamed = await f.sse(
    `/v1/assistant/conversations/${c.id}/messages/${sent.id}/stream`,
    c.token,
  );
  expect(streamed.status).toBe(200);
  const history = await f.inject({
    method: 'GET',
    url: `/v1/assistant/conversations/${c.id}/messages?limit=50`,
    token: c.token,
  });
  expect(history.statusCode).toBe(200);
  const message = history.json().items.find((m: { id: string }) => m.id === sent.id);
  for (let n = 0; n < 100; n++) {
    const ledger = await f.db.execute(
      sql`select status from assistant_usage_ledger where message_id=${sent.id}`,
    );
    if (ledger.rows[0]?.status !== 'accepted') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const stored = await f.app.get(AssistantRepository).findMessageById(sent.id);
  const qa = stored?.trace?.placeQa as
    | { outcome: string; topic: string; candidateIds: string[]; pending?: Record<string, any> }
    | undefined;
  return {
    ...sent,
    frames: parseSse(streamed.body),
    message,
    stored,
    qa,
    text: String(message?.text ?? ''),
  };
}
function resetCapture() {
  capture.jev.length = 0;
  capture.haiku.length = 0;
}
const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('fixture wait timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
/** Holds the runner inside funding resolution, i.e. before `PlaceQaService.handle`. */
function holdFunding() {
  const repo = f.app.get(AssistantRepository);
  const real = repo.runnableFunding.bind(repo);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const spy = vi.spyOn(repo, 'runnableFunding').mockImplementationOnce(async (...args) => {
    entered = true;
    await gate;
    return real(...args);
  });
  return { release, entered: () => entered, restore: () => spy.mockRestore() };
}
async function followingRecommendation(c: Conversation) {
  const clean = await conversation();
  resetCapture();
  await turn(clean, RECOMMEND);
  const expected = structuredClone(capture);
  resetCapture();
  const next = await turn(c, RECOMMEND);
  const seen = structuredClone(capture);
  return { next, expected, seen };
}

describe('Sol F-01: stop/reaper before PlaceQaService.handle keeps the QA pair fenced', () => {
  it('public stop during funding resolution: both rows stay out of recommendation history and model requests', async () => {
    const c = await conversation();
    const repo = f.app.get(AssistantRepository);
    const runner = f.app.get(AssistantTurnRunner);
    const handle = vi.spyOn(f.app.get(PlaceQaService), 'handle');
    const stopLocal = vi.spyOn(runner, 'stopLocal');
    const funding = holdFunding();
    try {
      const sent = await send(c, QUESTION);
      await until(funding.entered);
      const stopping = f.inject({
        method: 'POST',
        url: `/v1/assistant/conversations/${c.id}/messages/${sent.id}/stop`,
        token: c.token,
      });
      // stopLocal aborts synchronously, then waits for the runner: release only
      // after the abort so the turn ends while funding is still unresolved.
      await until(() => stopLocal.mock.calls.length > 0);
      expect(handle).not.toHaveBeenCalled();
      funding.release();
      const stopped = await stopping;
      expect(stopped.statusCode).toBeLessThan(300);
      const stored = await repo.findMessageById(sent.id);
      expect(stored?.status).toBe('stopped');
      expect(handle).not.toHaveBeenCalled();
      // Soft: the leak assertions below must be reported as well.
      expect
        .soft(stored?.trace)
        .toMatchObject({ route: 'place_qa', questionMessageId: sent.userId });

      const { next, expected, seen } = await followingRecommendation(c);
      const history = await repo.history(c.id, next.id, 50);
      expect.soft(history.map((m) => m.id)).not.toContain(sent.userId);
      expect(history.map((m) => m.id)).not.toContain(sent.id);
      expect.soft(history.map((m) => m.text).join('\n')).not.toContain('Quán Sao Lạ');
      expect.soft(JSON.stringify(seen)).not.toMatch(/Quán Sao Lạ|place_qa|placeQa/);
      expect(seen.jev.length).toBeGreaterThan(0);
      expect(seen.haiku.length).toBeGreaterThan(0);
      // Byte-identical to the same request in a conversation that never asked.
      expect(seen).toEqual(expected);
      expect(next.stored?.trace?.route).not.toBe('place_qa');
    } finally {
      funding.release();
      funding.restore();
      handle.mockRestore();
      stopLocal.mockRestore();
    }
  });
  it('another writer (stop fallback / reaper) finalizing during funding resolution keeps the association', async () => {
    const c = await conversation();
    const repo = f.app.get(AssistantRepository);
    const runner = f.app.get(AssistantTurnRunner);
    const handle = vi.spyOn(f.app.get(PlaceQaService), 'handle');
    const funding = holdFunding();
    try {
      const sent = await send(c, QUESTION);
      await until(funding.entered);
      const row = (await repo.findMessageById(sent.id))!;
      expect(row.status).toBe('streaming');
      const orphan = await runner.finalizeOrphan(row, 'stopped', null);
      expect(orphan?.status).toBe('stopped');
      expect(handle).not.toHaveBeenCalled();
      funding.release();
      await until(() => !runner.isRunningHere(sent.id));
      const stored = await repo.findMessageById(sent.id);
      expect.soft(stored?.trace).toMatchObject({
        route: 'place_qa',
        questionMessageId: sent.userId,
        orphaned: true,
      });
      const { next, expected, seen } = await followingRecommendation(c);
      const history = await repo.history(c.id, next.id, 50);
      expect.soft(history.map((m) => m.id)).not.toContain(sent.userId);
      expect(history.map((m) => m.id)).not.toContain(sent.id);
      expect.soft(JSON.stringify(seen)).not.toMatch(/Quán Sao Lạ|place_qa|placeQa/);
      expect(seen).toEqual(expected);
    } finally {
      funding.release();
      funding.restore();
      handle.mockRestore();
    }
  });
  it('a recommendation stopped at the same point is not fenced: non-QA history is unchanged', async () => {
    const c = await conversation();
    const repo = f.app.get(AssistantRepository);
    const runner = f.app.get(AssistantTurnRunner);
    const stopLocal = vi.spyOn(runner, 'stopLocal');
    const funding = holdFunding();
    try {
      const sent = await send(c, 'Gợi ý quán cafe ở Hà Nội');
      await until(funding.entered);
      const stopping = f.inject({
        method: 'POST',
        url: `/v1/assistant/conversations/${c.id}/messages/${sent.id}/stop`,
        token: c.token,
      });
      await until(() => stopLocal.mock.calls.length > 0);
      funding.release();
      expect((await stopping).statusCode).toBeLessThan(300);
      const stored = await repo.findMessageById(sent.id);
      expect(stored?.status).toBe('stopped');
      expect(stored?.trace?.route).toBeUndefined();
      const next = await turn(c, RECOMMEND);
      const history = await repo.history(c.id, next.id, 50);
      expect(history.map((m) => m.id)).toContain(sent.userId);
    } finally {
      funding.release();
      funding.restore();
      stopLocal.mockRestore();
    }
  });
  // Pinned residual, flag on only (docs/plans/864-s3-validation.md, residuals):
  // a bare text is a name-only PROBE, fenced at admission exactly as it was
  // fenced during the probe at 1c2dc953. Stopped before the probe can clear
  // it, it stays QA. Whether to narrow this is an owner/SA shape decision.
  it('a bare non-QA reply stopped before the name-only probe stays fenced (known flag-on residual)', async () => {
    const c = await conversation();
    const repo = f.app.get(AssistantRepository);
    const runner = f.app.get(AssistantTurnRunner);
    const stopLocal = vi.spyOn(runner, 'stopLocal');
    const asked = await turn(c, 'Gợi ý quán cafe');
    expect(asked.text).toContain('khu vực nào');
    const funding = holdFunding();
    try {
      const sent = await send(c, 'Cầu Giấy');
      await until(funding.entered);
      const stopping = f.inject({
        method: 'POST',
        url: `/v1/assistant/conversations/${c.id}/messages/${sent.id}/stop`,
        token: c.token,
      });
      await until(() => stopLocal.mock.calls.length > 0);
      funding.release();
      expect((await stopping).statusCode).toBeLessThan(300);
      const stored = await repo.findMessageById(sent.id);
      expect(stored?.status).toBe('stopped');
      expect(stored?.trace).toMatchObject({ route: 'place_qa', questionMessageId: sent.userId });
      resetCapture();
      const again = await turn(c, 'Cầu Giấy');
      const history = await repo.history(c.id, again.id, 50);
      expect(history.map((m) => m.id)).not.toContain(sent.userId);
      // The repeated bare reply is read as QA control of the stopped turn.
      expect(again.qa).toMatchObject({ class: 'control', outcome: 'stale_choice' });
      expect(capture).toEqual({ jev: [], haiku: [] });
      // An explicit request still reaches the recommendation path afterwards.
      const resumed = await turn(c, 'Gợi ý quán cafe ở Phường Cầu Giấy, Hà Nội');
      expect(resumed.stored?.trace?.route).not.toBe('place_qa');
      expect(capture.jev.length).toBeGreaterThan(0);
    } finally {
      funding.release();
      funding.restore();
      stopLocal.mockRestore();
    }
  });
});

describe('Sol F-02: an old client types the emitted option text', () => {
  it('choice → emitted ordinal → singleton confirm → emitted text → answer, with no model', async () => {
    const c = await conversation();
    resetCapture();
    const choice = await turn(c, 'Song Ngọc giá bao nhiêu?');
    expect(choice.qa).toMatchObject({ outcome: 'choice', topic: 'price' });
    const picked = choice.message.followUps[0].options[0];
    const confirm = await turn(c, picked.text);
    expect(confirm.message.followUps[0].field).toBe('place_confirm');
    expect(confirm.qa).toMatchObject({ outcome: 'confirm', topic: 'price' });
    expect(confirm.qa!.candidateIds).toHaveLength(1);
    const answered = await turn(c, confirm.message.followUps[0].options[0].text);
    expect(answered.qa).toMatchObject({
      outcome: 'answer',
      topic: 'price',
      candidateIds: confirm.qa!.candidateIds,
    });
    expect(answered.text).toContain('VND/người');
    expect(answered.stored?.status).toBe('complete');
    expect(capture).toEqual({ jev: [], haiku: [] });
  });
  it('legacy-district confirm (§4.4) → emitted text → answer', async () => {
    const c = await conversation();
    resetCapture();
    const confirm = await turn(c, 'Quán Sao Lạ giá bao nhiêu ở Quận 1?');
    expect(confirm.qa).toMatchObject({ outcome: 'confirm', topic: 'price' });
    expect(confirm.text).toContain('GoGo không tra theo quận/huyện cũ');
    const answered = await turn(c, confirm.message.followUps[0].options[0].text);
    expect(answered.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
    expect(answered.qa!.candidateIds).toEqual([ids['lantern']]);
    expect(answered.text).toContain('12000–24000 VND/người');
    expect(capture).toEqual({ jev: [], haiku: [] });
  });
});

describe('Astra F-01: referent → name → choice/none → area keeps the name source', () => {
  it.each(['choice → area', 'none → area'] as const)(
    '%s resolves Song Ngọc inside the area for the original price question',
    async (path) => {
      const c = await conversation();
      resetCapture();
      const question = await turn(c, 'Giá bao nhiêu?');
      expect(question.qa).toMatchObject({ outcome: 'clarify_referent', topic: 'price' });
      const name = await turn(c, 'Song Ngọc');
      expect(name.qa).toMatchObject({ outcome: 'choice', topic: 'price' });
      if (path === 'none → area') {
        const none = await turn(c, 'Không phải các quán này');
        expect(none.qa).toMatchObject({ outcome: 'narrow', topic: 'price' });
      }
      const refined = await turn(c, 'Phường Cầu Giấy, Hà Nội');
      // Both fictional branches are in this commune: the name is resolved again
      // inside the area, for the original question, instead of a retry.
      expect(refined.qa).toMatchObject({
        outcome: 'choice',
        topic: 'price',
        pending: {
          questionMessageId: question.userId,
          createdAt: question.qa!.pending!.createdAt,
          expiresAt: question.qa!.pending!.expiresAt,
        },
      });
      expect([...refined.qa!.candidateIds].sort()).toEqual(
        [ids['branch_a']!, ids['branch_b']!].sort(),
      );
      expect(refined.qa!.pending!.slots[0].sourceMessageId).toBe(name.userId);
      const answered = await turn(c, '1', {
        replyToMessageId: refined.id,
        followUpOptionId: refined.message.followUps[0].options[0].id,
      });
      expect(answered.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
      expect(answered.text).toContain('VND/người');
      expect(capture).toEqual({ jev: [], haiku: [] });
    },
  );
});
