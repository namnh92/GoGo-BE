import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema, type Db } from '@gogo/database';
import {
  PrivacyExportProcessor,
  PrivacyExportService,
  collectUserExport,
  parseExportKeyring,
  type PrivacyExportProcessorOptions,
} from '@gogo/modules';
import { STORAGE_PROVIDER, type FakeStorage } from '@gogo/providers';

/**
 * PR #677 — regression tests for the SA review findings F-01..F-07 (F-08 is a
 * unit test in env.spec.ts). Each one fails on a279c34 for the reason the
 * finding names and passes after the fix. Races use controlled interleaving:
 * a wrapped storage call or a held row lock, never timing luck.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let storage: FakeStorage;
const logLines: string[] = [];
const WRAPPING_KEY = randomBytes(32).toString('base64');
const keyring = parseExportKeyring({ EXPORT_WRAPPING_KEY_V1: WRAPPING_KEY })!;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.56.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const idem = () => `exp-${randomUUID()}`;

type User = { token: string; userId: string; email: string; cookies: Record<string, string> };

async function register(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: `Marker ${prefix}` },
  });
  expect(res.statusCode).toBe(201);
  const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  return { token: res.json().accessToken, userId: res.json().userId, email, cookies };
}

function createExport(token: string, key: string | null = idem()) {
  return api().inject({
    method: 'POST',
    url: '/v1/me/exports',
    remoteAddress: ip(),
    headers: { ...auth(token), ...(key ? { 'idempotency-key': key } : {}) },
  });
}

function download(token: string, id: string, headers: Record<string, string> = {}) {
  return api().inject({
    method: 'POST',
    url: `/v1/me/exports/${id}/download`,
    remoteAddress: ip(),
    headers: { ...auth(token), ...headers },
  });
}

function processor(overrides: Partial<PrivacyExportProcessorOptions> = {}) {
  return new PrivacyExportProcessor(db as unknown as Db, storage, keyring, {
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

/** Creates an export for a fresh user and runs the worker until it is ready. */
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
async function createAdmin(email: string, role: 'ops_admin' | 'editor') {
  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: email.split('@')[0]!, role })
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_privacy_export_review_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.EXPORT_WRAPPING_KEY_V1 = WRAPPING_KEY;
  process.env.LOG_LEVEL = 'debug';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp({
    logDestination: new Writable({
      write(chunk, _enc, done) {
        logLines.push(String(chunk));
        done();
      },
    }),
  });
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

