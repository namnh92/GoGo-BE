import { APP_CONFIG } from '../../../libs/modules/shared/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { ASSISTANT_LLM, type AssistantLlmPort, type DecisionProviderPort } from '@gogo/providers';
import { ASSISTANT_DECISION_PROVIDER } from '../../../libs/modules/assistant/application/assistant.config';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { AssistantTurnRunner } from '../../../libs/modules/assistant/application/assistant-turn-runner.service';
import { PlaceQaService } from '../../../libs/modules/assistant/application/place-qa.service';
import { newTurnState } from '../../../libs/modules/assistant/application/turn-state';
import { AssistantAvailabilityService } from '../../../libs/modules/assistant/application/assistant-availability.service';
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
    // Short enough for the deadline cells; every other cell answers in well under it.
    ASSISTANT_FIRST_TEXT_TIMEOUT_MS: '4000',
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
  // Round 2 (Sol F-03 / Astra F-02): a bare text is only a name-only PROBE.
  // Nothing established QA, so an interrupted probe is an ordinary turn.
  it('a bare non-QA reply stopped before the name-only probe keeps ordinary history and continuation', async () => {
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
      expect.soft(stored?.trace?.route).toBeUndefined();
      expect.soft(stored?.trace).not.toHaveProperty('qaProbe');
      resetCapture();
      const again = await turn(c, 'Cầu Giấy');
      const history = await repo.history(c.id, again.id, 50);
      expect.soft(history.map((m) => m.id)).toContain(sent.userId);
      // The repeated reply is an ordinary continuation, not QA control.
      expect.soft(again.stored?.trace?.route).not.toBe('place_qa');
      expect.soft(again.qa).toBeUndefined();
      expect(capture.jev.length).toBeGreaterThan(0);
    } finally {
      funding.release();
      funding.restore();
      stopLocal.mockRestore();
    }
  });
});

async function qaFlag(enabled: boolean) {
  await f.db
    .insert(schema.featureFlags)
    .values({ key: 'assistant.place_qa.enabled', environment: 'all', platform: 'all', enabled })
    .onConflictDoUpdate({
      target: [
        schema.featureFlags.key,
        schema.featureFlags.environment,
        schema.featureFlags.platform,
      ],
      set: { enabled },
    });
}
/** The process "dies" right after the send commits: the runner never starts,
 * the lease lapses and the reaper (any instance) ends the turn. */
async function sendThenDie(c: Conversation, text: string, control: Record<string, unknown> = {}) {
  const runner = f.app.get(AssistantTurnRunner);
  const start = vi.spyOn(runner, 'start').mockImplementationOnce(() => undefined);
  try {
    const sent = await send(c, text, control);
    await f.db.execute(
      sql`update assistant_messages set lease_expires_at=now()-interval '1 minute' where id=${sent.id}`,
    );
    expect(await runner.reap()).toBeGreaterThan(0);
    const stored = await f.app.get(AssistantRepository).findMessageById(sent.id);
    expect(stored?.status).toBe('failed');
    return { ...sent, stored };
  } finally {
    start.mockRestore();
  }
}

