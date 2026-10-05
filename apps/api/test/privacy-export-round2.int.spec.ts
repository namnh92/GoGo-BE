import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema, type Db } from '@gogo/database';
import {
  PrivacyExportProcessor,
  PrivacyExportService,
  parseExportKeyring,
  reapAttemptObjects,
  type PrivacyExportProcessorOptions,
} from '@gogo/modules';
import { PRIVACY_EXPORT_STORAGE, STORAGE_PROVIDER, type FakeStorage } from '@gogo/providers';

/**
 * PR #677 — regression tests for the second review round (Astra A-F-02/04/06/
 * 07/09/10, Sol S-F-09..S-F-15). Each one fails on 189429c for the reason the
 * finding names and passes after the fix. Races use controlled interleaving —
 * a held row lock, a wrapped storage call, a test seam — never timing luck.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let storage: FakeStorage;
const WRAPPING_KEY = randomBytes(32).toString('base64');
const keyring = parseExportKeyring({ EXPORT_WRAPPING_KEY_V1: WRAPPING_KEY })!;
const MIGRATIONS = path.resolve(__dirname, '../../../migrations');

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.57.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const idem = () => `exp-${randomUUID()}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type User = { token: string; userId: string; email: string };

async function register(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: `Marker ${prefix}` },
  });
  expect(res.statusCode).toBe(201);
  return { token: res.json().accessToken, userId: res.json().userId, email };
}

function createExport(token: string) {
  return api().inject({
    method: 'POST',
    url: '/v1/me/exports',
    remoteAddress: ip(),
    headers: { ...auth(token), 'idempotency-key': idem() },
  });
}

function download(token: string, id: string) {
  return api().inject({
    method: 'POST',
    url: `/v1/me/exports/${id}/download`,
    remoteAddress: ip(),
    headers: auth(token),
  });
}

function processor(
  overrides: Partial<PrivacyExportProcessorOptions> = {},
  keys: typeof keyring | null = keyring,
) {
  return new PrivacyExportProcessor(db as unknown as Db, storage, keys, {
    workerId: `worker-${randomUUID().slice(0, 6)}`,
    mediaPublicBaseUrl: '',
    retentionMonths: 12,
    ...overrides,
  });
}

async function artifact(id: string) {
  const [row] = await db
    .select()
    .from(schema.privacyExportArtifacts)
    .where(eq(schema.privacyExportArtifacts.id, id));
  return row!;
}

async function request(id: string) {
  const [row] = await db
    .select()
    .from(schema.privacyRequests)
    .where(eq(schema.privacyRequests.id, id));
  return row!;
}

async function readyExport(prefix: string) {
  const user = await register(prefix);
  const created = await createExport(user.token);
  expect(created.statusCode).toBe(202);
  const id = created.json().id as string;
  await processor().runDue(5);
  expect((await artifact(id)).state).toBe('ready');
  return { user, id };
}

const ADMIN_PASSWORD = 'admin-password-123';
async function createAdmin(prefix: string) {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@gogo.id.vn`;
  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: prefix, role: 'ops_admin' })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: ADMIN_PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  return { id: row!.id, token: res.json().accessToken as string };
}

async function createExportRequest(ops: { token: string }, userId: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/privacy-requests',
    remoteAddress: ip(),
    headers: auth(ops.token),
    payload: { type: 'export', subjectType: 'user', userId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

function execute(ops: { token: string }, requestId: string, headers: Record<string, string> = {}) {
  return api().inject({
    method: 'POST',
    url: `/v1/cms/privacy-requests/${requestId}/execute`,
    remoteAddress: ip(),
    headers: { ...auth(ops.token), ...headers },
  });
}

function deliver(ops: { token: string }, requestId: string, deliveryMethod: string) {
  return api().inject({
    method: 'POST',
    url: `/v1/cms/privacy-requests/${requestId}/delivered`,
    remoteAddress: ip(),
    headers: auth(ops.token),
    payload: { deliveryMethod },
  });
}

/** Backends of this database waiting on a lock: how a test sees "it is blocked". */
async function lockWaiters(): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n from pg_stat_activity
     where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return rows[0].n as number;
}

async function until(condition: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await sleep(25);
  }
}

