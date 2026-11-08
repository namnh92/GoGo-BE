import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  schema,
  backfillNotificationInboxBatch,
  finishNotificationInboxRollout,
} from '@gogo/database';
import { NotificationInboxService } from '../../../libs/modules/notifications/application/notification-inbox.service';
import {
  InboxReadAllWorker,
  advanceReadOperation,
  type ReadOperationRow,
} from '../../../libs/modules/notifications/application/inbox-read-operations';
import { InboxCursorCodec } from '../../../libs/modules/notifications/domain/inbox-cursor';
import type { IdempotencyScope } from '../../../libs/modules/shared/idempotency.interceptor';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let snapshot: string;
let historical: string;
let inbox: NotificationInboxService;
const secret = 'inbox-integration-secret'.padEnd(48, 'x');
const config = { AUTH_JWT_SECRET: secret };
const api = () => app.getHttpAdapter().getInstance();
const migrations = path.resolve(__dirname, '../../../migrations');
async function user() {
  const { rows } = await pool.query('insert into users(display_name) values ($1) returning id', [
    'Inbox test',
  ]);
  return rows[0].id as string;
}
async function insert(userId: string, count = 1, timestamp = '2026-11-08T10:00:00.123456Z') {
  const { rows } = await pool.query(
    `insert into notifications(user_id, kind, payload, created_at)
    select $1, 'invite', '{}', $3::timestamptz from generate_series(1,$2::int) returning id, inbox_sequence`,
    [userId, count, timestamp],
  );
  return rows as { id: string; inbox_sequence: string }[];
}
function scope(key = randomUUID(), body = 'body'): IdempotencyScope {
  return {
    storedKey: key,
    requestHash: body,
    actorScope: 'test',
    endpoint: 'POST /v1/me/notifications/read-all',
  };
}
async function counts(userId: string) {
  return (
    await pool.query(
      `select count(*) filter(where read_at is null)::int as unread,
    count(*) filter(where read_at is not null)::int as read from notifications where user_id=$1`,
      [userId],
    )
  ).rows[0];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_inbox')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  db = drizzle(pool, { schema });
  snapshot = await mkdtemp(path.join(tmpdir(), 'gogo-before-inbox-'));
  await cp(migrations, snapshot, { recursive: true });
  const journalPath = path.join(snapshot, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 79);
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(db, { migrationsFolder: snapshot });
  historical = await user();
  // Existing read markers survive schema + backfill. >500 proves bounded upgrade.
  await pool.query(
    `insert into notifications(user_id,kind,payload,read_at)
    select $1,'invite','{}',case when i=1 then '2026-01-01'::timestamptz else null end
    from generate_series(1,1101) i`,
    [historical],
  );
  await migrate(db, { migrationsFolder: migrations });
  inbox = new NotificationInboxService(db, config);
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = secret;
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
  if (snapshot) await rm(snapshot, { recursive: true, force: true });
});