describe('Sol fix round (r5): durable producer observation before dispatch', () => {
  it.each([
    [true, 'terminal'],
    [false, 'terminal'],
    [true, 'deadline'],
    [false, 'deadline'],
  ] as const)(
    'SQL keeps durable flag %s over a stale %s recovery observation',
    async (observed, recovery) => {
      const c = await conversation();
      const runner = f.app.get(AssistantTurnRunner);
      const repo = f.app.get(AssistantRepository);
      const start = vi.spyOn(runner, 'start').mockImplementationOnce(() => undefined);
      const flag = vi
        .spyOn(f.app.get(AssistantAvailabilityService), 'placeQaEnabled')
        .mockResolvedValue(!observed);
      try {
        const sent = await send(c, QUESTION);
        // Recovery may already hold this snapshot when the producer commits.
        const admitted = (await repo.findMessageById(sent.id))!;
        const input = start.mock.calls[0]![0];
        const options = { deadlineAt: Date.now() + 1500 };
        expect(await repo.persistQaEnabled(input.userId, c.id, sent.id, observed, options)).toBe(
          true,
        );
        expect(await repo.persistQaEnabled(input.userId, c.id, sent.id, !observed, options)).toBe(
          false,
        );
        if (recovery === 'deadline') {
          expect(await repo.settleQaProbe(sent.id, !observed, options)).toBe(observed);
          await runner.finalizeOrphan((await repo.findMessageById(sent.id))!, 'failed', null);
        } else await runner.finalizeOrphan(admitted, 'failed', null);
        const stored = await repo.findMessageById(sent.id);
        expect(stored?.trace?.qaEnabled).toBe(observed);
        expect(stored?.trace?.route).toBe(observed ? 'place_qa' : undefined);
        expect(stored?.trace).not.toHaveProperty('qaProbe');
      } finally {
        start.mockRestore();
        flag.mockRestore();
      }
    },
  );
  it.each(['omitted', 'changed'] as const)(
    'English Confirm chip answers with %s follow-up locale',
    async (mode) => {
      await qaFlag(true);
      const c = await conversation();
      resetCapture();
      // English factual grammar selects price; the legacy district forces a
      // confirm even for this unique exact name (rev3 §4.4).
      const confirm = await turn(c, 'Price of Quán Sao Lạ in Quận 1?', { locale: 'en' });
      expect(confirm.qa).toMatchObject({ outcome: 'confirm', topic: 'price' });
      expect(confirm.qa!.candidateIds).toEqual([ids['lantern']]);
      expect(confirm.stored?.locale).toBe('en');
      const emitted = confirm.message.followUps[0].options[0].text as string;
      expect(emitted).toMatch(/^Confirm Quán Sao Lạ · .+/u);
      expect(capture).toEqual({ jev: [], haiku: [] });
      const answered = await turn(c, emitted, mode === 'changed' ? { locale: 'vi' } : {});
      expect(answered.qa).toMatchObject({ outcome: 'answer', topic: 'price' });
      expect(answered.qa!.candidateIds).toEqual([ids['lantern']]);
      expect(answered.stored?.locale).toBe('vi');
      expect(answered.text).toContain('12000–24000 VND/người');
      expect(capture).toEqual({ jev: [], haiku: [] });
    },
  );
  it.each([true, false])(
    'reaper uses observed flag %s after its flip, before any route/frame/provider dispatch',
    async (observed) => {
      await qaFlag(observed);
      const c = await conversation();
      const runner = f.app.get(AssistantTurnRunner);
      const repo = f.app.get(AssistantRepository);
      const start = vi.spyOn(runner, 'start').mockImplementationOnce(() => undefined);
      const flag = vi.spyOn(f.app.get(AssistantAvailabilityService), 'placeQaEnabled');
      const mark = vi.spyOn(repo, 'markPlaceQa');
      const persist = repo.persistQaEnabled.bind(repo);
      // Commit the observation, then kill the producer before it can use it.
      const crash = vi.spyOn(repo, 'persistQaEnabled').mockImplementationOnce(async (...args) => {
        expect(await persist(...args)).toBe(true);
        throw new Error('fixture process crash after durable flag observation');
      });
      try {
        resetCapture();
        const sent = await send(c, QUESTION);
        const input = start.mock.calls[0]![0];
        await expect(
          f.app.get(PlaceQaService).handle(
            input,
            newTurnState(),
            {
              emit: async () => {
                throw new Error('unexpected frame');
              },
            },
            new AbortController().signal,
            Date.now() + 4000,
          ),
        ).rejects.toThrow('fixture process crash after durable flag observation');
        const before = await repo.findMessageById(sent.id);
        expect(before?.trace).toMatchObject({ qaProbe: 'question', qaEnabled: observed });
        expect(before?.trace).not.toHaveProperty('route');
        expect(before?.trace).not.toHaveProperty('streamRoute');
        expect(before?.frames ?? []).toEqual([]);
        expect(mark).not.toHaveBeenCalled();
        expect(capture).toEqual({ jev: [], haiku: [] });
        const calls = await f.db.execute(sql`
          select c.call_index from assistant_usage_calls c join assistant_usage_ledger u
            on u.id=c.usage_ledger_id where u.message_id=${sent.id}`);
        expect(calls.rows).toEqual([]);
        flag.mockClear();
        await qaFlag(!observed);
        await f.db.execute(sql`
          update assistant_messages set lease_expires_at=now()-interval '1 minute'
          where id=${sent.id}`);
        expect(await runner.reap()).toBeGreaterThan(0);
        expect(flag).not.toHaveBeenCalled();
        const reaped = await repo.findMessageById(sent.id);
        expect(reaped?.status).toBe('failed');
        expect(reaped?.trace?.route).toBe(observed ? 'place_qa' : undefined);
        expect(reaped?.trace?.qaEnabled).toBe(observed);
        expect(reaped?.trace).not.toHaveProperty('qaProbe');
        const { next, expected, seen } = await followingRecommendation(c);
        const historyIds = (await repo.history(c.id, next.id, 50)).map((m) => m.id);
        expect(historyIds.includes(sent.userId)).toBe(!observed);
        // The crashed assistant is empty; only the ordinary user row is history.
        expect(historyIds).not.toContain(sent.id);
        if (observed) {
          expect(seen).toEqual(expected);
          expect(JSON.stringify(seen)).not.toContain(QUESTION);
        } else expect(JSON.stringify(seen)).toContain(QUESTION);
      } finally {
        start.mockRestore();
        flag.mockRestore();
        mark.mockRestore();
        crash.mockRestore();
        await qaFlag(true);
      }
    },
  );
});