/** Objects in storage for this artifact that nothing would ever delete. */
async function orphansFor(id: string): Promise<string[]> {
  const row = await artifact(id);
  const records = await db
    .select({ objectKey: schema.privacyExportAttemptObjects.objectKey })
    .from(schema.privacyExportAttemptObjects)
    .where(eq(schema.privacyExportAttemptObjects.artifactId, id));
  // A pending artifact's object_key is a stale pointer the next claim discards;
  // only a published artifact's key is a reference that keeps its object.
  const covered = new Set([
    ...records.map((r) => r.objectKey),
    ...(row.state === 'ready' || row.state === 'consumed' ? [row.objectKey] : []),
  ]);
  return [...storage.objects.keys()].filter(
    (k) => k.startsWith(`privacy-exports/${id}/`) && !covered.has(k),
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_privacy_export_round2_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.EXPORT_WRAPPING_KEY_V1 = WRAPPING_KEY;

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const { createApp } = await import('../src/main.js');
  app = await createApp({ logDestination: new Writable({ write: (_c, _e, done) => done() }) });
  await app.init();
  await api().ready();
  storage = app.get<FakeStorage>(STORAGE_PROVIDER);
}, 180_000);

afterAll(async () => {
  delete process.env.EXPORT_WRAPPING_KEY_V1;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('A-F-09: legacy CMS replay records', () => {
  /** What the generic interceptor stored for these routes before alpha.66. */
  async function seedLegacyRecord(input: {
    adminId: string;
    endpoint: string;
    clientKey: string;
    body: unknown;
    stored: unknown;
  }) {
    const actorScope = `admin:${input.adminId}`;
    await db.insert(schema.idempotencyKeys).values({
      key: sha256(`${actorScope}|${input.endpoint}|${input.clientKey}`),
      actorId: actorScope,
      endpoint: input.endpoint,
      requestHash: sha256(JSON.stringify(input.body)),
      responseStatus: 201,
      responseBody: input.stored,
      expiresAt: new Date(Date.now() + 23 * 3_600_000),
    });
    return sha256(`${actorScope}|${input.endpoint}|${input.clientKey}`);
  }

  it('a pre-deploy record on the direct user export is purged, never replayed; the new record is versioned metadata', async () => {
    const ops = await createAdmin('af09a');
    const user = await register('af09a');
    const clientKey = `legacy-${randomUUID()}`;
    const body = { reason: 'legacy replay' };
    const storedKey = await seedLegacyRecord({
      adminId: ops.id,
      endpoint: 'POST /v1/cms/users/:id/export',
      clientKey,
      body,
      stored: { profile: { email: user.email, displayName: 'Marker' }, savedItems: [] },
    });
    const first = await api().inject({
      method: 'POST',
      url: `/v1/cms/users/${user.userId}/export`,
      remoteAddress: ip(),
      headers: { ...auth(ops.token), 'idempotency-key': clientKey },
      payload: body,
    });
    expect(first.statusCode).toBe(202);
    expect(first.headers['x-idempotent-replay']).toBeUndefined();
    expect(first.body).not.toContain(user.email);
    expect(first.json().export).toMatchObject({ status: 'pending', initiatedBy: 'support' });

    const [record] = await db
      .select()
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, storedKey));
    expect(record!.responseStatus).toBe(202);
    expect(record!.responseBody).toMatchObject({ v: 1, body: { export: { status: 'pending' } } });
    expect(JSON.stringify(record!.responseBody)).not.toContain(user.email);

    // A genuine replay of the versioned record answers the same metadata.
    const replay = await api().inject({
      method: 'POST',
      url: `/v1/cms/users/${user.userId}/export`,
      remoteAddress: ip(),
      headers: { ...auth(ops.token), 'idempotency-key': clientKey },
      payload: body,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
  });

  it('a pre-deploy record on execute is purged, never replayed', async () => {
    const ops = await createAdmin('af09b');
    const user = await register('af09b');
    const requestId = await createExportRequest(ops, user.userId);
    const clientKey = `legacy-${randomUUID()}`;
    const storedKey = await seedLegacyRecord({
      adminId: ops.id,
      endpoint: 'POST /v1/cms/privacy-requests/:id/execute',
      clientKey,
      body: null, // execute carries no body; the interceptor hashes `null`
      stored: { request: { id: requestId }, data: { profile: { email: user.email } } },
    });
    const res = await execute(ops, requestId, { 'idempotency-key': clientKey });
    expect(res.statusCode).toBe(202);
    expect(res.headers['x-idempotent-replay']).toBeUndefined();
    expect(res.body).not.toContain(user.email);
    expect(res.json()).not.toHaveProperty('data');
    const [record] = await db
      .select()
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, storedKey));
    expect(record!.responseBody).toMatchObject({ v: 1, body: { request: { id: requestId } } });
    expect(JSON.stringify(record!.responseBody)).not.toContain(user.email);
  });

  it('S-F-18: a pre-deploy deletion replay (`{ request }`) on execute is adopted as v1 and still replays', async () => {
    const ops = await createAdmin('sf18');
    const user = await register('sf18');
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/privacy-requests',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { type: 'delete', subjectType: 'user', userId: user.userId },
    });
    const requestId = created.json().id as string;
    // Executed and closed before the deploy; its old answer is in the record.
    await db
      .update(schema.privacyRequests)
      .set({ status: 'closed', outcome: 'completed', closedAt: sql`now()` })
      .where(eq(schema.privacyRequests.id, requestId));
    const legacy = { request: { id: requestId, type: 'delete', status: 'closed' } };
    const clientKey = `legacy-${randomUUID()}`;
    const storedKey = await seedLegacyRecord({
      adminId: ops.id,
      endpoint: 'POST /v1/cms/privacy-requests/:id/execute',
      clientKey,
      body: null,
      stored: legacy,
    });
    const res = await execute(ops, requestId, { 'idempotency-key': clientKey });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-idempotent-replay']).toBe('true');
    expect(res.json()).toEqual(legacy);
    const [record] = await db
      .select()
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.key, storedKey));
    expect(record!.responseBody).toEqual({ v: 1, body: legacy });
  });

  it('migration 0070 purges the stored raw payloads of both routes (upgrade from a populated database)', async () => {
    const dbName = `gogo_upgrade_${randomUUID().slice(0, 8)}`;
    await pool.query(`create database ${dbName}`);
    const upgradePool = new Pool({
      connectionString: container.getConnectionUri().replace(/\/[^/]+$/, `/${dbName}`),
      max: 2,
    });
    upgradePool.on('error', () => undefined);
    const upgradeDb = drizzle(upgradePool, { schema });
    const staged = mkdtempSync(path.join(tmpdir(), 'gogo-migrations-'));
    try {
      // The database as it is the moment before 0070 runs: every earlier
      // migration applied, and the old interceptor's records in place.
      cpSync(MIGRATIONS, staged, { recursive: true });
      const journalPath = path.join(staged, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((e) => !e.tag.startsWith('0070_'));
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(upgradeDb, { migrationsFolder: staged });

      const legacy: { endpoint: string; status: number | null; body: unknown }[] = [
        {
          endpoint: 'POST /v1/cms/users/:id/export',
          status: 201,
          body: { profile: { email: 'legacy-user@example.com' } },
        },
        {
          endpoint: 'POST /v1/cms/privacy-requests/:id/execute',
          status: 201,
          body: { request: { id: 'r' }, data: { profile: { email: 'legacy-exec@example.com' } } },
        },
        // S-F-18: a deletion's answer is metadata and must keep replaying.
        {
          endpoint: 'POST /v1/cms/privacy-requests/:id/execute',
          status: 201,
          body: { request: { id: 'deletion-replay' } },
        },
        // S-F-17: a claim still in flight is not a stored payload; purging it
        // would let the retry re-claim the key and run beside the original.
        { endpoint: 'POST /v1/cms/users/:id/export', status: null, body: null },
        { endpoint: 'POST /v1/rooms', status: 201, body: { id: 'room-untouched' } },
      ];
      for (const row of legacy) {
        await upgradeDb.insert(schema.idempotencyKeys).values({
          key: sha256(`${row.endpoint}|${randomUUID()}`),
          actorId: 'admin:legacy',
          endpoint: row.endpoint,
          requestHash: 'h',
          responseStatus: row.status,
          responseBody: row.body,
          expiresAt: new Date(Date.now() + 23 * 3_600_000),
        });
      }

      await migrate(upgradeDb, { migrationsFolder: MIGRATIONS });
      const left = await upgradeDb
        .select({
          endpoint: schema.idempotencyKeys.endpoint,
          status: schema.idempotencyKeys.responseStatus,
          body: schema.idempotencyKeys.responseBody,
        })
        .from(schema.idempotencyKeys);
      expect(
        left
          .map((r) => `${r.endpoint} ${r.status ?? 'in-flight'} ${JSON.stringify(r.body)}`)
          .sort(),
      ).toEqual([
        'POST /v1/cms/privacy-requests/:id/execute 201 {"request":{"id":"deletion-replay"}}',
        'POST /v1/cms/users/:id/export in-flight null',
        'POST /v1/rooms 201 {"id":"room-untouched"}',
      ]);
    } finally {
      rmSync(staged, { recursive: true, force: true });
      await upgradePool.end();
    }
  }, 120_000);
});

