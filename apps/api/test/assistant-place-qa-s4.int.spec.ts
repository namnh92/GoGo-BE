import intents from '../../../libs/modules/search/eval/intent-cases.vi.json';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { ASSISTANT_LLM, type AssistantLlmPort, type DecisionProviderPort } from '@gogo/providers';
import { ASSISTANT_DECISION_PROVIDER } from '../../../libs/modules/assistant/application/assistant.config';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import {
  startAssistantFixture,
  parseSse,
  type AssistantFixture,
} from './support/assistant-fixture';
import { placeNameKeyIndex } from './support/place-name-key';
import s3 from '../../../libs/modules/assistant/eval/place-qa-cases.vi.json';
import s4 from '../../../libs/modules/assistant/eval/place-qa-cases.s4.vi.json';
const corpus = {
  clock: s4.clock,
  cases: [...s3.cases.filter((c) => s4.coreS3Ids.includes(c.id)), ...s4.cases],
};
import catalogue from '../../../libs/modules/assistant/eval/place-qa-fixtures.json';
import { stripVolatile } from '../../../libs/modules/shared/test-support/strip-volatile';

/** Layer A, not a resolver/producer simulation. Real API/auth/admission/modules,
 * Testcontainers PostGIS, SQL catalogue/facts, runner, SSE/replay and history.
 * Only paid model adapters and the clock are deterministic test fixtures.
 * Imports only symbols available on S4 base 586944a5. The allowlisted baseline
 * script copies this harness, corpora and test support, never production code.
 */
let f: AssistantFixture;
const ids: Record<string, string> = {};
const stamp = new Date('2025-02-03T10:00:00Z');
const now = Date.parse(corpus.clock);
const capture = { jev: [] as string[], haiku: [] as string[] };
let relation: 'answer_pending' | 'new_request' | 'unclear' = 'answer_pending';
let providerFailure = false;
const reports: unknown[] = [];
let account = 0;
let setupCompleted = false;