describe('Round 2 — Sol F-02 / Astra F-01: the send-commit → fence crash window', () => {
  it.each(['question', 'typed reply to the latest QA turn', 'structured control'] as const)(
    'a %s whose process dies before any fence write stays out of history and model requests',
    async (kind) => {
      await qaFlag(true);
      const c = await conversation();
      const repo = f.app.get(AssistantRepository);
      const handle = vi.spyOn(f.app.get(PlaceQaService), 'handle');
      try {
        let text = QUESTION;
        let control: Record<string, unknown> = {};
        const earlier: string[] = [];
        if (kind !== 'question') {
          const choice = await turn(c, 'Song Ngọc giá bao nhiêu?');
          expect(choice.qa).toMatchObject({ outcome: 'choice' });
          earlier.push(choice.userId, choice.id);
          text = kind === 'structured control' ? '1' : 'Không phải các quán này';
          if (kind === 'structured control')
            control = {
              replyToMessageId: choice.id,
              followUpOptionId: choice.message.followUps[0].options[0].id,
            };
          handle.mockClear();
        }
        const dead = await sendThenDie(c, text, control);
        expect(handle).not.toHaveBeenCalled();
        expect.soft(dead.stored?.trace).toMatchObject({
          route: 'place_qa',
          questionMessageId: dead.userId,
          orphaned: true,
        });
        expect.soft(dead.stored?.trace).not.toHaveProperty('qaProbe');
        const { next, expected, seen } = await followingRecommendation(c);
        const history = await repo.history(c.id, next.id, 50);
        expect.soft(history.map((m) => m.id)).not.toContain(dead.userId);
        expect(history.map((m) => m.id)).not.toContain(dead.id);
        for (const id of earlier) expect(history.map((m) => m.id)).not.toContain(id);
        expect.soft(JSON.stringify(seen)).not.toMatch(/Quán Sao Lạ|Không phải các quán|placeQa/);
        expect(seen).toEqual(expected);
      } finally {
        handle.mockRestore();
      }
    },
  );
  it.each([
    ['QA-shaped question with the flag off', false, QUESTION],
    ['bare reply with the flag off', false, 'Cầu Giấy'],
    ['bare reply with the flag on (unqualified name probe)', true, 'Cầu Giấy'],
    ['explicit recommendation', true, 'Gợi ý quán cafe ở Hà Nội'],
  ] as const)(
    '%s that dies the same way ends unmarked and stays in history',
    async (_n, on, text) => {
      await qaFlag(on);
      try {
        const c = await conversation();
        const repo = f.app.get(AssistantRepository);
        const dead = await sendThenDie(c, text);
        expect(dead.stored?.trace?.route).toBeUndefined();
        expect(dead.stored?.trace).not.toHaveProperty('qaProbe');
        const next = await turn(c, RECOMMEND);
        expect((await repo.history(c.id, next.id, 50)).map((m) => m.id)).toContain(dead.userId);
      } finally {
        await qaFlag(true);
      }
    },
  );
});

