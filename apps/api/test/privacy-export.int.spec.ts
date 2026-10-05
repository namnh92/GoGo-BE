import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  type PrivacyExportProcessorOptions,
} from '@gogo/modules';
import { STORAGE_PROVIDER, type FakeStorage } from '@gogo/providers';

/**
 * GoGo-BE#256, ADR-0031 — secure export delivery, end to end against a real
 * Postgres: issuance, fenced generation, single-use redemption, revocation by
 * export epoch, expiry, cleanup, and the CMS paths that used to hand the raw
 * payload to an operator.
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

function status(token: string, id: string) {
  return api().inject({
    method: 'GET',
    url: `/v1/me/exports/${id}`,
    remoteAddress: ip(),
    headers: auth(token),
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
    .withDatabase('gogo_privacy_export_test')
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

describe('issuance (POST /me/exports)', () => {
  it('requires an Idempotency-Key', async () => {
    const user = await register('idem-required');
    const res = await createExport(user.token, null);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('accepts with 202 metadata; a same-key replay returns the same export and creates nothing', async () => {
    const user = await register('idem-replay');
    const key = idem();
    const first = await createExport(user.token, key);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: 'pending', initiatedBy: 'self' });
    expect(first.headers['cache-control']).toBe('no-store');

    const replay = await createExport(user.token, key);
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.json().id).toBe(first.json().id);

    const rows = await db
      .select()
      .from(schema.privacyExportArtifacts)
      .where(eq(schema.privacyExportArtifacts.subjectUserId, user.userId));
    expect(rows).toHaveLength(1);

    // The replay record holds the id only — never a payload.
    const records = await db.select().from(schema.idempotencyKeys);
    const mine = records.find(
      (r) => (r.responseBody as { exportId?: string } | null)?.exportId === first.json().id,
    );
    expect(mine?.responseBody).toEqual({ exportId: first.json().id });
  });

  it('one active export per subject; the conflict names the active one', async () => {
    const user = await register('one-active');
    const first = await createExport(user.token);
    const second = await createExport(user.token);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('EXPORT_ALREADY_ACTIVE');
    expect(second.json().field_errors[0]).toMatchObject({
      field: 'exportId',
      message: first.json().id,
    });
  });

  it('records a self-service ledger request that stays in_progress until the artifact exists', async () => {
    const user = await register('ledger');
    const created = await createExport(user.token);
    const row = await artifact(created.json().id);
    const [request] = await db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, row.privacyRequestId!));
    expect(request).toMatchObject({
      source: 'self_service',
      status: 'in_progress',
      type: 'export',
    });
    expect(request!.deliveredAt).toBeNull();
  });

  it('three generations per subject per hour; a fourth is 429 with Retry-After', async () => {
    const user = await register('rate');
    for (let i = 0; i < 3; i += 1) {
      const created = await createExport(user.token);
      expect(created.statusCode).toBe(202);
      // Free the slot so the active-artifact rule is not what refuses the next one.
      await db
        .update(schema.privacyExportArtifacts)
        .set({ state: 'failed', failureCode: 'test', cleanupDueAt: sql`now()` })
        .where(eq(schema.privacyExportArtifacts.id, created.json().id));
    }
    const fourth = await createExport(user.token);
    expect(fourth.statusCode).toBe(429);
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('guests and staff have no export to request or read', async () => {
    const ops = await createAdmin(`ops-${randomUUID().slice(0, 6)}@gogo.id.vn`, 'ops_admin');
    const res = await createExport(ops.token);
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('generation (worker)', () => {
  it('publishes once: encrypted object, ledger closed, counter, one notification', async () => {
    await processor().runDue(50); // drain artifacts other tests left pending
    const before = await db.execute(
      sql`select coalesce(sum(export_completed), 0)::int as n from privacy_metrics_monthly`,
    );
    const { user, id } = await readyExport('publish');
    const row = await artifact(id);
    expect(row.objectKey).toMatch(new RegExp(`^privacy-exports/${id}/1-`));
    expect(row.wrappedKey).toBeInstanceOf(Buffer);
    expect(row.keyVersion).toBe(1);
    expect(row.expiresAt!.getTime() - row.readyAt!.getTime()).toBe(24 * 3_600_000);

    // The stored bytes are ciphertext: neither the email nor the name appear.
    const stored = Buffer.from(storage.objects.get(row.objectKey!)!.body);
    expect(stored.includes(Buffer.from(user.email))).toBe(false);
    expect(stored.includes(Buffer.from('Marker publish'))).toBe(false);

    const [request] = await db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, row.privacyRequestId!));
    expect(request).toMatchObject({
      status: 'closed',
      outcome: 'completed',
      deliveryMethod: 'secure_download',
    });
    expect(request!.deliveredAt).toBeNull();

    // Running the worker again changes nothing: exactly once.
    await processor().runDue(5);
    const after = await db.execute(
      sql`select coalesce(sum(export_completed), 0)::int as n from privacy_metrics_monthly`,
    );
    expect((after.rows[0] as { n: number }).n - (before.rows[0] as { n: number }).n).toBe(1);
    const notes = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, user.userId));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'privacy_export_ready' });
    expect(Object.keys(notes[0]!.payload as object).sort()).toEqual(['expiresAt', 'exportId']);

    const inbox = await api().inject({
      method: 'GET',
      url: '/v1/me/notifications',
      remoteAddress: ip(),
      headers: auth(user.token),
    });
    expect(inbox.json().notifications[0]).toMatchObject({ kind: 'privacy_export_ready' });
  });

  it('oversize fails explicitly — nothing stored, request closed failed, never truncated', async () => {
    const user = await register('oversize');
    const created = await createExport(user.token);
    const id = created.json().id;
    const report = await processor({ maxPlaintextBytes: 64 }).runDue(5);
    expect(report.too_large).toBe(1);
    const row = await artifact(id);
    expect(row).toMatchObject({ state: 'failed', failureCode: 'too_large' });
    expect([...storage.objects.keys()].some((k) => k.includes(id))).toBe(false);
    const [request] = await db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, row.privacyRequestId!));
    expect(request).toMatchObject({ status: 'closed', outcome: 'failed' });
    expect((await status(user.token, id)).json()).toMatchObject({
      status: 'failed',
      failureCode: 'too_large',
    });
  });

  it('a crash after upload is retried with a fresh key; the abandoned object is queued for deletion', async () => {
    const user = await register('crash');
    const id = (await createExport(user.token)).json().id;
    await expect(
      processor({
        afterUpload: async () => {
          throw new Error('simulated crash');
        },
      }).runDue(1),
    ).rejects.toThrow('simulated crash');
    const crashed = await artifact(id);
    expect(crashed.state).toBe('generating');
    const abandonedKey = crashed.objectKey!;
    expect(storage.objects.has(abandonedKey)).toBe(true);

    // The lease lapses; the next worker takes over.
    await db
      .update(schema.privacyExportArtifacts)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.privacyExportArtifacts.id, id));
    await processor().runDue(1);
    const ready = await artifact(id);
    expect(ready.state).toBe('ready');
    expect(ready.attempt).toBe(2);
    expect(ready.objectKey).not.toBe(abandonedKey);
    // F-04: the abandoned attempt keeps its durable deletion record.
    const [record] = await db
      .select()
      .from(schema.privacyExportAttemptObjects)
      .where(eq(schema.privacyExportAttemptObjects.objectKey, abandonedKey));
    expect(record).toMatchObject({ artifactId: id });
    // The published attempt's record is gone: the artifact owns that object now.
    const published = await db
      .select()
      .from(schema.privacyExportAttemptObjects)
      .where(eq(schema.privacyExportAttemptObjects.objectKey, ready.objectKey!));
    expect(published).toHaveLength(0);
    void user;
  });

  it('a stale worker cannot publish over the attempt that fenced it off', async () => {
    const user = await register('fence');
    const id = (await createExport(user.token)).json().id;
    let staleKey = '';
    const stale = processor({
      afterUpload: async (artifactId) => {
        staleKey = (await artifact(artifactId)).objectKey!;
        // While the stale worker is paused, its lease lapses and another
        // worker runs the whole generation.
        await db
          .update(schema.privacyExportArtifacts)
          .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
          .where(eq(schema.privacyExportArtifacts.id, artifactId));
        const fresh = await processor().runDue(1);
        expect(fresh.published).toBe(1);
      },
    });
    const report = await stale.runDue(1);
    expect(report.fenced).toBe(1);
    const row = await artifact(id);
    expect(row.state).toBe('ready');
    expect(row.attempt).toBe(2);
    expect(row.objectKey).not.toBe(staleKey);
    const records = await db
      .select()
      .from(schema.privacyExportAttemptObjects)
      .where(eq(schema.privacyExportAttemptObjects.objectKey, staleKey));
    expect(records).toHaveLength(1);
    void user;
  });

  it('a password change between upload and publication revokes instead of publishing', async () => {
    const user = await register('race-password');
    const id = (await createExport(user.token)).json().id;
    const report = await processor({
      afterUpload: async () => {
        await db
          .update(schema.users)
          .set({ passwordHash: 'changed-hash' })
          .where(eq(schema.users.id, user.userId));
      },
    }).runDue(1);
    expect(report.revoked).toBe(1);
    const row = await artifact(id);
    expect(row).toMatchObject({ state: 'revoked', revokeReason: 'password_changed' });
    expect(row.wrappedKey).toBeNull();
    const notes = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, user.userId));
    expect(notes).toHaveLength(0);
    // The sweep removes the object the revoked attempt uploaded.
    const key = row.objectKey!;
    await processor().sweep();
    expect(storage.objects.has(key)).toBe(false);
    expect((await artifact(id)).cleanedAt).not.toBeNull();
  });
});

describe('redemption (POST /me/exports/{id}/download)', () => {
  it('serves the authenticated plaintext once, as a no-store attachment', async () => {
    const { user, id } = await readyExport('redeem');
    const res = await download(user.token, id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="gogo-export-/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['accept-ranges']).toBe('none');
    const body = JSON.parse(res.body);
    expect(body.profile.email).toBe(user.email);
    expect(JSON.stringify(body)).not.toMatch(/password/i);

    const replay = await download(user.token, id);
    expect(replay.statusCode).toBe(410);
    expect(replay.json().code).toBe('EXPORT_GONE');
    expect(replay.body).not.toContain(user.email);

    const row = await artifact(id);
    expect(row.state).toBe('consumed');
    expect(row.wrappedKey).toBeNull();
    expect(row.transferOutcome).toBe('completed');
    expect(row.transferCompletedAt).not.toBeNull();
    // Immediate cleanup after consumption.
    expect(row.cleanedAt).not.toBeNull();
    expect(row.objectKey).toBeNull();
    const [request] = await db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, row.privacyRequestId!));
    expect(request!.deliveredAt).not.toBeNull();
    expect(request!.deliveryMethod).toBe('secure_download');
  });

  it('GET never consumes; HEAD never consumes', async () => {
    const { user, id } = await readyExport('get-head');
    expect((await status(user.token, id)).json().status).toBe('ready');
    const head = await api().inject({
      method: 'HEAD',
      url: `/v1/me/exports/${id}`,
      remoteAddress: ip(),
      headers: auth(user.token),
    });
    expect(head.statusCode).toBe(200);
    const getDownload = await api().inject({
      method: 'GET',
      url: `/v1/me/exports/${id}/download`,
      remoteAddress: ip(),
      headers: auth(user.token),
    });
    expect(getDownload.statusCode).toBe(404);
    expect((await artifact(id)).state).toBe('ready');
  });

  it('concurrent redemptions: exactly one wins, every other is 410', async () => {
    const { user, id } = await readyExport('parallel');
    const results = await Promise.all([1, 2, 3, 4].map(() => download(user.token, id)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c !== 200).every((c) => c === 410)).toBe(true);
    const consumedAudits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, id),
          eq(schema.auditLogs.action, 'privacy_export.consumed'),
        ),
      );
    expect(consumedAudits).toHaveLength(1);
  });

  it('a same-key replay of the download gets no bytes', async () => {
    const { user, id } = await readyExport('replay-key');
    const key = idem();
    const first = await download(user.token, id, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    const second = await download(user.token, id, { 'idempotency-key': key });
    expect(second.statusCode).toBe(410);
    expect(second.body).not.toContain(user.email);
    const records = await db.select().from(schema.idempotencyKeys);
    expect(JSON.stringify(records)).not.toContain(user.email);
  });

  it('another account gets 404, never the export', async () => {
    const { id } = await readyExport('owner');
    const intruder = await register('intruder');
    expect((await download(intruder.token, id)).statusCode).toBe(404);
    expect((await status(intruder.token, id)).statusCode).toBe(404);
    expect((await artifact(id)).state).toBe('ready');
  });

  it('a not-yet-ready export is 409', async () => {
    const user = await register('not-ready');
    const id = (await createExport(user.token)).json().id;
    const res = await download(user.token, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EXPORT_NOT_READY');
  });

  it('cookie sessions need the CSRF header', async () => {
    const { user, id } = await readyExport('csrf');
    const cookieHeader = `gogo_at=${user.cookies.gogo_at}; gogo_csrf=${user.cookies.gogo_csrf}`;
    const without = await api().inject({
      method: 'POST',
      url: `/v1/me/exports/${id}/download`,
      remoteAddress: ip(),
      headers: { cookie: cookieHeader },
    });
    expect(without.statusCode).toBe(403);
    expect(without.json().code).toBe('CSRF_FAILED');
    expect((await artifact(id)).state).toBe('ready');
    const withHeader = await api().inject({
      method: 'POST',
      url: `/v1/me/exports/${id}/download`,
      remoteAddress: ip(),
      headers: { cookie: cookieHeader, 'x-gogo-csrf': user.cookies.gogo_csrf! },
    });
    expect(withHeader.statusCode).toBe(200);
  });

  it('a session revoked in the database is refused even when the cached denylist says nothing', async () => {
    const { user, id } = await readyExport('db-session');
    // Revoked in Postgres only — Redis/in-memory denylist untouched, as when
    // another instance logged out while Redis was down.
    await db
      .update(schema.authSessions)
      .set({ revokedAt: sql`now()`, revokeReason: 'test' })
      .where(eq(schema.authSessions.userId, user.userId));
    const res = await download(user.token, id);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('SESSION_REVOKED');
    expect((await artifact(id)).state).toBe('ready');
  });

  it('expiry: refused at the boundary, then expired and deleted by the sweep with audit', async () => {
    const { user, id } = await readyExport('expiry');
    const key = (await artifact(id)).objectKey!;
    await db
      .update(schema.privacyExportArtifacts)
      .set({ expiresAt: sql`now()` })
      .where(eq(schema.privacyExportArtifacts.id, id));
    expect((await download(user.token, id)).statusCode).toBe(410);
    const report = await processor().sweep();
    expect(report.expired).toBeGreaterThanOrEqual(1);
    const row = await artifact(id);
    expect(row.state).toBe('expired');
    expect(row.cleanedAt).not.toBeNull();
    expect(row.wrappedKey).toBeNull();
    expect(storage.objects.has(key)).toBe(false);
    const actions = (
      await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.resourceId, id))
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'privacy_export.requested',
        'privacy_export.ready',
        'privacy_export.expired',
        'privacy_export.deleted',
      ]),
    );
  });

  it('a password change revokes a ready export (epoch)', async () => {
    const { user, id } = await readyExport('epoch-password');
    await db
      .update(schema.users)
      .set({ passwordHash: 'rotated' })
      .where(eq(schema.users.id, user.userId));
    expect((await artifact(id)).state).toBe('revoked');
    expect((await download(user.token, id)).statusCode).toBe(410);
  });

  it('account deletion revokes and deletes the export in the same request', async () => {
    const { user, id } = await readyExport('epoch-delete');
    const key = (await artifact(id)).objectKey!;
    const del = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(user.token),
    });
    expect(del.statusCode).toBe(200);
    const row = await artifact(id);
    expect(row).toMatchObject({ state: 'revoked', revokeReason: 'account_deleted' });
    expect(row.cleanedAt).not.toBeNull();
    expect(storage.objects.has(key)).toBe(false);
  });

  it('export_epoch cannot be written directly', async () => {
    const user = await register('epoch-direct');
    await expect(
      db.execute(sql`update users set export_epoch = 0 where id = ${user.userId}::uuid`),
    ).resolves.toBeDefined(); // unchanged value: allowed
    const refused = await db
      .execute(
        sql`update users set export_epoch = export_epoch - 1 where id = ${user.userId}::uuid`,
      )
      .then(() => null)
      .catch((err: { cause?: { message?: string } }) => err);
    expect(refused?.cause?.message).toMatch(/maintained by trigger only/);
  });

  it('a tampered object fails authentication: no plaintext, not consumed, artifact failed', async () => {
    const { user, id } = await readyExport('tamper');
    const key = (await artifact(id)).objectKey!;
    const object = storage.objects.get(key)!;
    const tampered = Buffer.from(object.body);
    tampered[20] = tampered[20]! ^ 0x01;
    storage.objects.set(key, { ...object, body: tampered });
    const res = await download(user.token, id);
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('EXPORT_INTEGRITY_FAILED');
    expect(res.body).not.toContain(user.email);
    const row = await artifact(id);
    expect(row.state).toBe('failed');
    expect(row.failureCode).toBe('integrity_decrypt');
    expect(row.consumedAt).toBeNull();
  });

  it('an interrupted transfer after consumption is not reopened; delivery stays unset', async () => {
    const { user, id } = await readyExport('disconnect');
    const service = app.get(PrivacyExportService);
    const [session] = await db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, user.userId));
    const redeemed = await service.redeem(
      { type: 'user', id: user.userId, sessionId: session!.id },
      id,
    );
    await redeemed.finalize('aborted');
    const row = await artifact(id);
    expect(row).toMatchObject({ state: 'consumed', transferOutcome: 'aborted' });
    expect(row.transferCompletedAt).toBeNull();
    const [request] = await db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, row.privacyRequestId!));
    expect(request!.deliveredAt).toBeNull();
    expect((await download(user.token, id)).statusCode).toBe(410);
  });
});

describe('cleanup', () => {
  it('a refused storage delete is retried, never marked deleted, then completes', async () => {
    const { user, id } = await readyExport('cleanup-retry');
    await db
      .update(schema.privacyExportArtifacts)
      .set({ expiresAt: sql`now()` })
      .where(eq(schema.privacyExportArtifacts.id, id));
    storage.failWrites = true;
    try {
      await processor().sweep();
    } finally {
      storage.failWrites = false;
    }
    let row = await artifact(id);
    expect(row.state).toBe('expired');
    expect(row.cleanedAt).toBeNull();
    expect(row.cleanupAttempts).toBe(1);
    expect(storage.objects.has(row.objectKey!)).toBe(true);

    await db
      .update(schema.privacyExportArtifacts)
      .set({ cleanupDueAt: sql`now()` })
      .where(eq(schema.privacyExportArtifacts.id, id));
    await processor().sweep();
    row = await artifact(id);
    expect(row.cleanedAt).not.toBeNull();
    void user;
  });

  it('a retention hold on the ledger request never keeps the artifact', async () => {
    const { id } = await readyExport('hold');
    const row = await artifact(id);
    await db
      .update(schema.privacyRequests)
      .set({
        retentionHoldAt: sql`now()`,
        retentionHoldReason: 'litigation',
        legalBasis: 'court order',
        reviewAt: sql`now() + interval '30 days'`,
      })
      .where(eq(schema.privacyRequests.id, row.privacyRequestId!));
    await db
      .update(schema.privacyExportArtifacts)
      .set({ expiresAt: sql`now()` })
      .where(eq(schema.privacyExportArtifacts.id, id));
    await processor().sweep();
    expect((await artifact(id)).cleanedAt).not.toBeNull();
  });

  it('stuck generation times out explicitly', async () => {
    const user = await register('timeout');
    const id = (await createExport(user.token)).json().id;
    await db
      .update(schema.privacyExportArtifacts)
      .set({
        createdAt: sql`now() - interval '3 hours'`,
        nextAttemptAt: sql`now() + interval '1 day'`,
      })
      .where(eq(schema.privacyExportArtifacts.id, id));
    const report = await processor().sweep();
    expect(report.timedOut).toBeGreaterThanOrEqual(1);
    expect(await artifact(id)).toMatchObject({
      state: 'failed',
      failureCode: 'generation_timeout',
    });
  });
});

describe('CMS paths no longer hand the payload to an operator', () => {
  it('POST /cms/users/{id}/export: 202 metadata with its own ledger request, no data', async () => {
    const ops = await createAdmin(`cms-direct-${randomUUID().slice(0, 6)}@gogo.id.vn`, 'ops_admin');
    const user = await register('cms-direct');
    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/users/${user.userId}/export`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { reason: 'support ticket 42' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).not.toContain(user.email);
    expect(res.json()).not.toHaveProperty('profile');
    expect(res.json().export).toMatchObject({ status: 'pending', initiatedBy: 'support' });
    const [request] = await db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, res.json().privacyRequestId));
    expect(request).toMatchObject({
      source: 'cms',
      status: 'in_progress',
      createdByAdminId: ops.id,
    });

    // Only the subject redeems it.
    await processor().runDue(5);
    const opsDownload = await download(ops.token, res.json().export.id);
    expect([403, 404]).toContain(opsDownload.statusCode);
    const mine = await download(user.token, res.json().export.id);
    expect(mine.statusCode).toBe(200);
    expect(JSON.parse(mine.body).profile.email).toBe(user.email);
  });

  it('POST /cms/privacy-requests/{id}/execute (export): 202, in_progress, no data, closes when ready', async () => {
    const ops = await createAdmin(`cms-exec-${randomUUID().slice(0, 6)}@gogo.id.vn`, 'ops_admin');
    const user = await register('cms-exec');
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
    expect(executed.json()).not.toHaveProperty('data');
    expect(executed.body).not.toContain(user.email);
    expect(executed.json().request.status).toBe('in_progress');
    expect(executed.json().export.status).toBe('pending');

    await processor().runDue(5);
    const detail = await api().inject({
      method: 'GET',
      url: `/v1/cms/privacy-requests/${requestId}`,
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(detail.json()).toMatchObject({ status: 'closed', outcome: 'completed' });
    expect(detail.json().secureExport.status).toBe('ready');
    expect(detail.json().deliveredAt).toBeUndefined();
  });

  it('an operator cannot assert a secure download by hand', async () => {
    const ops = await createAdmin(`cms-assert-${randomUUID().slice(0, 6)}@gogo.id.vn`, 'ops_admin');
    const user = await register('cms-assert');
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/privacy-requests',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { type: 'export', subjectType: 'user', userId: user.userId },
    });
    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/privacy-requests/${created.json().id}/delivered`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { deliveryMethod: 'secure_download' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SECURE_DELIVERY_NOT_ASSERTABLE');
  });

  it('refuses an account that cannot sign in — recovery first', async () => {
    const ops = await createAdmin(`cms-banned-${randomUUID().slice(0, 6)}@gogo.id.vn`, 'ops_admin');
    const user = await register('cms-banned');
    await db.update(schema.users).set({ status: 'banned' }).where(eq(schema.users.id, user.userId));
    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/users/${user.userId}/export`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { reason: 'support ticket 43' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SUBJECT_CANNOT_SIGN_IN');
  });
});

describe('no leakage', () => {
  it('no export content or key material in audit, outbox, ledger, notifications, replay records or logs', async () => {
    const { user, id } = await readyExport('leak');
    expect((await download(user.token, id)).statusCode).toBe(200);
    const needles = [user.email, 'Marker leak', WRAPPING_KEY];
    const dumps = await Promise.all([
      db.execute(sql`select diff::text as t from audit_logs`),
      db.execute(sql`select payload::text as t from outbox_events`),
      db.execute(sql`select row_to_json(p)::text as t from privacy_requests p`),
      db.execute(sql`select payload::text as t from notifications`),
      db.execute(sql`select coalesce(response_body::text, '') as t from idempotency_keys`),
    ]);
    const text = dumps
      .flatMap((d) => (d.rows as { t: string | null }[]).map((r) => r.t ?? ''))
      .join('\n');
    const logs = logLines.join('\n');
    for (const needle of needles) {
      expect(text).not.toContain(needle);
      expect(logs).not.toContain(needle);
    }
    // The access token never reaches a log line either.
    expect(logs).not.toContain(user.token);
  });
});

describe('migration 0070', () => {
  it('the documented rehearsal down path runs cleanly (rolled back)', async () => {
    const file = readFileSync(
      path.resolve(__dirname, '../../../migrations/0070_privacy-export-artifacts.sql'),
      'utf8',
    );
    const down = file
      .split('\n')
      .filter((l) => /^-- {3}(DROP|ALTER)/.test(l))
      .map((l) => l.replace(/^--\s+/, ''));
    expect(down.length).toBe(8);
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const statement of down) await client.query(statement);
      await client.query('rollback');
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`select to_regclass('privacy_export_artifacts') as t`);
    expect(rows[0].t).toBe('privacy_export_artifacts');
  });
});