beforeAll(async () => {
  f = await startAssistantFixture({
    OPENROUTER_API_KEY: 'fixture-jev-never-sent',
    OPENROUTER_ASSISTANT_API_KEY: 'fixture-haiku-never-sent',
    // env.ts bounds: daily 0..10_000, per-minute 0..600, monthly USD >= 0.
    ASSISTANT_USER_DAILY_MAX_MESSAGES: '1000',
    ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES: '600',
    ASSISTANT_MONTHLY_MAX_USD: '100',
  });
  await placeNameKeyIndex(f.db);
  // Fix Date, preserving actual timers/socket progress. The test-only DB trigger
  // puts message ordering on the same clock (microseconds, not uuid order).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await f.db.execute(sql`create sequence qa_fixture_message_clock`);
  await f.db.execute(
    sql`create function qa_fixture_clock() returns trigger language plpgsql as $$ begin new.created_at := '2026-11-11T10:00:00Z'::timestamptz + nextval('qa_fixture_message_clock') * interval '1 microsecond'; return new; end $$`,
  );
  await f.db.execute(
    sql`create trigger qa_fixture_clock before insert on assistant_messages for each row execute function qa_fixture_clock()`,
  );
  const decisions = f.app.get<DecisionProviderPort>(ASSISTANT_DECISION_PROVIDER);
  vi.spyOn(decisions, 'decide').mockImplementation(async (req) => {
    capture.jev.push(JSON.stringify(req));
    const requestText =
      typeof req.state === 'object' && req.state !== null && !Array.isArray(req.state)
        ? String(req.state['request'] ?? '')
        : '';
    if (providerFailure) throw new Error('fixture upstream unavailable');
    return {
      model: 'fixture-jev',
      answers: {
        in_scope: { type: 'noul', noul: 0.99 },
        needs_clarification: {
          type: 'noul',
          noul: requestText.includes('Gợi ý hoạt động') ? 0.99 : 0.01,
        },
        conflicting: { type: 'noul', noul: 0.01 },
        category: {
          type: 'choice',
          choice: requestText.includes('Gợi ý hoạt động') ? 'none' : 'cafe',
        },
        occasion: { type: 'choice', choice: 'not_stated' },
        assistant_intent: { type: 'choice', choice: 'recommend_places' },
        action: {
          type: 'choice',
          choice: /^Tạo kèo/.test(requestText) ? 'create_room' : 'none',
        },
        needs_unverified_attribute: { type: 'noul', noul: 0.01 },
        turn_relation: { type: 'choice', choice: relation },
      },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  });
  const llm = f.app.get<AssistantLlmPort>(ASSISTANT_LLM);
  vi.spyOn(llm, 'stream').mockImplementation(async function* (req) {
    capture.haiku.push(JSON.stringify(req));
    if (providerFailure) throw new Error('fixture upstream unavailable');
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
        addressText: key === 'lantern' ? '12 Đường Hư Cấu' : null,
        administrativeMappingStatus: 'VERIFIED',
        administrativeDatasetVersion: f.area.datasetVersion,
        provinceCode: f.area.provinceCode,
        communeCode: f.area.communeCode,
      })
      .returning();
    ids[key] = p!.id;
  }
  await f.db.insert(schema.placePrices).values({
    placeId: ids['lantern']!,
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
      placeId: ids['lantern']!,
      dayOfWeek,
      openMinute: 540,
      closeMinute: 1380,
      source: 'editor' as const,
      verifiedAt: stamp,
    })),
  );
  await f.db.insert(schema.placeFieldProvenance).values({
    placeId: ids['lantern']!,
    field: 'address_text',
    sourceType: 'editorial',
    sourceReference: 'fictional merchant attestation',
    collectedAt: stamp,
    verifiedAt: stamp,
  });
  await f.setFlag(true);
  await flag(true);
  setupCompleted = true;
});
afterAll(async () => {
  if (process.env.PLACE_QA_REPORT)
    await writeFile(
      process.env.PLACE_QA_REPORT,
      JSON.stringify(
        {
          baseSha: process.env.PLACE_QA_BASE_SHA ?? '586944a5',
          headSha: process.env.PLACE_QA_HEAD_SHA ?? 'WORKTREE',
          baseline: process.env.PLACE_QA_BASELINE === '1',
          status: setupCompleted ? 'EXECUTED' : 'BLOCKED_SETUP',
          fixture: catalogue.version,
          clock: corpus.clock,
          cases: reports,
        },
        null,
        2,
      ),
    );
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f?.close();
});
async function flag(enabled: boolean) {
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
async function conversation() {
  // Each case gets a distinct account, so the fixed clock cannot accumulate
  // the whole corpus against one user's per-minute or daily allowance.
  const token = await f.register(`qa-s4-${++account}@example.test`);
  const c = await f.inject({
    method: 'POST',
    url: '/v1/assistant/conversations',
    token,
    payload: { title: 'S3 fictional fixture' },
  });
  expect(c.statusCode, 'fixture conversation/admission must work; errors are BLOCKED proof').toBe(
    201,
  );
  return { token, id: c.json().id as string };
}
async function turn(
  c: { token: string; id: string },
  text: string,
  extra: Record<string, unknown> = {},
) {
  const res = await f.inject({
    method: 'POST',
    url: `/v1/assistant/conversations/${c.id}/messages`,
    token: c.token,
    headers: { 'idempotency-key': randomUUID() },
    payload: { text, ...extra },
  });
  expect(res.statusCode, 'send/admission failure is BLOCKED proof, never FAIL-before').toBe(202);
  const id = res.json().assistantMessage.id as string;
  const streamed = await f.sse(
    `/v1/assistant/conversations/${c.id}/messages/${id}/stream`,
    c.token,
  );
  expect(streamed.status).toBe(200);
  const frames = parseSse(streamed.body);
  const history = await f.inject({
    method: 'GET',
    url: `/v1/assistant/conversations/${c.id}/messages?limit=50`,
    token: c.token,
  });
  expect(history.statusCode).toBe(200);
  const message = history.json().items.find((m: { id: string }) => m.id === id);
  // SSE completion deliberately precedes financial finality. Wait for the
  // existing runner's ledger write; do not mistake a transient reservation for
  // a non-zero model cost or bypass settlement to make the assertion pass.
  for (let n = 0; n < 100; n++) {
    const ledger = await f.db.execute(
      sql`select status from assistant_usage_ledger where message_id=${id}`,
    );
    if (ledger.rows[0]?.status !== 'accepted') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const stored = await f.app.get(AssistantRepository).findMessageById(id);
  return {
    id,
    frames,
    message,
    stored,
    text: frames
      .filter((f) => f.event === 'delta')
      .map((f) => f.data.text)
      .join(''),
  };
}
function resetCapture() {
  capture.jev.length = 0;
  capture.haiku.length = 0;
}

describe('layer A S4 234 core and scenario cells — public send → SSE → history', () => {
  for (const c of corpus.cases)
    it(c.id, async () => {
      await flag(true);
      vi.setSystemTime(now);
      providerFailure = false;
      const conv = await conversation();
      resetCapture();
      const extra = c.fixture.contextPlace
        ? { context: { placeId: ids[c.fixture.contextPlace]! } }
        : {};
      let phase = 'request';
      const category =
        'category' in c && c.category === 'incident'
          ? 'incident'
          : c.slice === 'S3' || c.expected.outcome === 'not_qa'
            ? 'preservation'
            : 'capability';
      try {
        let previous: Awaited<ReturnType<typeof turn>> | undefined;
        for (const text of c.fixture.priorTurns as string[]) previous = await turn(conv, text);
        const selection = 'selection' in c ? c.selection : undefined;
        const groups =
          previous?.frames
            .filter((frame) => frame.event === 'follow_ups')
            .flatMap((frame) => frame.data.groups) ?? [];
        const option = selection
          ? groups
              .flatMap((g: { options: { id: string; label: string }[] }) => g.options)
              .find((o: { label: string }) => o.label === selection.label)
          : undefined;
        const control = selection
          ? { replyToMessageId: previous!.id, followUpOptionId: option?.id }
          : {};
        if (selection) expect(option, 'required source-bound consumer option').toBeDefined();
        resetCapture();
        const r = await turn(conv, c.text, { ...extra, ...control });
        phase = 'symptom';
        // Baseline incident assertions begin at the observed user-facing symptom,
        // before checking any new trace/ledger capability.
        if (c.expected.outcome === 'not_qa') expect(r.stored?.trace?.route).not.toBe('place_qa');
        else {
          if ('contains' in c.expected) expect(r.text).toContain(c.expected.contains);
          phase = 'public_contract';
          expect(r.message.text).toBe(r.text);
          if ('candidateKeys' in c) {
            const actual = r.frames
              .filter((f) => f.event === 'card')
              .map((f) => f.data.card.placeId)
              .sort();
            expect(actual).toEqual(c.candidateKeys.map((key) => ids[key]!).sort());
            // §4.3 row 5 keeps every top-three fuzzy candidate. The two
            // common-prefix candidates tie; UUID order cannot be hard-coded.
            if (c.expected.outcome === 'confirm')
              expect(r.frames.find((f) => f.event === 'card')?.data.card.placeId).toBe(
                ids[c.expected.places[0]!]!,
              );
          } else if (c.expected.places.length) {
            expect(
              r.frames
                .filter((f) => f.event === 'card')
                .map((f) => f.data.card.placeId)
                .sort(),
            ).toEqual(
              c.expected.outcome === 'choice'
                ? c.expected.places.map((key) => ids[key]!).sort()
                : c.expected.places.map((key) => ids[key]!).sort(),
            );
          }
          expect(r.frames.some((f) => f.event === 'proposal')).toBe(false);
          expect(
            r.frames
              .filter((f) => f.event === 'follow_ups')
              .flatMap((f) => f.data.groups)
              .some((g: { field: string }) => ['area', 'budget', 'activity'].includes(g.field)),
          ).toBe(false);
          phase = 'qa_contract';
          expect(r.stored?.trace?.route).toBe('place_qa');
          expect((r.stored?.trace?.placeQa as { outcome: string }).outcome).toBe(
            c.expected.outcome,
          );
          expect(capture).toEqual({ jev: [], haiku: [] });
          expect(
            stripVolatile(JSON.stringify([r.stored?.text, r.stored?.frames, r.stored?.trace])),
          ).not.toMatch(/Quán Sao Lạ|12[.,]?000|12 Đường Hư Cấu/);
          expect(r.text).not.toMatch(/[\uE000\uE001]/u);
          const ledger = await f.db.execute(
            sql`select u.*, (select count(*)::int from assistant_usage_calls c where c.usage_ledger_id=u.id) as attempts from assistant_usage_ledger u where message_id=${r.id}`,
          );
          expect(ledger.rows[0]).toMatchObject({ jev_calls: 0, haiku_calls: 0, attempts: 0 });
          expect(Number(ledger.rows[0]!.jev_cost_usd)).toBe(0);
          expect(ledger.rows[0]!.jev_cost_usd).not.toBeNull();
          expect(ledger.rows[0]!.haiku_upstream_cost_usd).not.toBeNull();
          expect(Number(ledger.rows[0]!.haiku_upstream_cost_usd)).toBe(0);
          expect(ledger.rows[0]!.haiku_openrouter_cost_usd).not.toBeNull();
          expect(Number(ledger.rows[0]!.haiku_openrouter_cost_usd)).toBe(0);
          expect(ledger.rows[0]!.cost_finalized_at).not.toBeNull();
        }
        reports.push({
          id: c.id,
          category,
          partition: c.partition,
          expected: c.expected.outcome,
          result: 'PASS',
        });
      } catch (error) {
        reports.push({
          id: c.id,
          category,
          phase,
          partition: c.partition,
          expected: c.expected.outcome,
          result: 'FAIL',
          assertion: error instanceof Error ? error.message : 'assertion',
        });
        throw error;
      }
    });
});

describe('S4 manifest', () => {
  it('has disjoint 234 core cases including eight comparisons', () => {
    expect(s4.coreS3Ids.length + s4.coreS4Ids.length).toBe(234);
    expect(new Set([...s4.coreS3Ids, ...s4.coreS4Ids]).size).toBe(234);
    expect(s4.cases.filter((c) => c.bucket === 'compare')).toHaveLength(8);
  });
});

function options(r: Awaited<ReturnType<typeof turn>>) {
  return r.frames
    .filter((frame) => frame.event === 'follow_ups')
    .flatMap((frame) => frame.data.groups)
    .flatMap((g: { options: { id: string; label: string; text: string }[] }) => g.options) as {
    id: string;
    label: string;
    text: string;
  }[];
}
async function scenario(
  id: string,
  run: (c: Awaited<ReturnType<typeof conversation>>) => Promise<void>,
) {
  try {
    await flag(true);
    vi.setSystemTime(now);
    await run(await conversation());
    reports.push({ id, category: 'capability', result: 'PASS' });
  } catch (error) {
    reports.push({
      id,
      category: 'capability',
      result: 'FAIL',
      phase: setupCompleted ? 'symptom' : 'setup',
      assertion: error instanceof Error ? error.message : 'assertion',
    });
    throw error;
  } finally {
    vi.setSystemTime(now);
    if (f) await flag(true);
  }
}
describe('S4 public consumer and lifecycle matrix', () => {
  it('compare retains the identified partner through a structured branch selection', () =>
    scenario('s4-state-compare-choice', async (c) => {
      const choice = await turn(c, 'So sánh Quán Sao Lạ với Song Ngọc về giá');
      resetCapture();
      const r = await turn(c, '1', {
        replyToMessageId: choice.id,
        followUpOptionId: options(choice)[0]!.id,
      });
      expect(r.text).toContain('12.000');
      expect(r.message.cards).toHaveLength(2);
      expect(new Set(r.message.cards.map((c: { placeId: string }) => c.placeId)).size).toBe(2);
      expect((r.stored?.trace?.placeQa as { topic: string }).topic).toBe('price');
      expect(capture).toEqual({ jev: [], haiku: [] });
    }));
  it('old topic selection after a superseding turn stays neutral', () =>
    scenario('s4-state-topic-superseded', async (c) => {
      const first = await turn(c, 'Quán Sao Lạ giá bao nhiêu?');
      await turn(c, 'Thông tin về Quán Không Giá');
      resetCapture();
      const r = await turn(c, 'Giờ mở cửa', {
        replyToMessageId: first.id,
        followUpOptionId: options(first)[0]!.id,
      });
      expect((r.stored?.trace?.placeQa as { outcome: string }).outcome).toBe('stale_choice');
      expect(r.message.cards).toEqual([]);
      expect(capture).toEqual({ jev: [], haiku: [] });
    }));
  for (const mode of ['typed', 'structured']) {
    it(`disabled ${mode} topic cannot resume recommendations`, () =>
      scenario(`s4-state-topic-disabled-${mode}`, async (c) => {
        const first = await turn(c, 'Quán Sao Lạ giá bao nhiêu?');
        await flag(false);
        resetCapture();
        const option = options(first)[0]!;
        const r = await turn(
          c,
          option.text,
          mode === 'structured' ? { replyToMessageId: first.id, followUpOptionId: option.id } : {},
        );
        expect((r.stored?.trace?.placeQa as { outcome: string }).outcome).toBe('disabled');
        expect(capture).toEqual({ jev: [], haiku: [] });
      }));
  }
  it('deleted previous-card source invalidates its later branch selection', () =>
    scenario('s4-state-card-source-deleted', async (c) => {
      const source = await turn(c, 'So sánh Quán Sao Lạ với Quán Không Giá');
      const choice = await turn(c, 'Quán này ở đâu?');
      await f.db.delete(schema.assistantMessages).where(eq(schema.assistantMessages.id, source.id));
      resetCapture();
      const r = await turn(c, '1', {
        replyToMessageId: choice.id,
        followUpOptionId: options(choice)[0]!.id,
      });
      expect((r.stored?.trace?.placeQa as { outcome: string }).outcome).toBe('stale_choice');
      expect(capture).toEqual({ jev: [], haiku: [] });
    }));
  it('lost topic eligibility suppresses history chips and makes selection stale', () =>
    scenario('s4-state-topic-policy-changed', async (c) => {
      const first = await turn(c, 'Quán Sao Lạ giá bao nhiêu?');
      const option = options(first).find((o) => o.label === 'Giờ mở cửa')!;
      await f.db
        .update(schema.placeHours)
        .set({ verifiedAt: null })
        .where(eq(schema.placeHours.placeId, ids['lantern']!));
      try {
        const history = await f.inject({
          method: 'GET',
          url: `/v1/assistant/conversations/${c.id}/messages?limit=50`,
          token: c.token,
        });
        expect(
          history
            .json()
            .items.find((m: { id: string }) => m.id === first.id)
            .followUps.flatMap((g: { options: { label: string }[] }) => g.options)
            .some((o: { label: string }) => o.label === option.label),
        ).toBe(false);
        const r = await turn(c, option.text, {
          replyToMessageId: first.id,
          followUpOptionId: option.id,
        });
        expect((r.stored?.trace?.placeQa as { outcome: string }).outcome).toBe('stale_choice');
        expect(r.message.cards).toEqual([]);
      } finally {
        await f.db
          .update(schema.placeHours)
          .set({ verifiedAt: stamp })
          .where(eq(schema.placeHours.placeId, ids['lantern']!));
      }
    }));
  it('expires topic state without extending its lifetime', () =>
    scenario('s4-state-topic-expired', async (c) => {
      const first = await turn(c, 'Quán Sao Lạ giá bao nhiêu?');
      // Age the stored topic state instead of moving the clock: a clock jump
      // past the access-token lifetime turns the send into a 401, not a proof.
      const qa = first.stored!.trace!.placeQa as {
        pending: { createdAt: string; expiresAt: string };
      };
      expect(qa.pending).toBeDefined();
      const ttl = Date.parse(qa.pending.expiresAt) - Date.parse(qa.pending.createdAt);
      qa.pending.createdAt = new Date(now - ttl).toISOString();
      qa.pending.expiresAt = new Date(now).toISOString();
      await f.db.execute(
        sql`update assistant_messages set trace=jsonb_set(trace,'{placeQa}',${JSON.stringify(qa)}::jsonb) where id=${first.id}`,
      );
      const r = await turn(c, options(first)[0]!.text, {
        replyToMessageId: first.id,
        followUpOptionId: options(first)[0]!.id,
      });
      expect((r.stored?.trace?.placeQa as { outcome: string }).outcome).toBe('stale_choice');
    }));
});
// vi-065 is named-place QA; the remaining 156 cases preserve recommendation admission.
// These preservation assertions run on BOTH base and head, unlike S3-only state tests.
async function recordIntentCase(id: string, category: string, check: () => Promise<void>) {
  try {
    await check();
    reports.push({ id, category, result: 'PASS' });
  } catch (error) {
    reports.push({
      id,
      category,
      result: 'FAIL',
      phase: 'admission',
      assertion: error instanceof Error ? error.message : 'assertion',
    });
    throw error;
  }
}
describe('owner-approved intent admission: 156 preserved + vi-065 QA', () => {
  for (const c of intents.cases.filter((c) => c.id !== 'vi-065'))
    it(`preserve-${c.id}`, () =>
      recordIntentCase(`preserve-${c.id}`, 'preservation', async () => {
        vi.setSystemTime(now);
        providerFailure = false;
        relation = 'answer_pending';
        const conv = await conversation();
        await flag(true);
        const r = await turn(conv, c.text);
        expect(r.stored?.trace?.route).not.toBe('place_qa');
      }));
  const c = intents.cases.find((c) => c.id === 'vi-065')!;
  it('qa-vi-065-on', () =>
    recordIntentCase('qa-vi-065-on', 'capability', async () => {
      vi.setSystemTime(now);
      providerFailure = false;
      await flag(true);
      const conv = await conversation();
      resetCapture();
      const r = await turn(conv, c.text);
      expect(r.text).toContain('chưa tìm thấy');
      expect(r.stored?.trace?.route).toBe('place_qa');
      expect(r.stored?.trace?.placeQa).toMatchObject({ topic: 'hours', outcome: 'not_found' });
      expect(capture).toEqual({ jev: [], haiku: [] });
      const ledger = await f.db.execute(sql`select u.jev_calls, u.haiku_calls,
      (select count(*)::int from assistant_usage_calls c where c.usage_ledger_id=u.id) as attempts
      from assistant_usage_ledger u where message_id=${r.id}`);
      expect(ledger.rows[0]).toMatchObject({ jev_calls: 0, haiku_calls: 0, attempts: 0 });
    }));
  it('preserve-vi-065-off', () =>
    recordIntentCase('preserve-vi-065-off', 'preservation', async () => {
      vi.setSystemTime(now);
      providerFailure = false;
      relation = 'answer_pending';
      await flag(false);
      const conv = await conversation();
      resetCapture();
      const r = await turn(conv, c.text);
      expect(r.stored?.trace?.route).not.toBe('place_qa');
      expect(capture.jev.length).toBeGreaterThan(0);
      expect(r.text.length).toBeGreaterThan(0);
    }));
});

describe('S4 request byte preservation at the public boundary', () => {
  for (const mode of ['answer_pending', 'new_request', 'unclear', 'failure'] as const)
    it(`compare and topic controls excluded on resume: ${mode}`, () =>
      recordIntentCase(`s4-bytes-${mode}`, 'preservation', async () => {
        vi.setSystemTime(now);
        await flag(true);
        relation = mode === 'failure' ? 'answer_pending' : mode;
        providerFailure = false;
        try {
          const clean = await conversation();
          const interposed = await conversation();
          await turn(clean, 'Gợi ý quán cafe ở Hà Nội');
          await turn(interposed, 'Gợi ý quán cafe ở Hà Nội');
          await turn(interposed, 'Quán Sao Lạ với Quán Không Giá quán nào rẻ hơn?');
          await turn(interposed, 'Địa chỉ');
          providerFailure = mode === 'failure';
          resetCapture();
          await turn(clean, 'Gợi ý quán cafe ở Hà Nội giá 100k');
          const expected = structuredClone(capture);
          resetCapture();
          await turn(interposed, 'Gợi ý quán cafe ở Hà Nội giá 100k');
          expect(capture).toEqual(expected);
          expect(expected.jev.length).toBeGreaterThan(0);
          expect(JSON.stringify(capture)).not.toMatch(
            /a1:|place_qa|placeQa|place_topic|topic_1|Quán Sao Lạ|Quán Không Giá/,
          );
        } finally {
          providerFailure = false;
          relation = 'answer_pending';
        }
      }));
  it('flag on/off ordinary requests are byte-identical', () =>
    recordIntentCase('s4-bytes-flag', 'preservation', async () => {
      vi.setSystemTime(now);
      const a = await conversation(),
        b = await conversation();
      resetCapture();
      await flag(false);
      await turn(a, 'Gợi ý quán cafe ở Hà Nội giá 100k');
      const off = structuredClone(capture);
      resetCapture();
      await flag(true);
      await turn(b, 'Gợi ý quán cafe ở Hà Nội giá 100k');
      expect(capture).toEqual(off);
      expect(off.jev.length).toBeGreaterThan(0);
      expect(off.haiku.length).toBeGreaterThan(0);
    }));
});