describe('A-F-02: disconnect during redemption', () => {
  it('a client that leaves while the ciphertext is fetched neither consumes the export nor keeps a download slot', async () => {
    const { user, id } = await readyExport('af02');
    const service = app.get(PrivacyExportService);
    if (!api().server.listening) await api().listen({ port: 0, host: '127.0.0.1' });
    const { port } = api().server.address() as { port: number };

    // The server-side socket's close is what the response observes; wait for
    // it, not for a timer, before letting the storage read return.
    const serverSocketClosed = new Promise<void>((resolve) => {
      api().server.once('connection', (socket) => socket.once('close', () => resolve()));
    });
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/v1/me/exports/${id}/download`,
      headers: auth(user.token),
    });
    req.on('error', () => undefined);
    const original = storage.getObject.bind(storage);
    const fetched = new Promise<void>((resolve) => {
      storage.getObject = async (key, options) => {
        req.destroy();
        await serverSocketClosed;
        resolve();
        return original(key, options);
      };
    });
    req.end();
    try {
      await fetched;
    } finally {
      storage.getObject = original;
    }

    await until(() => service.downloadsInFlight === 0, 5_000);
    const row = await artifact(id);
    expect(row.state).toBe('ready');
    expect(row.consumedAt).toBeNull();
    expect(row.transferOutcome).toBeNull();
    // The slot is free and the export is still the subject's to redeem.
    expect((await download(user.token, id)).statusCode).toBe(200);
  });
});

describe('S-F-16: disconnect during the consumption lock wait', () => {
  it('a client that leaves while consumption waits on the user row is not consumed', async () => {
    const { user, id } = await readyExport('sf16');
    const service = app.get(PrivacyExportService);
    if (!api().server.listening) await api().listen({ port: 0, host: '127.0.0.1' });
    const { port } = api().server.address() as { port: number };
    const holder = await pool.connect();
    await holder.query('begin');
    await holder.query('select 1 from users where id = $1 for update', [user.userId]);
    const serverSocketClosed = new Promise<void>((resolve) => {
      api().server.once('connection', (socket) => socket.once('close', () => resolve()));
    });
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/v1/me/exports/${id}/download`,
      headers: auth(user.token),
    });
    req.on('error', () => undefined);
    req.end();
    try {
      // The ciphertext is read and authenticated; consumption now waits on
      // the user row. The client leaves during that wait.
      await until(async () => (await lockWaiters()) >= 1);
      req.destroy();
      await serverSocketClosed;
    } finally {
      await holder.query('commit');
      holder.release();
    }
    await until(() => service.downloadsInFlight === 0, 5_000);
    const row = await artifact(id);
    expect(row.state).toBe('ready');
    expect(row.consumedAt).toBeNull();
    expect((await download(user.token, id)).statusCode).toBe(200);
  });
});