describe.sequential('shared inbox upgrade and concurrency', () => {
  it('gates cutoff until bounded resumable backfill + concurrent indexes complete', async () => {
    await expect(inbox.summary(historical)).rejects.toMatchObject({ httpStatus: 503 });
    expect(await backfillNotificationInboxBatch(db)).toBe(500);
    // New writer interleaves with the old rows; restarting the backfill loses no progress.
    await insert(historical);
    expect(await backfillNotificationInboxBatch(db)).toBe(500);
    expect(await backfillNotificationInboxBatch(db)).toBe(101);
    expect(await backfillNotificationInboxBatch(db)).toBe(0);
    await finishNotificationInboxRollout(pool);
    await finishNotificationInboxRollout(pool); // restart after DDL succeeds
    expect(await inbox.summary(historical)).toMatchObject({ unreadCount: 1101 });
    const { rows } = await pool.query(
      `select count(distinct inbox_sequence)::int as unique_count,
      min(read_at)::text as first_read from notifications where user_id=$1`,
      [historical],
    );
    expect(rows[0].unique_count).toBe(1102);
    expect(rows[0].first_read).toContain('2026-01-01');
    const idx = await pool.query(
      `select indisvalid, indisunique from pg_index where indexrelid='notifications_user_sequence_unique'::regclass`,
    );
    expect(idx.rows[0]).toEqual({ indisvalid: true, indisunique: true });
  });

  it('common trigger covers every kind, raw old producers and dedupe retries', async () => {
    const id = await user();
    for (const kind of schema.notificationKind.enumValues) {
      await pool.query(
        `insert into notifications(user_id,kind,payload,dedupe_key) values ($1,$2,'{}',$3)
        on conflict do nothing`,
        [id, kind, `inbox-test:${id}:${kind}`],
      );
      await pool.query(
        `insert into notifications(user_id,kind,payload,dedupe_key) values ($1,$2,'{}',$3)
        on conflict do nothing`,
        [id, kind, `inbox-test:${id}:${kind}`],
      );
    }
    expect(await inbox.summary(id)).toMatchObject({
      unreadCount: schema.notificationKind.enumValues.length,
    });
    const { rows } = await pool.query(
      `select count(*)::int as n,count(distinct inbox_sequence)::int as sequences
      from notifications where user_id=$1`,
      [id],
    );
    expect(rows[0]).toEqual({
      n: schema.notificationKind.enumValues.length,
      sequences: schema.notificationKind.enumValues.length,
    });
  });

  it('late commits stay above an issued cutoff, and concurrent inserts serialize through commit', async () => {
    const id = await user();
    await insert(id);
    const late = await pool.connect();
    const follower = await pool.connect();
    try {
      await late.query('begin');
      await late.query(
        `insert into notifications(user_id,kind,payload,created_at) values ($1,'campaign','{}','2020-01-01')`,
        [id],
      );
      const s = await inbox.summary(id); // uncommitted row and sequence invisible
      expect(s.unreadCount).toBe(1);
      await follower.query('begin');
      // A follower cannot allocate while the first insert remains uncommitted.
      await follower.query("set local lock_timeout = '50ms'");
      await expect(
        follower.query(
          `insert into notifications(user_id,kind,payload) values ($1,'invite','{}')`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await follower.query('rollback');
      await late.query('commit');
      const result = await inbox.readAll(id, s.readThroughCursor, scope());
      expect(result.body.changedCount).toBe(1);
      expect(await counts(id)).toEqual({ read: 1, unread: 1 });
    } finally {
      await late.query('rollback');
      await follower.query('rollback');
      late.release();
      follower.release();
    }
  });

  it('paginates equal microsecond timestamps without gaps, freezes arrivals and accepts old timestamps', async () => {
    const id = await user();
    const inserted = await insert(id, 43);
    const p1 = await inbox.list(id);
    await insert(id, 1, '2020-01-01T00:00:00.000000Z');
    const p2 = await inbox.list(id, p1.nextCursor!);
    const p3 = await inbox.list(id, p2.nextCursor!);
    const ids = [...p1.notifications, ...p2.notifications, ...p3.notifications].map((n) => n.id);
    expect(ids).toHaveLength(43);
    expect(new Set(ids)).toEqual(new Set(inserted.map((n) => n.id)));
    expect(ids).toEqual([...ids].sort().reverse());
    expect(p3.nextCursor).toBeNull();
    const legacy = await inbox.list(id, '2026-11-08T10:00:01.000Z');
    expect(legacy.notifications).toHaveLength(20);
    await expect(inbox.list(await user(), p1.nextCursor!)).rejects.toMatchObject({
      code: 'INVALID_NOTIFICATION_CURSOR',
    });
  });

  it('bounds >500 rows, recovers after rolled-back progress and resumes from a fresh worker', async () => {
    const id = await user();
    await insert(id, 1201);
    const s = await inbox.summary(id);
    const key = scope();
    const result = await inbox.readAll(id, s.readThroughCursor, key);
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ status: 'running', changedCount: 500 });
    await expect(
      db.transaction(async (tx) => {
        const { rows } = await tx.execute<ReadOperationRow>(
          sql`select * from notification_read_operations where id=${result.body.operationId}::uuid for update`,
        );
        await advanceReadOperation(tx, rows[0]!);
        throw new Error('simulated crash before commit');
      }),
    ).rejects.toThrow('simulated crash');
    expect(await inbox.operation(id, result.body.operationId)).toMatchObject({ changedCount: 500 });
    await insert(id); // above fixed cutoff
    await new InboxReadAllWorker(db).runTick();
    const done = await inbox.operation(id, result.body.operationId);
    expect(done).toMatchObject({ status: 'completed', changedCount: 1201 });
    expect(await counts(id)).toEqual({ read: 1201, unread: 1 });
    const { rows } = await pool.query(
      'select distinct read_at from notifications where user_id=$1 and read_at is not null',
      [id],
    );
    expect(rows.map((r) => r.read_at.toISOString())).toEqual([result.body.asOf]);
    // Same request replays the original body/status; polling reports current state.
    expect(await inbox.readAll(id, s.readThroughCursor, key)).toEqual(result);
    await expect(
      inbox.readAll(id, s.readThroughCursor, { ...key, requestHash: 'different' }),
    ).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('concurrent bulk/single reads preserve first readAt and never double count', async () => {
    const id = await user();
    const rows = await insert(id, 801);
    const first = rows[0]!.id;
    await inbox.markRead(id, first);
    const before = await pool.query('select read_at from notifications where id=$1', [first]);
    const s = await inbox.summary(id);
    const [a, b] = await Promise.all([
      inbox.readAll(id, s.readThroughCursor, scope()),
      inbox.readAll(id, s.readThroughCursor, scope()),
      inbox.markRead(id, first),
      inbox.markRead(id, rows[1]!.id),
    ]);
    await new InboxReadAllWorker(db).runTick();
    const doneA = await inbox.operation(id, a.body.operationId);
    const doneB = await inbox.operation(id, b.body.operationId);
    const marked = await pool.query('select read_at from notifications where id=$1', [first]);
    expect(marked.rows[0]).toEqual(before.rows[0]);
    expect([799, 800]).toContain(doneA.changedCount + doneB.changedCount);
    expect(await counts(id)).toEqual({ read: 801, unread: 0 });
  });

  it('concurrent same-key requests create one durable operation and expired replay still succeeds', async () => {
    const id = await user();
    await insert(id, 10);
    const codec = new InboxCursorCodec(secret);
    const token = codec.seal({
      v: 1,
      account: id,
      cutoff: '10',
      asOf: new Date().toISOString(),
      expires: Date.now() + 1000,
      type: 'through',
      filter: 'all',
    });
    const key = scope();
    const [a, b] = await Promise.all([
      inbox.readAll(id, token, key),
      inbox.readAll(id, token, key),
    ]);
    expect(a).toEqual(b);
    const futureClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    try {
      expect(await inbox.readAll(id, token, key)).toEqual(a);
    } finally {
      futureClock.mockRestore();
    }

    const count = await pool.query(
      'select count(*)::int as n from notification_read_operations where user_id=$1',
      [id],
    );
    expect(count.rows[0].n).toBe(1);
    // An expired new cursor is rejected and rolls its idempotency claim back.
    const expired = codec.seal({
      v: 1,
      account: id,
      cutoff: '10',
      asOf: new Date().toISOString(),
      expires: Date.now() - 1,
      type: 'through',
      filter: 'all',
    });
    const invalidKey = scope();
    await expect(inbox.readAll(id, expired, invalidKey)).rejects.toMatchObject({ httpStatus: 410 });
    const claims = await pool.query('select * from idempotency_keys where key=$1', [
      invalidKey.storedKey,
    ]);
    expect(claims.rows).toHaveLength(0);
  });

  it('foreign/missing notifications and operations are indistinguishable; deletion cascades', async () => {
    const a = await user(),
      b = await user();
    const [note] = await insert(a);
    expect(await inbox.markRead(b, note!.id)).toEqual(await inbox.markRead(b, randomUUID()));
    expect(await counts(a)).toEqual({ unread: 1, read: 0 });
    const s = await inbox.summary(a);
    await expect(inbox.readAll(b, s.readThroughCursor, scope())).rejects.toMatchObject({
      code: 'INVALID_NOTIFICATION_CURSOR',
    });
    const op = await inbox.readAll(a, s.readThroughCursor, scope());
    for (const id of [op.body.operationId, randomUUID()])
      await expect(inbox.operation(b, id)).rejects.toMatchObject({
        code: 'NOTIFICATION_READ_OPERATION_NOT_FOUND',
        httpStatus: 404,
      });
    await pool.query('delete from users where id=$1', [a]);
    for (const table of [
      'notifications',
      'notification_inbox_state',
      'notification_read_operations',
    ]) {
      const result = await pool.query(`select * from ${table} where user_id=$1`, [a]);
      expect(result.rows).toHaveLength(0);
    }
  });

  it('serves authenticated HTTP summary/read-all/status, exact errors, old single-read status and no guest access', async () => {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: '10.81.1.1',
      payload: {
        email: `inbox-${randomUUID()}@gogo.test`,
        password: 'sufficiently-long-pw',
        displayName: 'Inbox',
      },
    });
    expect(res.statusCode).toBe(201);
    const { accessToken, userId } = res.json();
    const headers = { authorization: `Bearer ${accessToken}` };
    const [note] = await insert(userId);
    const s = await api().inject({ method: 'GET', url: '/v1/me/notifications/summary', headers });
    expect(s.statusCode).toBe(200);
    expect(s.headers['cache-control']).toBe('private, no-store');
    const payload = { through: s.json().readThroughCursor };
    const missing = await api().inject({
      method: 'POST',
      url: '/v1/me/notifications/read-all',
      headers,
      payload,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('INVALID_IDEMPOTENCY_KEY');
    const read = await api().inject({
      method: 'POST',
      url: '/v1/me/notifications/read-all',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().changedCount).toBe(1);
    const status = await api().inject({
      method: 'GET',
      url: `/v1/me/notifications/read-all/${read.json().operationId}`,
      headers,
    });
    expect(status.json().status).toBe('completed');
    const single = await api().inject({
      method: 'POST',
      url: `/v1/me/notifications/${note!.id}/read`,
      headers,
    });
    expect(single.statusCode).toBe(201);
    expect(single.json()).toEqual({ read: true });
    const invalid = await api().inject({
      method: 'GET',
      url: '/v1/me/notifications?cursor=garbage',
      headers,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INVALID_NOTIFICATION_CURSOR');
    const unauth = await api().inject({ method: 'GET', url: '/v1/me/notifications/summary' });
    expect(unauth.statusCode).toBe(401);
  });
});
