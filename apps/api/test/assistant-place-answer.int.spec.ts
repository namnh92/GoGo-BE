import { answerToken } from '../../../libs/modules/assistant/domain/place-qa/tokens';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { minorUnitAmounts } from './support/minor-unit-amounts';
import { stripVolatile } from './support/strip-volatile';
import {
  startAssistantFixture,
  parseSse,
  type AssistantFixture,
} from './support/assistant-fixture';
import { AssistantStreamService } from '../../../libs/modules/assistant/application/assistant-stream.service';
import { PlaceAnswerReader } from '../../../libs/modules/assistant/application/place-answer-reader';
import {
  collectAssistantExport,
  purgeAssistantRetention,
} from '../../../libs/modules/assistant/application/assistant-privacy';
import {
  fictionalPlace,
  verified,
  fixtureRow,
  FIXTURE_A,
  FIXTURE_B,
} from '../../../libs/modules/assistant/domain/place-qa/fixtures';
import { truncateTokenSafe } from '../../../libs/modules/assistant/domain/place-tokens';
import type {
  PlaceFactsReader,
  PlaceFactContext,
} from '../../../libs/modules/assistant/domain/place-qa/place-facts';
import type { AssistantFrame } from '../../../libs/modules/assistant/domain/assistant.types';
import {
  ASSISTANT_FRAME_BUFFER,
  type AssistantFrameBuffer,
} from '../../../libs/modules/assistant/infrastructure/frame-buffer';

/** S1 reader integration, intentionally server-authored references (no S3
 * classifier/emitter). Real API/auth/repositories/DB/buffer/retention. The
 * Testcontainers fixture projection implements ONLY the port in this test;
 * it is not a production S2 projection or live provider acceptance proof.
 * DEV executes this file. No live provider call is needed or authorized here.
 */
let f: AssistantFixture, alice: string, bob: string, moderator: string;
let snapshot: PlaceFactContext;
let stall = false;
let lastSignal: AbortSignal | undefined;
let onRead: (() => void) | undefined;
let fail = false,
  lookupIds: readonly string[][] = [];