describe('A-F-01: permit delayed by a lock wait', () => {
  it('covers the upload from the wall clock after the wait, not the transaction start', async () => {
    const user = await register('af01');
    const id = (await createExport(user.token)).json().id as string;
    const holder = await pool.connect();
    try {
      const report = await processor({
        uploadTimeoutMs: 300, // cover 900 ms from the permit
        beforeUpload: async () => {
          await holder.query('begin');
          await holder.query('select 1 from privacy_export_artifacts where id = $1 for update', [
            id,
          ]);
          // The permit waits on this row for longer than the whole cover.
          setTimeout(() => void holder.query('commit').catch(() => undefined), 1_500);
        },
      }).runDue(1);
      expect(report).toMatchObject({ published: 1, retry_scheduled: 0 });
    } finally {
      holder.release();
    }
    expect((await artifact(id)).state).toBe('ready');
  });
});

describe('A-F-04: upload permit', () => {
  it('a deletion record reaped during a slow collection cannot leave the upload orphaned', async () => {
    const user = await register('af04a');
    const id = (await createExport(user.token)).json().id as string;
    const original = storage.putObject.bind(storage);
    storage.putObject = async (key, body, contentType, options) => {
      // The sweep runs while this attempt is still on its way to the PUT.
      if (key.includes(id)) await reapAttemptObjects(db as unknown as Db, storage);
      return original(key, body, contentType, options);
    };
    try {
      const opts = { attemptGraceMs: 1, uploadTimeoutMs: 5_000 };
      await processor(opts).runDue(1);
      await processor(opts).runDue(1); // a second claim, if the first could not publish
    } finally {
      storage.putObject = original;
    }
    expect(await orphansFor(id)).toEqual([]);
    expect((await artifact(id)).state).toBe('ready');
  });

  it('an attempt whose record was reaped before the permit uploads nothing and a fresh attempt publishes', async () => {
    const user = await register('af04b');
    const id = (await createExport(user.token)).json().id as string;
    const puts: string[] = [];
    const original = storage.putObject.bind(storage);
    storage.putObject = async (key, body, contentType, options) => {
      if (key.includes(id)) puts.push(key);
      return original(key, body, contentType, options);
    };
    try {
      const report = await processor({
        attemptGraceMs: 1,
        beforeUpload: async () => {
          await reapAttemptObjects(db as unknown as Db, storage);
        },
      }).runDue(1);
      expect(report.retry_scheduled).toBe(1);
      expect(puts).toEqual([]);
      await db
        .update(schema.privacyExportArtifacts)
        .set({ nextAttemptAt: sql`now()` })
        .where(eq(schema.privacyExportArtifacts.id, id));
      await processor().runDue(1);
    } finally {
      storage.putObject = original;
    }
    const row = await artifact(id);
    expect(row.state).toBe('ready');
    expect(row.attempt).toBe(2);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toContain(`/${id}/2-`);
    expect(await orphansFor(id)).toEqual([]);
  });

  it('an attempt whose lease was re-claimed during collection makes no upload', async () => {
    const user = await register('af04c');
    const id = (await createExport(user.token)).json().id as string;
    const puts: string[] = [];
    const original = storage.putObject.bind(storage);
    storage.putObject = async (key, body, contentType, options) => {
      if (key.includes(id)) puts.push(key);
      return original(key, body, contentType, options);
    };
    try {
      const stale = processor({
        beforeUpload: async () => {
          // The lease lapses while this attempt is still collecting...
          await db
            .update(schema.privacyExportArtifacts)
            .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
            .where(eq(schema.privacyExportArtifacts.id, id));
          // ...and another worker claims and publishes it.
          expect((await processor().runDue(1)).published).toBe(1);
        },
      });
      expect((await stale.runDue(1)).fenced).toBe(1);
    } finally {
      storage.putObject = original;
    }
    const row = await artifact(id);
    expect(row).toMatchObject({ state: 'ready', attempt: 2 });
    expect(puts.filter((k) => k.includes(`/${id}/1-`))).toEqual([]);
    expect(puts.filter((k) => k.includes(`/${id}/2-`))).toHaveLength(1);
  });
});