describe('Round 2 — Sol F-04 / Astra F-04: QA reads stay inside deadline and cancellation', () => {
  it.each([
    ['flag off', 'QA question', 'placeQaEnabled'],
    ['flag on', 'QA question', 'placeQaEnabled'],
    ['flag off', 'bare reply', 'latestAssistant'],
    ['flag on', 'bare reply', 'latestAssistant'],
  ] as const)('%s, %s: a stalled %s read cannot hold a Stop', async (state, what, read) => {
    await qaFlag(state === 'flag on');
    const c = await conversation();
    const repo = f.app.get(AssistantRepository);
    const runner = f.app.get(AssistantTurnRunner);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const stall = async <T>(real: () => Promise<T>): Promise<T> => {
      entered = true;
      await gate;
      return real();
    };
    const availability = f.app.get(AssistantAvailabilityService);
    const realFlag = availability.placeQaEnabled.bind(availability);
    const realLatest = repo.latestAssistant.bind(repo);
    const spy =
      read === 'placeQaEnabled'
        ? vi
            .spyOn(availability, 'placeQaEnabled')
            .mockImplementationOnce((...a) => stall(() => realFlag(...a)))
        : vi
            .spyOn(repo, 'latestAssistant')
            .mockImplementationOnce((...a) => stall(() => realLatest(...a)));
    try {
      const sent = await send(c, what === 'QA question' ? QUESTION : 'Cầu Giấy');
      await until(() => entered);
      const startedAt = Date.now();
      const stopped = await f.inject({
        method: 'POST',
        url: `/v1/assistant/conversations/${c.id}/messages/${sent.id}/stop`,
        token: c.token,
      });
      expect(stopped.statusCode).toBeLessThan(300);
      // The read is still stalled: the turn ended without waiting for it.
      const stored = await repo.findMessageById(sent.id);
      expect.soft(stored?.status).toBe('stopped');
      expect.soft(Date.now() - startedAt).toBeLessThan(4_000);
      // Cancellation before the first flag decision defaults disabled.
      {
        expect.soft(stored?.trace?.route).toBeUndefined();
        expect.soft(stored?.trace).not.toHaveProperty('qaProbe');
      }
      release();
      await until(() => !runner.isRunningHere(sent.id));
    } finally {
      release();
      spy.mockRestore();
      await qaFlag(true);
    }
  });
});

describe('Round 2 — first-text deadline with the QA decision still open', () => {
  it.each([
    ['flag on', 'QA question', 'placeQaEnabled', 'ordinary'],
    ['flag on', 'typed reply to the latest QA turn', 'latestAssistant', 'qa'],
    ['flag off', 'bare reply', 'placeQaEnabled', 'ordinary'],
    ['flag on', 'bare reply', 'latestAssistant', 'ordinary'],
  ] as const)(
    '%s, %s: a %s read stalled past the deadline ends %s, never an unfenced QA pair',
    async (state, what, read, expected) => {
      await qaFlag(true);
      const c = await conversation();
      const repo = f.app.get(AssistantRepository);
      const runner = f.app.get(AssistantTurnRunner);
      const earlier: string[] = [];
      let text: string = what === 'QA question' ? QUESTION : 'Cầu Giấy';
      if (what === 'typed reply to the latest QA turn') {
        const choice = await turn(c, 'Song Ngọc giá bao nhiêu?');
        earlier.push(choice.userId);
        text = 'Không phải các quán này';
      }
      await qaFlag(state === 'flag on');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const availability = f.app.get(AssistantAvailabilityService);
      const realFlag = availability.placeQaEnabled.bind(availability);
      const realLatest = repo.latestAssistant.bind(repo);
      const spy =
        read === 'placeQaEnabled'
          ? vi.spyOn(availability, 'placeQaEnabled').mockImplementationOnce(async (...a) => {
              await gate;
              return realFlag(...a);
            })
          : vi.spyOn(repo, 'latestAssistant').mockImplementationOnce(async (...a) => {
              await gate;
              return realLatest(...a);
            });
      try {
        const sent = await send(c, text);
        // No Stop: only the first-text deadline (4 s here) ends the stage.
        await until(
          async () => (await repo.findMessageById(sent.id))?.status !== 'streaming',
          15_000,
        );
        const stored = await repo.findMessageById(sent.id);
        expect.soft(stored?.trace).not.toHaveProperty('qaProbe');
        release();
        await until(() => !runner.isRunningHere(sent.id));
        if (expected === 'qa') {
          expect.soft(stored?.status).toBe('failed');
          expect.soft(stored?.trace).toMatchObject({ route: 'place_qa' });
          const { next, expected: clean, seen } = await followingRecommendation(c);
          const history = await repo.history(c.id, next.id, 50);
          expect.soft(history.map((m) => m.id)).not.toContain(sent.userId);
          for (const id of earlier) expect(history.map((m) => m.id)).not.toContain(id);
          expect.soft(JSON.stringify(seen)).not.toMatch(/Quán Sao Lạ|Không phải các quán|placeQa/);
          expect(seen).toEqual(clean);
        } else {
          // The ordinary deterministic timeout reply, exactly as before S3.
          expect.soft(stored?.trace?.route).not.toBe('place_qa');
          if (read === 'latestAssistant') {
            expect.soft(stored?.status).toBe('fallback');
            expect.soft(stored?.notice).toMatchObject({ kind: 'fallback', reason: 'timeout' });
          } else expect(stored?.status).not.toBe('failed');
          const next = await turn(c, RECOMMEND);
          expect((await repo.history(c.id, next.id, 50)).map((m) => m.id)).toContain(sent.userId);
        }
      } finally {
        release();
        spy.mockRestore();
        await qaFlag(true);
      }
    },
  );
});