const port: PlaceFactsReader = {
  placeFacts: async (ids, o) => {
    expect(o.deadlineAt - Date.now()).toBeLessThanOrEqual(2000);
    if (o.signal.aborted) throw new Error('fixture cancelled');
    lookupIds = [...lookupIds, [...ids]];
    lastSignal = o.signal;
    onRead?.();
    if (stall) return new Promise(() => {});
    if (fail) throw new Error('fixture read failure');
    return snapshot;
  },
};
beforeAll(async () => {
  f = await startAssistantFixture({
    OPENROUTER_API_KEY: 'fixture-jev-unused',
    OPENROUTER_ASSISTANT_API_KEY: 'fixture-haiku-unused',
    ASSISTANT_USER_DAILY_MAX_MESSAGES: '5',
    ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES: '600',
    ASSISTANT_MONTHLY_MAX_USD: '1',
  });
  // Test-only DI override: no production binding for PLACE_FACTS_READER exists in S1.
  Object.defineProperty(f.app.get(PlaceAnswerReader), 'port', { value: port });
  alice = await f.register('s1-alice@example.test');
  bob = await f.register('s1-bob@example.test');
  moderator = await f.admin('s1-ops@example.test', 'ops_admin');
  snapshot = {
    places: new Map([
      [FIXTURE_A, fictionalPlace()],
      [FIXTURE_B, fictionalPlace(FIXTURE_B, 'Fictional Harbor')],
    ]),
  };
  // Identity-only preview uses the real bounded SQL path, never the fact projection.
  await f.db.execute(sql`insert into places (id,name,name_normalized,status,geom) values
    (${FIXTURE_A},'Fictional Lantern','fictional lantern','published',ST_SetSRID(ST_MakePoint(105.8,21.0),4326)),
    (${FIXTURE_B},'Fictional Harbor','fictional harbor','published',ST_SetSRID(ST_MakePoint(105.8,21.0),4326))`);
});
beforeEach(async () => {
  await f.setFlag(true);
});
afterAll(async () => {
  await f?.close();
});
async function seed(streaming = false) {
  const title = `fixture-${randomUUID()}`;
  const c = await f.inject({
    method: 'POST',
    url: '/v1/assistant/conversations',
    token: alice,
    payload: { title },
  });
  expect(c.statusCode).toBe(201);
  const conversationId = c.json().id as string,
    messageId = randomUUID();
  const owner = await f.db.execute(
    sql`select user_id from assistant_conversations where id=${conversationId}`,
  );
  const userId = (owner.rows[0] as { user_id: string }).user_id;
  const row = fixtureRow(messageId, [FIXTURE_A, FIXTURE_B]);
  const frames: AssistantFrame[] = [
    { type: 'delta', seq: 1, messageId, text: row.text },
    ...row.trace.placeAnswerGroup.cards.map((placeId, i) => ({
      type: 'card' as const,
      seq: 2 + i,
      messageId,
      card: { kind: 'place', placeId },
    })),
    { type: 'sources', seq: 4, messageId, sources: [] },
    { type: 'follow_ups', seq: 5, messageId, groups: [] },
    { type: 'done', seq: 6, messageId, status: 'complete' },
  ];
  await f.db
    .execute(sql`insert into assistant_messages (id,conversation_id,user_id,role,status,text,locale,cards,frames,trace,completed_at)
    values (${messageId},${conversationId},${userId},'assistant',${streaming ? 'streaming' : 'complete'},${row.text},'en',${JSON.stringify(row.trace.placeAnswerGroup.cards.map((placeId) => ({ kind: 'place', placeId })))}::jsonb,${JSON.stringify(frames)}::jsonb,${JSON.stringify(row.trace)}::jsonb,${streaming ? null : new Date()})`);
  await f.db.execute(
    sql`update assistant_conversations set message_count=1,preview=${truncateTokenSafe(row.text, 160)} where id=${conversationId}`,
  );
  return {
    title,
    conversationId,
    messageId,
    userId,
    row,
    frames,
    url: `/v1/assistant/conversations/${conversationId}/messages/${messageId}/stream`,
  };
}
async function history(c: string, token = alice) {
  return f.inject({ method: 'GET', url: `/v1/assistant/conversations/${c}/messages`, token });
}
describe('S1 server-authored reference groups on real read surfaces', () => {
  it('live committed group and reconnect suffix use one full snapshot; storage and buffer stay reference-only', async () => {
    const s = await seed(true);
    lookupIds = [];
    const buffer = f.app.get<AssistantFrameBuffer>(ASSISTANT_FRAME_BUFFER);
    await buffer.append(s.messageId, s.frames, Date.now() + 60000);
    const pending = f.sse(s.url, alice);
    // Attach while streaming, then commit without any inference/producer fixture.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await f.db.execute(
      sql`update assistant_messages set status='complete',completed_at=now() where id=${s.messageId}`,
    );
    const live = await pending;
    expect(live.status).toBe(200);
    const rendered = parseSse(live.body);
    expect(rendered.map((r) => r.event)).toContain('done');
    expect(live.body).toContain('12,000');
    expect(live.body).not.toMatch(/[\uE000\uE001]/);
    expect(lookupIds).toEqual([[FIXTURE_A, FIXTURE_B]]);
    lookupIds = [];
    const suffix = await f.sse(s.url, alice, '2');
    expect(lookupIds).toEqual([[FIXTURE_A, FIXTURE_B]]);
    expect(parseSse(suffix.body).map((r) => Number(r.id))).toEqual([3, 4, 5, 6]);
    const persisted = await f.db.execute(
      sql`select text,frames,trace from assistant_messages where id=${s.messageId}`,
    );
    const raw = JSON.stringify(persisted.rows);
    expect(raw).toContain('a1:');
    expect(stripVolatile(raw)).not.toMatch(/Lantern|Harbor/);
    expect(stripVolatile(raw)).not.toMatch(minorUnitAmounts(12000, 24000));
    expect(stripVolatile(JSON.stringify(await buffer.read(s.messageId, 0)))).not.toMatch(
      /Lantern|Harbor/,
    );
    expect(stripVolatile(JSON.stringify(await buffer.read(s.messageId, 0)))).not.toMatch(
      minorUnitAmounts(12000, 24000),
    );
  });
  it('history and CMS use current facts, sources/options re-evaluate and original authorization stays enforced', async () => {
    const s = await seed();
    lookupIds = [];
    const first = await history(s.conversationId);
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('12,000');
    expect(lookupIds).toEqual([[FIXTURE_A, FIXTURE_B]]);
    expect((await history(s.conversationId, bob)).statusCode).toBe(404);
    await f.inject({
      method: 'PUT',
      url: `/v1/assistant/conversations/${s.conversationId}/messages/${s.messageId}/feedback`,
      token: alice,
      payload: { rating: 'down', reason: 'outdated' },
    });
    const cms = await f.inject({
      method: 'GET',
      url: '/v1/cms/assistant/feedback?rating=down',
      token: moderator,
    });
    expect(cms.statusCode).toBe(200);
    expect(cms.body).toContain('12,000');
    expect(cms.body).not.toContain(s.messageId);
    expect(cms.body).not.toContain(s.userId);
    snapshot = {
      places: new Map([
        [FIXTURE_A, { ...fictionalPlace(), available: false }],
        [FIXTURE_B, { ...fictionalPlace(FIXTURE_B, 'Fictional Harbor'), facts: {} }],
      ]),
    };
    const changed = await history(s.conversationId);
    expect(stripVolatile(changed.body)).not.toMatch(minorUnitAmounts(12000, 24000));
    expect(changed.json().items[0].sources).toEqual([]);
    expect(changed.json().items[0].cards[0].available).toBe(false);
    expect(changed.json().items[0].followUps).toEqual([]);
    snapshot = {
      places: new Map([
        [FIXTURE_A, fictionalPlace()],
        [FIXTURE_B, fictionalPlace(FIXTURE_B, 'Fictional Harbor')],
      ]),
    };
  });
  it('fact failure after producer completion: SSE error; localized history/CMS text; no unavailable cards', async () => {
    const s = await seed();
    fail = true;
    try {
      const replay = await f.sse(s.url, alice);
      const frames = parseSse(replay.body);
      expect(frames.map((f) => f.event)).toEqual(['delta', 'error']);
      expect(replay.body).toContain('ASSISTANT_RENDER_FAILED');
      expect(replay.body).not.toContain('available');
      const h = await history(s.conversationId);
      expect(h.json().items[0]).toMatchObject({
        status: 'complete',
        text: 'GoGo could not load place data. Please try again.',
        cards: [],
        sources: [],
        followUps: [],
      });
      await f.inject({
        method: 'PUT',
        url: `/v1/assistant/conversations/${s.conversationId}/messages/${s.messageId}/feedback`,
        token: alice,
        payload: { rating: 'down', reason: 'incorrect' },
      });
      const cms = await f.inject({
        method: 'GET',
        url: '/v1/cms/assistant/feedback?reason=incorrect',
        token: moderator,
      });
      expect(cms.body).toContain('GoGo could not load place data');
      expect(stripVolatile(cms.body)).not.toMatch(minorUnitAmounts(12000, 24000));
    } finally {
      fail = false;
    }
  });
  it('preview/snippet read identity only; persisted export reads no facts and contains no private delimiters', async () => {
    const s = await seed();
    lookupIds = [];
    const list = await f.inject({
      method: 'GET',
      url: '/v1/assistant/conversations',
      token: alice,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toMatch(/[\uE000\uE001]/);
    expect(list.body).toContain('Fictional Lantern');
    const search = await f.inject({
      method: 'GET',
      url: '/v1/assistant/conversations?q=a1',
      token: alice,
    });
    expect(search.statusCode).toBe(200);
    expect(search.body).not.toMatch(/[\uE000\uE001]/);
    expect(lookupIds).toEqual([]);
    const exported = await collectAssistantExport(f.db, s.userId, () => {});
    expect(JSON.stringify(exported)).toContain('GoGo place');
    expect(stripVolatile(JSON.stringify(exported))).not.toMatch(/[\uE000\uE001]|Lantern|Harbor/);
    expect(stripVolatile(JSON.stringify(exported))).not.toMatch(minorUnitAmounts(12000, 24000));
    expect(lookupIds).toEqual([]);
  });
  it.each([
    ['mixed prose', (text: string) => `${text}\nSecret Cafe costs 123 VND`],
    ['zero-query answer', () => 'Secret Cafe costs 123 VND'],
  ] as const)(
    'a malformed %s reaches neither the stored preview, the list, the snippet nor the export',
    async (_scenario, corrupt) => {
      const s = await seed(true);
      const row = fixtureRow(s.messageId, [FIXTURE_A]);
      const finalized = await f.app.get(AssistantRepository).finalizeMessage(s.messageId, {
        status: 'complete',
        text: corrupt(row.text),
        cards: [],
        followUps: [],
        notice: null,
        error: null,
        frames: null,
        trace: row.trace,
        sources: [],
      });
      expect(finalized?.status).toBe('complete');
      const stored = await f.db.execute(
        sql`select preview from assistant_conversations where id=${s.conversationId}`,
      );
      // The earlier (valid) preview stays; the malformed text is not copied.
      expect((stored.rows[0] as { preview: string }).preview).toBe(
        truncateTokenSafe(s.row.text, 160),
      );
      lookupIds = [];
      for (const url of ['/v1/assistant/conversations', '/v1/assistant/conversations?q=Secret']) {
        const res = await f.inject({ method: 'GET', url, token: alice });
        expect(res.statusCode).toBe(200);
        const item = (res.json().items as { id: string; match?: { snippet?: string } }[]).find(
          (c) => c.id === s.conversationId,
        );
        expect(item).toBeDefined();
        expect(JSON.stringify(item)).not.toMatch(/[\uE000\uE001]|Secret|123 VND/);
        if (url.includes('q=')) expect(item!.match?.snippet).toBe('địa điểm này');
      }
      const exported = await collectAssistantExport(f.db, s.userId, () => {});
      const conversation = exported.find((c) => c.title === s.title)!;
      expect(conversation.messages.map((m) => m.text)).toEqual(['địa điểm này']);
      expect(lookupIds).toEqual([]);
    },
  );
  it('reader timeout/cancellation do not change the accepted persisted producer result', async () => {
    const s = await seed();
    stall = true;
    try {
      const replay = await f.sse(s.url, alice);
      expect(parseSse(replay.body).map((r) => r.event)).toEqual(['delta', 'error']);
      expect(replay.body).toContain('ASSISTANT_RENDER_TIMEOUT');
      expect(lastSignal?.aborted).toBe(true);
      const h = await history(s.conversationId);
      expect(h.json().items[0]).toMatchObject({
        status: 'complete',
        cards: [],
        sources: [],
        followUps: [],
      });
      let readStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      onRead = readStarted;
      const stream = await f.app
        .get(AssistantStreamService)
        .stream(
          { type: 'user', id: s.userId, sessionId: 'fixture-session' },
          s.conversationId,
          s.messageId,
          null,
        );
      const subscription = stream.subscribe();
      await started;
      subscription.unsubscribe();
      expect(lastSignal?.aborted).toBe(true);
      onRead = undefined;
      const persisted = await f.db.execute(
        sql`select status,text from assistant_messages where id=${s.messageId}`,
      );
      expect(persisted.rows[0]).toMatchObject({ status: 'complete', text: s.row.text });
    } finally {
      stall = false;
      onRead = undefined;
    }
  });
  it('expired conversations are inaccessible before retention purge and leave no export afterwards', async () => {
    const s = await seed();
    await f.inject({
      method: 'PUT',
      url: `/v1/assistant/conversations/${s.conversationId}/messages/${s.messageId}/feedback`,
      token: alice,
      payload: { rating: 'down', reason: 'unsafe' },
    });
    await f.db.execute(
      sql`update assistant_conversations set last_message_at=now()-interval '91 days' where id=${s.conversationId}`,
    );
    expect((await history(s.conversationId)).statusCode).toBe(404);
    expect((await f.sse(s.url, alice)).status).toBe(404);
    const cms = await f.inject({
      method: 'GET',
      url: '/v1/cms/assistant/feedback?reason=unsafe',
      token: moderator,
    });
    expect(cms.json().items).toEqual([]);
    await purgeAssistantRetention(f.db, false);
    const rows = await f.db.execute(sql`select id from assistant_messages where id=${s.messageId}`);
    expect(rows.rows).toHaveLength(0);
    const exported = await collectAssistantExport(f.db, s.userId, () => {});
    expect(exported.some((c) => c.title === s.title)).toBe(false);
  });
  it('deleted sources cannot be streamed/history-read and purge keeps them out of export', async () => {
    const s = await seed();
    expect(
      (
        await f.inject({
          method: 'DELETE',
          url: `/v1/assistant/conversations/${s.conversationId}`,
          token: alice,
        })
      ).statusCode,
    ).toBe(204);
    const missingHistory = await history(s.conversationId);
    expect(missingHistory.statusCode).toBe(404);
    for (const lastEventId of [undefined, '1']) {
      const stream = await f.sse(s.url, alice, lastEventId);
      expect(stream.status).toBe(404);
      const { request_id: historyRequestId, ...historyError } = missingHistory.json();
      const { request_id: streamRequestId, ...streamError } = JSON.parse(stream.body);
      expect(streamError).toEqual(historyError);
      expect(streamError.code).toBe('NOT_FOUND');
      expect(historyRequestId).toEqual(expect.any(String));
      expect(streamRequestId).toEqual(expect.any(String));
    }
    const rows = await f.db.execute(
      sql`select id from assistant_messages where conversation_id=${s.conversationId}`,
    );
    expect(rows.rows).toHaveLength(0);
    const exported = await collectAssistantExport(f.db, s.userId, () => {});
    expect(exported.some((c) => c.title === s.title)).toBe(false);
  });
});

describe('round-1 canonical contract integration', () => {
  it('keeps both interval evidence dates across SSE and history', async () => {
    const original = snapshot;
    try {
      const morning = verified({ kind: 'interval' as const, openMinute: 540, closeMinute: 720 });
      const evening = {
        ...verified(
          { kind: 'interval' as const, openMinute: 1080, closeMinute: 1320 },
          'verified_reference',
        ),
        verifiedAt: '2020-01-01T00:00:00Z',
      };
      snapshot = {
        places: new Map([
          [
            FIXTURE_A,
            { ...fictionalPlace(), facts: { hours: [{ day: 3, intervals: [morning, evening] }] } },
          ],
        ]),
      };
      const s = await seed();
      const row = fixtureRow(s.messageId);
      row.text = answerToken({
        placeId: FIXTURE_A,
        locale: 'en',
        topic: 'hours',
        day: 'weekday',
        d: 3,
      });
      row.trace.placeAnswerGroup = {
        ...row.trace.placeAnswerGroup,
        sources: [row.text],
        options: [],
      };
      const frames: AssistantFrame[] = [
        { type: 'delta', seq: 1, messageId: s.messageId, text: row.text },
        { type: 'sources', seq: 2, messageId: s.messageId, sources: [] },
        { type: 'done', seq: 3, messageId: s.messageId, status: 'complete' },
      ];
      await f.db.execute(
        sql`update assistant_messages set text=${row.text},trace=${JSON.stringify(row.trace)}::jsonb,frames=${JSON.stringify(frames)}::jsonb where id=${s.messageId}`,
      );
      const stream = await f.sse(s.url, alice);
      const messages = await history(s.conversationId);
      expect(stream.status).toBe(200);
      expect(messages.statusCode).toBe(200);
      for (const body of [stream.body, messages.body]) {
        expect(body).toContain('09:00–12:00');
        expect(body).toContain('18:00–22:00');
        expect(body).toContain('2026-11-10');
        expect(body).toContain('2020-01-01');
        expect(body).toContain('Reference information');
      }
    } finally {
      snapshot = original;
    }
  });
  it('persists route classification only for the streaming lease owner and preserves trace', async () => {
    const s = await seed(true);
    const repo = f.app.get(AssistantRepository);
    await f.db.execute(
      sql`update assistant_messages set lease_owner='round-1-owner' where id=${s.messageId}`,
    );
    expect(await repo.persistStreamRoute(s.messageId, 'foreign-owner', 'place_qa')).toBe(false);
    expect(await repo.persistStreamRoute(s.messageId, 'round-1-owner', 'place_qa')).toBe(true);
    expect(await repo.persistStreamRoute(s.messageId, 'round-1-owner', 'ordinary')).toBe(false);
    const stored = await repo.findMessage(s.userId, s.conversationId, s.messageId);
    expect(stored?.trace).toEqual({ ...s.row.trace, streamRoute: 'place_qa' });
    await f.db.execute(
      sql`update assistant_messages set status='complete',completed_at=now() where id=${s.messageId}`,
    );
    expect(await repo.persistStreamRoute(s.messageId, 'round-1-owner', 'place_qa')).toBe(false);
  });
});