describe('A-F-10: reaper versus publication', () => {
  it('the reaper never deletes the object of an attempt a publication is committing', async () => {
    const user = await register('af10');
    const id = (await createExport(user.token)).json().id as string;
    const requestId = (await artifact(id)).privacyRequestId!;
    // The publication transaction blocks at the ledger update, after it has
    // deleted the attempt record and before it commits.
    const holder = await pool.connect();
    await holder.query('begin');
    await holder.query('select 1 from privacy_requests where id = $1 for update', [requestId]);
    let objectKey = '';
    const run = processor({
      afterUpload: async () => {
        objectKey = (await artifact(id)).objectKey!;
        // The record becomes due 1.5 s from now: inside publication's check,
        // outside it by the time the reaper looks.
        await db
          .update(schema.privacyExportAttemptObjects)
          .set({ deleteAfter: sql`now() + interval '1500 milliseconds'` })
          .where(eq(schema.privacyExportAttemptObjects.objectKey, objectKey));
      },
    }).runDue(1);
    try {
      await until(async () => (await lockWaiters()) >= 1);
      await sleep(1_600);
      const reap = reapAttemptObjects(db as unknown as Db, storage);
      await sleep(300); // long enough for an unlocked select + a storage delete
      await holder.query('commit');
      holder.release();
      expect((await run).published).toBe(1);
      await reap;
    } catch (err) {
      holder.release();
      throw err;
    }
    const row = await artifact(id);
    expect(row.state).toBe('ready');
    expect(row.objectKey).toBe(objectKey);
    expect(storage.objects.has(objectKey)).toBe(true);
    expect(storage.deleted).not.toContain(objectKey);
  });

  it('once the reaper owns a record, publication refuses it and the next attempt takes a fresh key', async () => {
    const user = await register('af10b');
    const id = (await createExport(user.token)).json().id as string;
    let firstKey = '';
    const report = await processor({
      afterUpload: async () => {
        firstKey = (await artifact(id)).objectKey!;
        // The upload's cover has run out before publication gets to it...
        await db
          .update(schema.privacyExportAttemptObjects)
          .set({ deleteAfter: sql`now()` })
          .where(eq(schema.privacyExportAttemptObjects.objectKey, firstKey));
        // ...the reaper claims the due record, but its storage delete is refused.
        storage.failWrites = true;
        try {
          await reapAttemptObjects(db as unknown as Db, storage);
        } finally {
          storage.failWrites = false;
        }
      },
    }).runDue(1);
    expect(report.retry_scheduled).toBe(1);
    const [record] = await db
      .select()
      .from(schema.privacyExportAttemptObjects)
      .where(eq(schema.privacyExportAttemptObjects.objectKey, firstKey));
    expect(record!.reapingSince).not.toBeNull();
    await db
      .update(schema.privacyExportAttemptObjects)
      .set({ deleteAfter: sql`now()` })
      .where(eq(schema.privacyExportAttemptObjects.id, record!.id));
    await reapAttemptObjects(db as unknown as Db, storage);
    expect(storage.objects.has(firstKey)).toBe(false);
    await db
      .update(schema.privacyExportArtifacts)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(schema.privacyExportArtifacts.id, id));
    await processor().runDue(1);
    const row = await artifact(id);
    expect(row.state).toBe('ready');
    expect(row.objectKey).not.toBe(firstKey);
    expect(await orphansFor(id)).toEqual([]);
  });
});

