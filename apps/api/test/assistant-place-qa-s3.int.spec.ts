import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { ASSISTANT_LLM, type AssistantLlmPort, type DecisionProviderPort } from '@gogo/providers';
import { ASSISTANT_DECISION_PROVIDER } from '../../../libs/modules/assistant/application/assistant.config';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { emptyCosts } from '../../../libs/modules/assistant/application/turn-state';
import { AssistantTurnRunner } from '../../../libs/modules/assistant/application/assistant-turn-runner.service';
import {
  firstPending,
  chipsFor,
  applyChip,
  type ReconciledRequest,
} from '../../../libs/modules/assistant/domain/reconcile';
import intents from '../../../libs/modules/search/eval/intent-cases.vi.json';
import { SearchService } from '../../../libs/modules/search/application/search.service';
import {
  startAssistantFixture,
  parseSse,
  type AssistantFixture,
} from './support/assistant-fixture';
import { placeNameKeyIndex } from './support/place-name-key';
import corpus from '../../../libs/modules/assistant/eval/place-qa-cases.vi.json';
import catalogue from '../../../libs/modules/assistant/eval/place-qa-fixtures.json';

/** Layer A, not a resolver/producer simulation. Real API/auth/admission/modules,
 * Testcontainers PostGIS, SQL catalogue/facts, runner, SSE/replay and history.
 * Only paid model adapters and the clock are deterministic test fixtures.
 * Imports only symbols available on base d2d41184. The allowlisted baseline
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
          baseSha: process.env.PLACE_QA_BASE_SHA ?? 'd2d41184',
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
  const token = await f.register(`qa-s3-${++account}@example.test`);
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
const baseline = process.env.PLACE_QA_BASELINE === '1';

describe('layer A S3 corpus — public send → SSE → history', () => {
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
        'incidentRegression' in c && c.incidentRegression
          ? 'incident'
          : c.expected.outcome === 'not_qa'
            ? 'preservation'
            : 'capability';
      try {
        const r = await turn(conv, c.text, extra);
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
              r.frames.filter((f) => f.event === 'card').map((f) => f.data.card.placeId),
            ).toEqual(c.expected.places.map((key) => ids[key]!));
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
          expect(JSON.stringify([r.stored?.text, r.stored?.frames, r.stored?.trace])).not.toMatch(
            /Quán Sao Lạ|12000|12 Đường Hư Cấu/,
          );
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

describe.skipIf(baseline)('S3 history, control, failure and cost isolation', () => {
  it.each(['answer_pending', 'new_request', 'unclear', 'failure'] as const)(
    'interposed QA is absent from complete adapter requests on resume: %s',
    async (mode) => {
      vi.setSystemTime(now);
      await flag(true);
      relation = mode === 'failure' ? 'answer_pending' : mode;
      providerFailure = false;
      const clean = await conversation(),
        interposed = await conversation();
      await turn(clean, 'Gợi ý quán cafe ở Hà Nội');
      await turn(interposed, 'Gợi ý quán cafe ở Hà Nội');
      const qa = await turn(interposed, 'Quán Sao Lạ giá bao nhiêu?');
      const controls = await turn(interposed, 'Thông tin về Song Ngọc');
      const option = controls.message.followUps[0].options[0];
      await turn(interposed, option.text, {
        replyToMessageId: controls.id,
        followUpOptionId: option.id,
      });
      // Stop is a real route through the public endpoint. Failed/empty QA still
      // cannot consume the recommendation window or become its latest question.
      const repo = f.app.get(AssistantRepository);
      const history = await repo.history(interposed.id, qa.id, 100);
      expect(history.some((m) => m.trace?.route === 'place_qa')).toBe(false);
      providerFailure = mode === 'failure';
      resetCapture();
      const cleanResume = await turn(clean, 'Gợi ý quán cafe ở Hà Nội giá 100k');
      const expected = structuredClone(capture);
      resetCapture();
      const qaResume = await turn(interposed, 'Gợi ý quán cafe ở Hà Nội giá 100k');
      expect(capture).toEqual(expected);
      expect(expected.jev.length).toBeGreaterThan(0);
      if (mode === 'unclear') {
        // §3.2 retains existing clarification semantics: no search/compose.
        expect(expected.haiku).toEqual([]);
        expect(qaResume.text).toBe(cleanResume.text);
        for (const resumed of [cleanResume, qaResume]) {
          expect(resumed.frames.some((f) => f.event === 'card' || f.event === 'proposal')).toBe(
            false,
          );
          expect(
            resumed.message.followUps.some((g: { field: string }) => g.field === 'turn_relation'),
          ).toBe(true);
        }
      } else if (mode !== 'failure') expect(expected.haiku.length).toBeGreaterThan(0);
      expect(JSON.stringify(capture)).not.toMatch(
        /a1:|place_qa|placeQa|place_confirm|pick_1|Quán Sao Lạ|Song Ngọc/,
      );
      providerFailure = false;
      relation = 'answer_pending';
    },
  );
  it('flag on/off leaves non-QA complete adapter requests byte-identical', async () => {
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
  });
  it('flag-off controls and stale/replayed options remain QA, with no models', async () => {
    const c = await conversation();
    await flag(true);
    const choices = await turn(c, 'Thông tin về Song Ngọc');
    const fields = {
      replyToMessageId: choices.id,
      followUpOptionId: choices.message.followUps[0].options[0].id,
    };
    resetCapture();
    await flag(false);
    const disabled = await turn(c, '1', fields);
    expect(disabled.text).toContain('hiện chưa khả dụng');
    await flag(true);
    const stale = await turn(c, '1', fields);
    expect(stale.text).toContain('không còn hợp lệ');
    expect(capture).toEqual({ jev: [], haiku: [] });
  });
  it('filters QA BEFORE the recommendation history limit, and preserves association through orphan/stop', async () => {
    await flag(true);
    const c = await conversation();
    const original = await turn(c, 'Gợi ý quán cafe ở Hà Nội');
    for (let i = 0; i < 7; i++) await turn(c, 'Quán Sao Lạ giá bao nhiêu?');
    const last = await turn(c, 'Quán Sao Lạ mở cửa mấy giờ?');
    const repo = f.app.get(AssistantRepository);
    const history = await repo.history(c.id, last.id, 3);
    expect(history.map((m) => m.id)).toContain(original.id);
    expect(history).toHaveLength(2);
    // A real admitted row is used; no client-supplied id controls association.
    await f.db.execute(
      sql`update assistant_messages set status='streaming',lease_expires_at=now()-interval '1 minute' where id=${last.id}`,
    );
    await f.db.execute(
      sql`update assistant_usage_ledger set status='accepted',jev_cost_usd=null,haiku_upstream_cost_usd=null,haiku_openrouter_cost_usd=null where message_id=${last.id}`,
    );
    const row = (await repo.findMessageById(last.id))!;
    await f.app
      .get(AssistantTurnRunner)
      .finalizeOrphan(row, 'stopped', null, { onlyIfLeaseExpired: true });
    const stopped = await repo.findMessageById(last.id);
    expect(stopped?.trace).toMatchObject({
      route: 'place_qa',
      questionMessageId: last.stored?.trace?.questionMessageId,
      orphaned: true,
    });
    const usage = await f.db.execute(
      sql`select id from assistant_usage_ledger where message_id=${last.id}`,
    );
    await repo.completeLedger(String(usage.rows[0]!.id), 'stopped', emptyCosts());
    const closed = await f.db.execute(
      sql`select status,jev_cost_usd,haiku_upstream_cost_usd from assistant_usage_ledger where message_id=${last.id}`,
    );
    expect(closed.rows[0]).toMatchObject({ status: 'stopped' });
    expect(closed.rows[0]!.jev_cost_usd).not.toBeNull();
    expect(Number(closed.rows[0]!.jev_cost_usd)).toBe(0);
    const next = await turn(c, 'Gợi ý quán cafe ở Hà Nội giá 100k');
    expect(next.stored?.trace?.route).not.toBe('place_qa');
  });
  it('public controls require both fields, without spending admission on malformed input', async () => {
    const c = await conversation();
    for (const fields of [{ replyToMessageId: randomUUID() }, { followUpOptionId: 'pick_1' }]) {
      const r = await f.inject({
        method: 'POST',
        url: `/v1/assistant/conversations/${c.id}/messages`,
        token: c.token,
        headers: { 'idempotency-key': randomUUID() },
        payload: { text: '1', ...fields },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('VALIDATION_FAILED');
    }
  });
  it('upstream outage does not affect admitted QA, while master disablement still refuses sends', async () => {
    const c = await conversation();
    providerFailure = true;
    resetCapture();
    const r = await turn(c, 'Quán Sao Lạ giá bao nhiêu?');
    expect(r.text).toContain('VND/người');
    expect(capture).toEqual({ jev: [], haiku: [] });
    providerFailure = false;
    await f.setFlag(false);
    const rejected = await f.inject({
      method: 'POST',
      url: `/v1/assistant/conversations/${c.id}/messages`,
      token: c.token,
      headers: { 'idempotency-key': randomUUID() },
      payload: { text: 'Quán Sao Lạ giá bao nhiêu?' },
    });
    expect(rejected.statusCode).toBe(503);
    await f.setFlag(true);
  });
  it('resolver error fails the turn and durably excludes its QA pair', async () => {
    const c = await conversation();
    const search = f.app.get(SearchService, { strict: false });
    const failing = vi
      .spyOn(search, 'resolvePlaceName')
      .mockRejectedValueOnce(new Error('fixture read error'));
    try {
      resetCapture();
      const r = await turn(c, 'Quán Sao Lạ giá bao nhiêu?');
      expect(r.stored?.status).toBe('failed');
      expect(r.stored?.trace).toMatchObject({
        route: 'place_qa',
        placeQa: { row: 1, outcome: 'read_error' },
      });
      expect(capture).toEqual({ jev: [], haiku: [] });
    } finally {
      failing.mockRestore();
    }
  });
});

describe.skipIf(baseline)(
  'S3 state matrix: preserve and explicitly resume recommendation state',
  () => {
    it.each([
      ['activity', 'Gợi ý hoạt động'],
      ['area', 'Gợi ý quán cafe'],
      ['budget', 'Gợi ý quán cafe ở Hà Nội'],
      ['create_room', 'Tạo kèo quán cafe ở Hà Nội'],
    ])('%s pending is preserved across QA and explicit resume', async (_kind, initial) => {
      vi.setSystemTime(now);
      await flag(true);
      providerFailure = false;
      relation = 'answer_pending';
      const clean = await conversation(),
        interposed = await conversation();
      await turn(clean, initial);
      const original = await turn(interposed, initial);
      const saved = structuredClone(original.stored!.trace);
      resetCapture();
      await turn(interposed, 'Quán Sao Lạ giá bao nhiêu?');
      expect(capture).toEqual({ jev: [], haiku: [] });
      const after = await f.app.get(AssistantRepository).findMessageById(original.id);
      expect(after?.trace).toEqual(saved);
      const resume = 'Tiếp tục yêu cầu trước: quán cafe ở Hà Nội giá 100k';
      resetCapture();
      await turn(clean, resume);
      const expected = structuredClone(capture);
      resetCapture();
      const resumed = await turn(interposed, resume);
      expect(capture).toEqual(expected);
      expect(resumed.stored?.trace?.route).not.toBe('place_qa');
    });
    it.each(['asking', 'suspended', 'final'] as const)(
      'reconcile %s survives QA and resumes with identical model payloads',
      async (status) => {
        vi.setSystemTime(now);
        await flag(true);
        providerFailure = false;
        relation = 'new_request';
        const clean = await conversation(),
          interposed = await conversation();
        const seed = async (c: { token: string; id: string }) => {
          await turn(c, 'Gợi ý quán cafe cho 2 người ở Hà Nội');
          const r = await turn(c, 'Gợi ý quán cafe cho 3 người ở Hà Nội');
          let state = r.stored?.trace?.reconcile as ReconciledRequest;
          expect(state, 'fixture must reach the real reconcile machine').toBeTruthy();
          if (status === 'final') {
            for (let step = 0; step < 20; step++) {
              const i = firstPending(state);
              if (i === null) break;
              state = { ...state, asked: i };
              const item = state.items[i]!;
              const choices = chipsFor(item, state.values[item.field]!.pending!, state.offset);
              state = applyChip(state, choices[0]!);
            }
          }
          state = { ...state, status };
          await f.db.execute(
            sql`update assistant_messages set trace=jsonb_set(trace,'{reconcile}',${JSON.stringify(state)}::jsonb) where id=${r.id}`,
          );
          return { id: r.id, state };
        };
        await seed(clean);
        const original = await seed(interposed);
        await turn(interposed, 'Quán Sao Lạ giá bao nhiêu?');
        expect(
          (await f.app.get(AssistantRepository).findMessageById(original.id))?.trace?.reconcile,
        ).toEqual(original.state);
        relation = 'answer_pending';
        const resume = 'Tiếp tục yêu cầu trước: quán cafe ở Hà Nội giá 100k';
        resetCapture();
        await turn(clean, resume);
        const expected = structuredClone(capture);
        resetCapture();
        await turn(interposed, resume);
        expect(capture).toEqual(expected);
        relation = 'answer_pending';
      },
    );
    it.each(['expired', 'source_deleted'] as const)(
      '%s source invalidates continuation without model fallback',
      async (mode) => {
        const c = await conversation();
        await flag(true);
        const choices = await turn(c, 'Thông tin về Song Ngọc');
        if (mode === 'source_deleted')
          await f.db.execute(
            sql`delete from assistant_messages where id=${choices.stored?.trace?.questionMessageId}::uuid`,
          );
        else {
          const qa = choices.stored!.trace!.placeQa as {
            pending: { createdAt: string; expiresAt: string };
          };
          qa.pending.createdAt = new Date(now - 30 * 60 * 1000).toISOString();
          qa.pending.expiresAt = new Date(now).toISOString();
          await f.db.execute(
            sql`update assistant_messages set trace=jsonb_set(trace,'{placeQa}',${JSON.stringify(qa)}::jsonb) where id=${choices.id}`,
          );
        }
        resetCapture();
        const r = await turn(c, '1', {
          replyToMessageId: choices.id,
          followUpOptionId: choices.message.followUps[0].options[0].id,
        });
        expect(r.text).toContain('không còn hợp lệ');
        expect(capture).toEqual({ jev: [], haiku: [] });
      },
    );
    it('typed ordinal is confirmed, none narrows, and area refinement reruns the whole name', async () => {
      const c = await conversation();
      await flag(true);
      await turn(c, 'Thông tin về Song Ngọc');
      resetCapture();
      const confirm = await turn(c, '1');
      expect(confirm.message.followUps[0].field).toBe('place_confirm');
      const none = await turn(c, 'Không phải các quán này');
      expect(none.text).toContain('phường/xã');
      const refined = await turn(c, 'Phường Cầu Giấy, Hà Nội');
      expect((refined.stored?.trace?.placeQa as { outcome: string }).outcome).toBe('choice');
      expect(capture).toEqual({ jev: [], haiku: [] });
    });
  },
);

// Owner "Theo đề xuất", dev/policy/decisions-log.md, 2026-11-11:
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

describe.skipIf(baseline)('ordinary model cost attribution remains unchanged', () => {
  it('keeps fractional known USD and preserves unknown cost for a non-QA call', async () => {
    const c = await conversation();
    await flag(true);
    const r = await turn(c, 'Gợi ý quán cafe ở Hà Nội giá 100k');
    expect(r.stored?.trace?.route).not.toBe('place_qa');
    const usage = await f.db.execute(
      sql`select id from assistant_usage_ledger where message_id=${r.id}`,
    );
    const repo = f.app.get(AssistantRepository),
      id = String(usage.rows[0]!.id);
    await repo.completeLedger(id, 'complete', {
      ...emptyCosts(),
      jevCalls: 1,
      jevCostUsd: 0.00012,
      haikuCalls: 1,
      haikuUpstreamCostUsd: 0.00023,
      haikuOpenrouterCostUsd: 0.00004,
    });
    const known = await f.db.execute(
      sql`select jev_cost_usd,haiku_upstream_cost_usd,haiku_openrouter_cost_usd from assistant_usage_ledger where id=${id}`,
    );
    expect(Number(known.rows[0]!.jev_cost_usd)).toBe(0.00012);
    expect(Number(known.rows[0]!.haiku_upstream_cost_usd)).toBe(0.00023);
    expect(Number(known.rows[0]!.haiku_openrouter_cost_usd)).toBe(0.00004);
    await repo.completeLedger(id, 'failed', { ...emptyCosts(), jevCalls: 1 });
    const unknown = await f.db.execute(
      sql`select jev_cost_usd from assistant_usage_ledger where id=${id}`,
    );
    expect(unknown.rows[0]!.jev_cost_usd).toBeNull();
  });
});