describe('Round 2 — terminal recovery is bounded and never promotes an ordinary turn', () => {
  it('a QA flag read that never returns cannot hold a Stop; unknown defaults disabled', async () => {
    await qaFlag(true);
    const c = await conversation();
    const repo = f.app.get(AssistantRepository);
    const runner = f.app.get(AssistantTurnRunner);
    const availability = f.app.get(AssistantAvailabilityService);
    let entered = false;
    const spy = vi.spyOn(availability, 'placeQaEnabled').mockImplementation(() => {
      entered = true;
      return new Promise<boolean>(() => {});
    });
    try {
      const sent = await send(c, QUESTION);
      await until(() => entered);
      const startedAt = Date.now();
      const stopped = await f.inject({
        method: 'POST',
        url: `/v1/assistant/conversations/${c.id}/messages/${sent.id}/stop`,
        token: c.token,
      });
      expect(stopped.statusCode).toBeLessThan(300);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      const stored = await repo.findMessageById(sent.id);
      expect(stored?.status).toBe('stopped');
      expect(stored?.trace).toMatchObject({ questionMessageId: sent.userId });
      expect(stored?.trace?.route).toBeUndefined();
      expect(stored?.trace).not.toHaveProperty('qaProbe');
      await until(() => !runner.isRunningHere(sent.id));
    } finally {
      spy.mockRestore();
    }
  });
  it('a question that already ran the ordinary path with the flag off is not promoted when the flag flips', async () => {
    await qaFlag(false);
    try {
      const c = await conversation();
      const repo = f.app.get(AssistantRepository);
      const runner = f.app.get(AssistantTurnRunner);
      resetCapture();
      const ordinary = await turn(c, QUESTION);
      const route = ordinary.stored?.trace?.route;
      expect(route).not.toBe('place_qa');
      expect(ordinary.stored?.trace).not.toHaveProperty('qaProbe');
      expect(capture.jev.length).toBeGreaterThan(0);
      // Its process "died" after dispatch, before the terminal write.
      await f.db.execute(
        sql`update assistant_messages set status='streaming', lease_expires_at=now()-interval '1 minute',
          trace = trace || '{"qaProbe":"question"}'::jsonb where id=${ordinary.id}`,
      );
      await qaFlag(true);
      expect(await runner.reap()).toBeGreaterThan(0);
      const reaped = await repo.findMessageById(ordinary.id);
      expect(reaped?.trace?.route).toBe(route);
      expect(reaped?.trace?.streamRoute).toBe('ordinary');
      expect(reaped?.trace).not.toHaveProperty('qaProbe');
    } finally {
      await qaFlag(true);
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
    const ambiguous = await turn(c, confirm.message.followUps[0].options[0].text);
    expect(ambiguous.qa?.outcome).not.toBe('answer');
    // Restore a fresh source-bound choice for structured clients.
    const fresh = await turn(c, 'Song Ngọc giá bao nhiêu?');
    const answered = await turn(c, '1', {
      replyToMessageId: fresh.id,
      followUpOptionId: fresh.message.followUps[0].options[0].id,
    });
    expect(answered.qa).toMatchObject({
      outcome: 'answer',
      topic: 'price',
      candidateIds: confirm.qa!.candidateIds,
    });
    expect(answered.text).toContain('VND/người');
    expect(answered.stored?.status).toBe('complete');
    expect(capture).toEqual({ jev: [], haiku: [] });
  });
  it('a stale ordinal from the earlier choice never confirms the other branch (round 2)', async () => {
    const c = await conversation();
    resetCapture();
    const choice = await turn(c, 'Song Ngọc giá bao nhiêu?');
    const options = choice.message.followUps[0].options;
    expect(options.map((o: { text: string }) => o.text).slice(0, 2)).toEqual(['1', '2']);
    const confirmB = await turn(c, options[1].text);
    expect(confirmB.qa).toMatchObject({ outcome: 'confirm' });
    const [b] = confirmB.qa!.candidateIds;
    expect(b).toBe(choice.qa!.candidateIds[1]);
    // The old client taps branch A's chip of the EARLIER message: text "1".
    const stale = await turn(c, options[0].text);
    expect(stale.qa?.outcome).not.toBe('answer');
    expect(stale.text).not.toContain('VND');
    expect(stale.qa).toMatchObject({ outcome: 'confirm', candidateIds: [b] });
    // The emitted confirm text names the candidate and is not a bare ordinal.
    const emitted = stale.message.followUps[0].options[0].text as string;
    expect(emitted).toContain('Song Ngọc');
    expect(emitted).not.toMatch(/^\d+$/);
    const ambiguous = await turn(c, emitted);
    expect(ambiguous.qa?.outcome).not.toBe('answer');
    expect(ambiguous.text).not.toContain('VND');
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

describe('Astra amendment — public/SQL release cells', () => {
  it.each(['Cafe Gợi Ý Quán Ngon', 'Nhà hàng Tìm Quán Cafe'])(
    'A1 initial question for %s never calls a model',
    async (name) => {
      const [place] = await f.db
        .insert(schema.places)
        .values({
          name,
          nameNormalized: 'trigger',
          status: 'published',
          geom: { x: 105.79, y: 21.03 },
        })
        .returning();
      try {
        const c = await conversation();
        resetCapture();
        const asked = await turn(c, `${name} giá bao nhiêu?`);
        expect(asked.stored?.trace?.route).toBe('place_qa');
        expect(asked.qa?.candidateIds).toEqual([place!.id]);
        expect(capture).toEqual({ jev: [], haiku: [] });
      } finally {
        await f.db.execute(sql`delete from places where id=${place!.id}`);
      }
    },
  );
  it.each([false, true])(
    'A3 ordinary traffic skips rejected/stalled QA reads, flag %s',
    async (enabled) => {
      await qaFlag(enabled);
      const c = await conversation();
      const availability = f.app.get(AssistantAvailabilityService);
      const repo = f.app.get(AssistantRepository);
      const flag = vi
        .spyOn(availability, 'placeQaEnabled')
        .mockRejectedValue(new Error('fixture unavailable'));
      const latest = vi
        .spyOn(repo, 'latestAssistant')
        .mockImplementation(() => new Promise(() => {}));
      try {
        const ordinary = await turn(c, RECOMMEND);
        expect(ordinary.stored?.status).toBe('complete');
        expect(ordinary.stored?.trace?.route).not.toBe('place_qa');
        expect(flag).not.toHaveBeenCalled();
        expect(latest).not.toHaveBeenCalled();
      } finally {
        flag.mockRestore();
        latest.mockRestore();
        await qaFlag(true);
      }
    },
  );
  it('A4 new admission → legacy finalization requires marker-aware readers (pre-floor predicate leaks)', async () => {
    const c = await conversation();
    const repo = f.app.get(AssistantRepository);
    const start = vi
      .spyOn(f.app.get(AssistantTurnRunner), 'start')
      .mockImplementationOnce(() => undefined);
    let sent: Awaited<ReturnType<typeof send>>;
    try {
      sent = await send(c, QUESTION);
    } finally {
      start.mockRestore();
    }
    expect((await repo.findMessageById(sent.id))?.trace?.qaProbe).toBe('question');
    // Legacy terminal-write semantics: merge trace, no probe interpretation.
    await f.db.execute(
      sql`update assistant_messages set status='failed', completed_at=now(), lease_owner=null, lease_expires_at=null, trace=trace || '{"orphaned":true}'::jsonb where id=${sent.id}`,
    );
    await repo.closeLedgerForMessage(sent.id);
    const legacy = await f.db.execute(
      sql`select u.id from assistant_messages u where u.id=${sent.userId} and not exists(select 1 from assistant_messages qa where qa.conversation_id=u.conversation_id and qa.trace->>'route'='place_qa' and qa.trace->>'questionMessageId'=u.id::text)`,
    );
    expect(legacy.rows.map((r) => r.id)).toContain(sent.userId);
    const { next, expected, seen } = await followingRecommendation(c);
    expect((await repo.history(c.id, next.id, 50)).map((r) => r.id)).not.toContain(sent.userId);
    expect(await repo.episodeMessages(c.id, [sent.userId])).toEqual([]);
    expect(seen).toEqual(expected);
  });
  it.each([
    [false, 'Stop'],
    [true, 'Stop'],
    [false, 'ceiling'],
    [true, 'ceiling'],
  ] as const)(
    'A5 flag %s: stalled deadline settlement + %s retains uncertain exclusion',
    async (enabled, ending) => {
      await qaFlag(true);
      const c = await conversation();
      await turn(c, 'Song Ngọc giá bao nhiêu?');
      await qaFlag(enabled);
      const repo = f.app.get(AssistantRepository);
      const runner = f.app.get(AssistantTurnRunner);
      const config = f.app.get<{ ASSISTANT_REPLY_MAX_MS: number }>(APP_CONFIG);
      const ceilingBefore = config.ASSISTANT_REPLY_MAX_MS;
      if (ending === 'ceiling') config.ASSISTANT_REPLY_MAX_MS = 5000;
      const latest = vi
        .spyOn(repo, 'latestAssistant')
        .mockImplementationOnce(() => new Promise(() => {}));
      let entered = false;
      let cleanupSignal: AbortSignal | undefined;
      const settle = vi
        .spyOn(repo, 'settleQaProbe')
        .mockImplementationOnce(async (_id, _enabled, options) => {
          entered = true;
          cleanupSignal = options?.signal;
          return new Promise(() => {});
        });
      try {
        const sent = await send(c, 'Không phải các quán này');
        await until(() => entered);
        const at = Date.now();
        if (ending === 'Stop') await runner.stopLocal(sent.id);
        else await until(() => !runner.isRunningHere(sent.id), 3000);
        expect(Date.now() - at).toBeLessThan(1500);
        expect(cleanupSignal?.aborted).toBe(true);
        const stopped = await repo.findMessageById(sent.id);
        expect(stopped?.status).toBe(ending === 'Stop' ? 'stopped' : 'truncated');
        expect(stopped?.trace?.route).toBeUndefined();
        expect(stopped?.trace?.qaProbe).toBeDefined();
        expect(await repo.episodeMessages(c.id, [sent.userId])).toEqual([]);
      } finally {
        config.ASSISTANT_REPLY_MAX_MS = ceilingBefore;
        latest.mockRestore();
        settle.mockRestore();
        await qaFlag(true);
      }
    },
  );
  it('A5 row-lock timeout cancels the UPDATE and cannot settle after the lock is released', async () => {
    const c = await conversation();
    const repo = f.app.get(AssistantRepository);
    const runner = f.app.get(AssistantTurnRunner);
    const start = vi.spyOn(runner, 'start').mockImplementationOnce(() => undefined);
    let sent: Awaited<ReturnType<typeof send>>;
    try {
      sent = await send(c, QUESTION);
    } finally {
      start.mockRestore();
    }
    const blocker = await f.db.$client.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from assistant_messages where id=$1 for update', [sent.id]);
      const at = Date.now();
      await expect(
        repo.settleQaProbe(sent.id, true, { deadlineAt: at + 100 }),
      ).rejects.toBeDefined();
      expect(Date.now() - at).toBeLessThan(1500);
      await blocker.query('rollback');
      expect((await repo.findMessageById(sent.id))?.trace?.qaProbe).toBe('question');
      await runner.finalizeOrphan((await repo.findMessageById(sent.id))!, 'stopped', null);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });
  it('A6 failed flag read after send/crash defaults disabled on reaper recovery', async () => {
    await qaFlag(false);
    const c = await conversation();
    const flag = vi
      .spyOn(f.app.get(AssistantAvailabilityService), 'placeQaEnabled')
      .mockRejectedValue(new Error('fixture flag failure'));
    try {
      const dead = await sendThenDie(c, QUESTION);
      expect(dead.stored?.trace?.route).toBeUndefined();
      expect(dead.stored?.trace).not.toHaveProperty('qaProbe');
      const next = await turn(c, RECOMMEND);
      expect(
        (await f.app.get(AssistantRepository).history(c.id, next.id, 50)).map((m) => m.id),
      ).toContain(dead.userId);
    } finally {
      flag.mockRestore();
      await qaFlag(true);
    }
  });
});