describe('S-F-11: sweep without wrapping keys', () => {
  it('a worker without a key sweeps but never claims', async () => {
    const keyless = processor({}, null);
    expect(keyless.canGenerate).toBe(false);
    const user = await register('sf11');
    const id = (await createExport(user.token)).json().id as string;
    const report = await keyless.runDue(5);
    expect(Object.values(report).reduce((a, b) => a + b, 0)).toBe(0);
    expect((await artifact(id)).state).toBe('pending');
    expect((await artifact(id)).attempt).toBe(0);

    const ready = await readyExport('sf11-ready');
    const key = (await artifact(ready.id)).objectKey!;
    await db
      .update(schema.privacyExportArtifacts)
      .set({ expiresAt: sql`now()` })
      .where(eq(schema.privacyExportArtifacts.id, ready.id));
    const swept = await keyless.sweep();
    expect(swept.expired).toBe(1);
    expect(swept.cleanup.deleted).toBe(1);
    expect(storage.objects.has(key)).toBe(false);
  });
});

describe('S-F-13: private storage under test', () => {
  it('the privacy module and the suite share one storage', () => {
    expect(app.get(PRIVACY_EXPORT_STORAGE)).toBe(app.get(STORAGE_PROVIDER));
  });
});

describe('A-F-07: reconciliation versus re-execution', () => {
  it('a re-execution committed while reconciliation waited on the request lock is seen', async () => {
    const user = await register('af07');
    const id = (await createExport(user.token)).json().id as string;
    const requestId = (await artifact(id)).privacyRequestId!;
    await db
      .update(schema.users)
      .set({ passwordHash: 'rotated-before-ready' })
      .where(eq(schema.users.id, user.userId));
    expect((await artifact(id)).state).toBe('revoked');

    const holder = await pool.connect();
    await holder.query('begin');
    await holder.query('select 1 from privacy_requests where id = $1 for update', [requestId]);
    const sweeping = processor().sweep();
    try {
      await until(async () => (await lockWaiters()) >= 1);
      // The re-execution: a live artifact for the same request, committed
      // while reconciliation is blocked on the row.
      await holder.query(
        `insert into privacy_export_artifacts
           (subject_user_id, privacy_request_id, initiator_type, initiator_id, state, subject_epoch)
         values ($1, $2, 'admin', $3, 'pending', 1)`,
        [user.userId, requestId, randomUUID()],
      );
      await holder.query('commit');
    } finally {
      holder.release();
    }
    await sweeping;
    expect(await request(requestId)).toMatchObject({ status: 'in_progress', outcome: null });
  });
});