async function sessionOf(userId: string) {
  const [session] = await db
    .select()
    .from(schema.authSessions)
    .where(eq(schema.authSessions.userId, userId));
  return { type: 'user' as const, id: userId, sessionId: session!.id };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PR #677 SA review findings', () => {
  it('F-01: a sign-out committed while the ciphertext is fetched stops the release', async () => {
    const { user, id } = await readyExport('f01');
    const original = storage.getObject.bind(storage);
    storage.getObject = async (key, options) => {
      const found = await original(key, options);
      // The user signs out on another instance mid-redemption (DB only).
      await db
        .update(schema.authSessions)
        .set({ revokedAt: sql`now()`, revokeReason: 'logout' })
        .where(eq(schema.authSessions.userId, user.userId));
      return found;
    };
    let res;
    try {
      res = await download(user.token, id);
    } finally {
      storage.getObject = original;
    }
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(user.email);
    expect((await artifact(id)).state).toBe('ready');
  });

  it('F-02: the download slot is held until the transfer is finalized', async () => {
    const service = app.get(PrivacyExportService);
    const ready = [];
    for (let i = 0; i < 5; i += 1) ready.push(await readyExport(`f02-${i}`));
    const held = [];
    for (const { user, id } of ready.slice(0, 4)) {
      held.push(await service.redeem(await sessionOf(user.userId), id));
    }
    const fifth = ready[4]!;
    try {
      await expect(
        service.redeem(await sessionOf(fifth.user.userId), fifth.id),
      ).rejects.toMatchObject({ code: 'EXPORT_BUSY' });
      await held[0]!.finalize('completed');
      const admitted = await service.redeem(await sessionOf(fifth.user.userId), fifth.id);
      held.push(admitted);
    } finally {
      for (const h of held) await h.finalize('completed');
    }
  });

  it('F-03: collection is paged and stops on the byte budget, not after reading everything', async () => {
    const user = await register('f03');
    const rows = Array.from({ length: 3000 }, () => ({
      userId: user.userId,
      targetType: 'place' as const,
      targetId: randomUUID(),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(schema.savedItems).values(rows.slice(i, i + 500));
    }
    const queries: string[] = [];
    const logged = drizzle(pool, {
      schema,
      logger: { logQuery: (query: string) => void queries.push(query) },
    });
    await expect(
      collectUserExport(
        logged as unknown as Db,
        user.userId,
        { actorType: 'user', actorId: user.userId },
        { mediaPublicBaseUrl: '', maxBytes: 4_000 },
      ),
    ).rejects.toMatchObject({ name: 'ExportTooLargeError' });
    const savedQueries = queries.filter((q) => q.includes('"saved_items"'));
    expect(savedQueries.length).toBeGreaterThan(0);
    expect(savedQueries.every((q) => / limit /i.test(q))).toBe(true);
    // 3000 rows would take six pages; the budget is spent inside the first.
    expect(savedQueries.length).toBe(1);
  });

  it('F-04: an upload that lands after revocation cleanup is still deleted', async () => {
    const user = await register('f04');
    const id = (await createExport(user.token)).json().id as string;
    const original = storage.putObject.bind(storage);
    let raced = false;
    storage.putObject = async (key, body, contentType, options) => {
      if (!raced && key.includes(id)) {
        raced = true;
        // Revocation and its cleanup run while the PUT is in flight...
        await db
          .update(schema.users)
          .set({ passwordHash: 'rotated-mid-upload' })
          .where(eq(schema.users.id, user.userId));
        await processor().sweep();
        expect((await artifact(id)).cleanedAt).not.toBeNull();
      }
      // ...and only then does storage accept the bytes.
      return original(key, body, contentType, options);
    };
    let key = '';
    try {
      // Round 2 (A-F-04/A-F-01): the record covers 3 × the upload deadline
      // from the permit, so a short deadline keeps this test's wait short.
      await processor({
        attemptGraceMs: 1_000,
        uploadTimeoutMs: 300,
        afterUpload: async () => {
          key = [...storage.objects.keys()].find((k) => k.includes(id)) ?? '';
        },
      }).runDue(1);
    } finally {
      storage.putObject = original;
    }
    expect(key).not.toBe('');
    expect((await artifact(id)).state).toBe('revoked');
    await sleep(1_100);
    await processor().sweep();
    expect(storage.objects.has(key)).toBe(false);
  });

  it('F-05: expiry is judged on the wall clock after the locks, not at transaction start', async () => {
    const { user, id } = await readyExport('f05');
    await db
      .update(schema.privacyExportArtifacts)
      .set({ expiresAt: sql`now() + interval '1500 milliseconds'` })
      .where(eq(schema.privacyExportArtifacts.id, id));
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from users where id = $1 for update', [user.userId]);
      const pending = download(user.token, id);
      await sleep(2_000); // the export expires while consumption waits for the lock
      await holder.query('commit');
      const res = await pending;
      expect(res.statusCode).toBe(410);
      expect(res.body).not.toContain(user.email);
    } finally {
      holder.release();
    }
    expect((await artifact(id)).consumedAt).toBeNull();
  });

  it('F-06: no manual delivery method can be recorded on an artifact-backed request', async () => {
    const ops = await createAdmin(`f06-${randomUUID().slice(0, 6)}@gogo.id.vn`, 'ops_admin');
    const user = await register('f06');
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/privacy-requests',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { type: 'export', subjectType: 'user', userId: user.userId },
    });
    const requestId = created.json().id;
    const executed = await api().inject({
      method: 'POST',
      url: `/v1/cms/privacy-requests/${requestId}/execute`,
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(executed.statusCode).toBe(202);
    for (const deliveryMethod of ['in_app', 'other']) {
      const res = await api().inject({
        method: 'POST',
        url: `/v1/cms/privacy-requests/${requestId}/delivered`,
        remoteAddress: ip(),
        headers: auth(ops.token),
        payload: { deliveryMethod },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DELIVERY_SERVER_OWNED');
    }
    const [request] = await db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, requestId));
    expect(request!.deliveredAt).toBeNull();
    expect(request!.deliveryMethod).toBeNull();
  });

  it('F-07: a request whose export was revoked before it was ready closes failed, once', async () => {
    const user = await register('f07');
    const id = (await createExport(user.token)).json().id as string;
    const requestId = (await artifact(id)).privacyRequestId!;
    await db
      .update(schema.users)
      .set({ passwordHash: 'rotated-before-ready' })
      .where(eq(schema.users.id, user.userId));
    expect((await artifact(id)).state).toBe('revoked');
    const failedBefore = await db.execute(
      sql`select coalesce(sum(export_failed), 0)::int as n from privacy_metrics_monthly`,
    );
    await processor().sweep();
    await processor().sweep();
    const [request] = await db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, requestId));
    expect(request).toMatchObject({ status: 'closed', outcome: 'failed' });
    expect(request!.retentionAt).not.toBeNull();
    const failedAfter = await db.execute(
      sql`select coalesce(sum(export_failed), 0)::int as n from privacy_metrics_monthly`,
    );
    expect(
      (failedAfter.rows[0] as { n: number }).n - (failedBefore.rows[0] as { n: number }).n,
    ).toBe(1);
  });
});