describe('A-F-06 / S-F-12: delivery ownership on the ledger', () => {
  it('delivery stays server-owned after the artifact tombstone is purged', async () => {
    const ops = await createAdmin('af06');
    const user = await register('af06');
    const requestId = await createExportRequest(ops, user.userId);
    const executed = await execute(ops, requestId);
    expect(executed.statusCode).toBe(202);
    const exportId = executed.json().export.id as string;
    expect((await request(requestId)).secureDelivery).toBe(true);

    // The artifact lives its life; thirty-one days later its tombstone goes.
    await db
      .update(schema.privacyExportArtifacts)
      .set({
        state: 'expired',
        expiredAt: sql`now()`,
        objectKey: null,
        cleanupDueAt: sql`now()`,
        cleanedAt: sql`now() - interval '31 days'`,
      })
      .where(eq(schema.privacyExportArtifacts.id, exportId));
    expect((await processor().sweep()).tombstonesPurged).toBeGreaterThanOrEqual(1);
    expect(
      await db
        .select()
        .from(schema.privacyExportArtifacts)
        .where(eq(schema.privacyExportArtifacts.id, exportId)),
    ).toHaveLength(0);

    for (const method of ['in_app', 'other']) {
      const res = await deliver(ops, requestId, method);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DELIVERY_SERVER_OWNED');
    }
    const row = await request(requestId);
    expect(row.deliveredAt).toBeNull();
    expect(row.deliveryMethod).toBeNull();
  });

  it('S-F-19: a manual delivery that wins the request lock first makes the execution refuse', async () => {
    const ops = await createAdmin('sf19');
    const user = await register('sf19');
    const requestId = await createExportRequest(ops, user.userId);
    const holder = await pool.connect();
    await holder.query('begin');
    await holder.query('select 1 from privacy_requests where id = $1 for update', [requestId]);
    let settled: [Awaited<ReturnType<typeof deliver>>, Awaited<ReturnType<typeof execute>>];
    try {
      // The manual delivery queues on the row first...
      const delivering = deliver(ops, requestId, 'in_app');
      await until(async () => (await lockWaiters()) >= 1);
      // ...and the execution behind it.
      const executing = execute(ops, requestId);
      await until(async () => (await lockWaiters()) >= 2);
      await holder.query('commit');
      settled = await Promise.all([delivering, executing]);
    } finally {
      holder.release();
    }
    const [delivered, executed] = settled;
    expect(delivered.statusCode).toBe(201);
    expect(executed.statusCode).toBe(409);
    expect(executed.json().code).toBe('ALREADY_DELIVERED');
    const row = await request(requestId);
    expect(row).toMatchObject({ secureDelivery: false, deliveryMethod: 'in_app' });
    expect(row.deliveredAt).not.toBeNull();
    expect(
      await db
        .select()
        .from(schema.privacyExportArtifacts)
        .where(eq(schema.privacyExportArtifacts.privacyRequestId, requestId)),
    ).toHaveLength(0);
  });

  it('/delivered cannot slip a manual method under a concurrent execution', async () => {
    const ops = await createAdmin('sf12');
    const user = await register('sf12');
    const requestId = await createExportRequest(ops, user.userId);
    const holder = await pool.connect();
    await holder.query('begin');
    await holder.query('select 1 from privacy_requests where id = $1 for update', [requestId]);
    let settled: [Awaited<ReturnType<typeof execute>>, Awaited<ReturnType<typeof deliver>>];
    try {
      // Execution reaches the ledger link first and queues on the row...
      const executing = execute(ops, requestId);
      await until(async () => (await lockWaiters()) >= 1);
      // ...then the manual delivery queues behind it.
      const delivering = deliver(ops, requestId, 'in_app');
      await until(async () => (await lockWaiters()) >= 2);
      await holder.query('commit');
      settled = await Promise.all([executing, delivering]);
    } finally {
      holder.release();
    }
    const [executed, delivered] = settled;
    expect(executed.statusCode).toBe(202);
    expect(delivered.statusCode).toBe(409);
    expect(delivered.json().code).toBe('DELIVERY_SERVER_OWNED');
    const row = await request(requestId);
    expect(row.secureDelivery).toBe(true);
    expect(row.deliveredAt).toBeNull();
    expect(row.deliveryMethod).toBeNull();
  });
});
