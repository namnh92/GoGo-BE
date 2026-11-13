import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import {
  InviteAttemptService,
  inviteIpBuckets,
} from '../../../libs/modules/identity/application/invite-attempt.service';
import { InviteAttemptRepository } from '../../../libs/modules/identity/infrastructure/invite-attempt.repository';
import { InviteAttemptCrypto } from '../../../libs/modules/identity/application/invite-attempt-crypto';

/** I05 DEV-only: real migration, app, storage, cookie/CORS, concurrency and legacy routes. */
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let service: InviteAttemptService;
const recoveryLogs: string[] = [];
const origin = 'https://web.gogo.id.vn';
const keySecret = 'test-invite-attempt-managed-key'.padEnd(48, 'x');
const crypto = new InviteAttemptCrypto(keySecret);
const url = '/v1/invite-attempt-contexts';
let testAddress = 0;
let remoteAddress: string;
const api = () => app.getHttpAdapter().getInstance();
const browserHeaders = () => ({
  origin,
  'sec-fetch-site': 'same-site',
  'idempotency-key': randomUUID(),
});
const bootstrap = (key: string = randomUUID()) =>
  api().inject({
    method: 'POST',
    url,
    remoteAddress,
    headers: { 'idempotency-key': key },
    payload: { transport: 'MOBILE_HEADER' },
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('invite_i05')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-jwt-key'.padEnd(48, 'x');
  process.env.INVITE_ATTEMPT_KEY = keySecret;
  process.env.CORS_ORIGINS = origin;
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 5 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  const { createApp } = await import('../src/main.js');
  app = await createApp({
    logDestination: {
      write: (line: string) => {
        recoveryLogs.push(line);
      },
    },
  });
  await app.init();
  await api().ready();
  service = app.get(InviteAttemptService);
}, 180_000);
beforeEach(async () => {
  // SQL truncation cannot reset the app's in-memory anonymous baseline (120/min).
  // Isolate both IP and /24 per test; requests within a test still share real limits.
  remoteAddress = `203.0.${++testAddress}.71`;
  recoveryLogs.length = 0;
  await db.execute(
    sql`truncate invite_attempt_replays, invite_attempt_contexts, invite_bootstrap_buckets`,
  );
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('I05 actual HTTP bootstrap and schema', () => {
  it('forward migration enforces purpose/TTL and schema has no I03 dependency', async () => {
    const id = randomUUID();
    await expect(
      db.execute(
        sql`insert into invite_attempt_contexts (id, proof_hash, purpose, transport, created_at, expires_at) values (${id}, 'fake', 'push_device', 'MOBILE_HEADER', now(), now() + interval '48 hours')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql`insert into invite_attempt_contexts (id, proof_hash, transport, created_at, expires_at) values (${id}, 'fake', 'MOBILE_HEADER', now(), now() + interval '49 hours')`,
      ),
    ).rejects.toThrow();
  });
  it('persists only proof hash/encrypted completion, no generic replay and no secret response caching', async () => {
    const key = randomUUID();
    const first = await bootstrap(key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const body = first.json();
    const [stored] = await db.select().from(schema.inviteAttemptContexts);
    const [replay] = await db.select().from(schema.inviteAttemptReplays);
    expect(stored?.proofHash).toBe(crypto.proofHash(body.contextToken));
    expect(replay?.contextId).toBe(stored?.id);
    expect(replay?.ciphertext).not.toContain(body.contextToken);
    const generic = await db.select().from(schema.idempotencyKeys);
    expect(JSON.stringify(generic)).not.toContain(body.contextToken);
    const retry = await bootstrap(key);
    expect(retry.json()).toEqual(body);
    expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(1);
  });
  it('concurrent lost-response retries create one context; in-flight response carries Retry-After', async () => {
    const key = randomUUID();
    const results = await Promise.all([bootstrap(key), bootstrap(key)]);
    expect(results.every((r) => [201, 409].includes(r.statusCode))).toBe(true);
    for (const r of results.filter((r) => r.statusCode === 409))
      expect(r.headers['retry-after']).toBe('1');
    expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(1);
    const retry = await bootstrap(key);
    expect(retry.statusCode).toBe(201);
    expect(results.find((r) => r.statusCode === 201)?.json()).toEqual(retry.json());
  });
  it('returns deterministic in-flight 409 and retry header through the real exception filter', async () => {
    const key = randomUUID();
    const replayKey = crypto.digest('bootstrap-replay', remoteAddress, key);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `invite-bootstrap-replay:${replayKey}`,
      ]);
      const result = await bootstrap(key);
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(result.headers['retry-after']).toBe('1');
      expect(result.headers['cache-control']).toBe('no-store');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('reuses supplied proof and exact deadline; forged/expired bootstrap cannot mint a replacement', async () => {
    const first = (await bootstrap()).json();
    const reused = await api().inject({
      method: 'POST',
      url,
      remoteAddress: '198.51.100.7',
      headers: { 'idempotency-key': randomUUID(), 'x-gogo-invite-context': first.contextToken },
      payload: { transport: 'MOBILE_HEADER' },
    });
    expect(reused.json()).toEqual(first);
    await db.execute(
      sql`update invite_attempt_contexts set created_at = now() - interval '48 hours', expires_at = now()`,
    );
    const expired = await api().inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: { 'idempotency-key': randomUUID(), 'x-gogo-invite-context': first.contextToken },
      payload: { transport: 'MOBILE_HEADER' },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe('INVITE_CONTEXT_REQUIRED');
    expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(1);
  });
  it('uniform proof validation rejects missing/forged/expired/revoked before any CODE6 lookup', async () => {
    const first = (await bootstrap()).json();
    for (const headerProof of [undefined, 'forged', crypto.token()]) {
      await expect(
        service.validateForCredential('CODE6', { ip: remoteAddress, headerProof }),
      ).rejects.toMatchObject({ code: 'INVITE_CONTEXT_REQUIRED', httpStatus: 401 });
    }
    await db.update(schema.inviteAttemptContexts).set({ revokedAt: new Date() });
    await expect(
      service.validateForCredential('CODE6', {
        ip: remoteAddress,
        headerProof: first.contextToken,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_CONTEXT_REQUIRED' });
    await db.execute(
      sql`update invite_attempt_contexts set revoked_at = null, created_at = now() - interval '48 hours', expires_at = now()`,
    );
    await expect(
      service.validateForCredential('CODE6', {
        ip: remoteAddress,
        headerProof: first.contextToken,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_CONTEXT_REQUIRED' });
  });
  it('replay rechecks revocation and exact expiry', async () => {
    const key = randomUUID();
    const first = (await bootstrap(key)).json();
    await db
      .update(schema.inviteAttemptContexts)
      .set({ revokedAt: new Date() })
      .where(eq(schema.inviteAttemptContexts.proofHash, crypto.proofHash(first.contextToken)));
    expect((await bootstrap(key)).statusCode).toBe(401);
    await db.execute(
      sql`update invite_attempt_contexts set revoked_at = null, created_at = now() - interval '48 hours', expires_at = now()`,
    );
    expect((await bootstrap(key)).statusCode).toBe(401);
  });
  it('bad UUID and invalid body produce no-store standard errors', async () => {
    const bad = await bootstrap('not-a-uuid');
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['cache-control']).toBe('no-store');
    const body = await api().inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: { 'idempotency-key': randomUUID() },
      payload: { transport: 'MOBILE_HEADER', contextToken: 'private-marker' },
    });
    expect(body.statusCode).toBe(400);
    expect(body.body).not.toContain('private-marker');
  });
  it('independent shared bootstrap flood quota does not fall back to process memory', async () => {
    for (let n = 0; n < 10; n++) expect((await bootstrap()).statusCode).toBe(201);
    const refused = await bootstrap();
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(10);
    const b = await db.select().from(schema.inviteBootstrapBuckets);
    expect(b).toHaveLength(3);
    expect(b.every((row) => row.count === 11)).toBe(true);
  });
  it.each([
    { dimension: 'global', ceiling: 1000 },
    { dimension: 'ip', ceiling: 10 },
    { dimension: 'prefix', ceiling: 30 },
  ])(
    'independently enforces the shared $dimension bucket without extending its window',
    async ({ dimension, ceiling }) => {
      const ips = inviteIpBuckets(remoteAddress);
      const identity = dimension === 'global' ? [] : [dimension === 'ip' ? ips.ip : ips.prefix];
      const key = crypto.digest('bucket', dimension, ...identity);
      const expiresAt = new Date(Date.now() + 30_000);
      await db.insert(schema.inviteBootstrapBuckets).values({ key, count: ceiling, expiresAt });
      const response = await bootstrap();
      expect(response.statusCode).toBe(429);
      const [stored] = await db
        .select()
        .from(schema.inviteBootstrapBuckets)
        .where(eq(schema.inviteBootstrapBuckets.key, key));
      expect(stored?.expiresAt).toEqual(expiresAt);
      expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(0);
    },
  );
  it('missing table/dependency is 503, never anonymous or a generic cached answer', async () => {
    await db.execute(
      sql`alter table invite_attempt_contexts rename to invite_attempt_contexts_hidden`,
    );
    try {
      const failed = await bootstrap();
      expect(failed.statusCode).toBe(503);
      expect(failed.json().code).toBe('INVITE_LOOKUP_UNAVAILABLE');
      expect(failed.body).not.toContain('hidden');
    } finally {
      await db.execute(
        sql`alter table invite_attempt_contexts_hidden rename to invite_attempt_contexts`,
      );
    }
  });
});

describe('I05 browser cookie and CORS', () => {
  it('secure host-only cookie, no JSON proof, explicit allowlist and exposed retry header', async () => {
    const headers = browserHeaders();
    const first = await api().inject({
      method: 'POST',
      url,
      remoteAddress,
      headers,
      payload: { transport: 'BROWSER_COOKIE' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers['access-control-allow-origin']).toBe(origin);
    expect(first.headers['access-control-allow-credentials']).toBe('true');
    expect(first.headers['access-control-expose-headers']).toContain('retry-after');
    expect(first.json()).toHaveProperty('csrfToken');
    expect(first.json()).not.toHaveProperty('contextToken');
    const cookieHeaders = first.headers['set-cookie'] as string[];
    expect(cookieHeaders).toHaveLength(2);
    expect(cookieHeaders[1]).toContain('__Host-gogo_invite_csrf=');
    expect(cookieHeaders[1]).not.toContain('HttpOnly');
    const set = String(cookieHeaders[0]);
    expect(set).toMatch(/^__Host-gogo_invite_ctx=/);
    for (const attribute of [
      'Secure',
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Expires=',
      'Max-Age=',
    ])
      expect(set).toContain(attribute);
    expect(set).not.toMatch(/Domain=/i);
    const cookie = set.split(';')[0]!;
    const missing = await api().inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: { ...browserHeaders(), cookie },
      payload: { transport: 'BROWSER_COOKIE' },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe('CSRF_FAILED');
    const retry = await api().inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: { ...browserHeaders(), cookie, 'x-gogo-invite-csrf': first.json().csrfToken },
      payload: { transport: 'BROWSER_COOKIE' },
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    await db.update(schema.inviteAttemptContexts).set({ revokedAt: new Date() });
    const revoked = await api().inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: { ...browserHeaders(), cookie, 'x-gogo-invite-csrf': first.json().csrfToken },
      payload: { transport: 'BROWSER_COOKIE' },
    });
    expect(revoked.statusCode).toBe(401);
    expect(
      (revoked.headers['set-cookie'] as string[]).every((value) => value.includes('Max-Age=0')),
    ).toBe(true);
    const fresh = await api().inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: browserHeaders(),
      payload: { transport: 'BROWSER_COOKIE' },
    });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().csrfToken).not.toBe(first.json().csrfToken);
  });
  it('rejects absent/foreign/null Origin and cross-site bootstrap before setting cookies', async () => {
    for (const change of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: undefined },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const result = await api().inject({
        method: 'POST',
        url,
        remoteAddress,
        // An absent HTTP header must be omitted; inject rejects undefined values.
        headers: Object.fromEntries(
          Object.entries({ ...browserHeaders(), ...change }).filter(
            ([, value]) => value !== undefined,
          ),
        ),
        payload: { transport: 'BROWSER_COOKIE' },
      });
      expect(result.statusCode).toBe(403);
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(result.headers['access-control-allow-origin']).not.toBe('*');
    }
  });
  it('CORS permits proof/CSRF headers only with exact allowlisted origin, no wildcard credentials', async () => {
    const preflight = await api().inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'content-type,idempotency-key,x-gogo-invite-context,x-gogo-invite-csrf',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-headers']).toContain('x-gogo-invite-context');
    expect(preflight.headers['access-control-allow-headers']).toContain('x-gogo-invite-csrf');
    const refused = await api().inject({
      method: 'OPTIONS',
      url,
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });
});

it('legacy token clients omit every new field/header/cookie for preview, user/guest join and sessions/guest', async () => {
  let next = 0;
  const ip = () => `198.51.100.${++next}`;
  const register = async (email: string) => {
    const response = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email, password: 'Legacy-test-password1!', displayName: 'Legacy' },
    });
    expect(response.statusCode).toBe(201);
    return response.json().accessToken as string;
  };
  const host = await register('i05-host@example.com');
  const user = await register('i05-user@example.com');
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const created = await api().inject({
    method: 'POST',
    url: '/v1/rooms',
    remoteAddress: ip(),
    headers: auth(host),
    payload: {
      type: 'group',
      decisionMode: 'vote',
      participantCount: 6,
      constraint: {
        budgetMode: 'per_person',
        budgetAmount: 300000,
        currency: 'VND',
        radiusM: 5000,
        areaKey: 'hcm_q1',
      },
    },
  });
  expect(created.statusCode).toBe(201);
  const room = created.json();
  const minted = await api().inject({
    method: 'POST',
    url: `/v1/rooms/${room.id}/invites`,
    remoteAddress: ip(),
    headers: auth(host),
    payload: {},
  });
  expect(minted.statusCode).toBe(201);
  const inviteCode = minted.json().code;
  expect(inviteCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const preview = await api().inject({
    method: 'POST',
    url: '/v1/rooms/invites/preview',
    remoteAddress: ip(),
    payload: { inviteCode },
  });
  expect(preview.statusCode).toBe(200);
  const joined = await api().inject({
    method: 'POST',
    url: '/v1/rooms/join',
    remoteAddress: ip(),
    headers: auth(user),
    payload: { inviteCode },
  });
  expect(joined.statusCode).toBe(201);
  const guest = await api().inject({
    method: 'POST',
    url: '/v1/rooms/join/guest',
    remoteAddress: ip(),
    payload: { inviteCode, displayName: 'Legacy guest' },
  });
  expect(guest.statusCode).toBe(201);
  const legacy = await api().inject({
    method: 'POST',
    url: '/v1/sessions/guest',
    remoteAddress: ip(),
    payload: { roomCode: room.code, displayName: 'Legacy room code' },
  });
  expect(legacy.statusCode).toBe(201);
  expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(0);
});

const recoveryUrl = `${url}/csrf`;
const webBootstrap = () =>
  api().inject({
    method: 'POST',
    url,
    remoteAddress,
    headers: browserHeaders(),
    payload: { transport: 'BROWSER_COOKIE' },
  });
const proofCookie = (response: {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
}) => {
  expect(
    response.statusCode,
    `Browser bootstrap must succeed before recovery: ${response.body}`,
  ).toBe(201);
  const cookies = response.headers['set-cookie'];
  expect(
    cookies,
    'Successful browser bootstrap must issue proof and CSRF Set-Cookie headers',
  ).toEqual([
    expect.stringMatching(/^__Host-gogo_invite_ctx=/),
    expect.stringMatching(/^__Host-gogo_invite_csrf=/),
  ]);
  const cookie = (cookies as string[])[0]!.split(';')[0]!;
  expect(cookie, 'Browser bootstrap must issue a valid proof cookie').toMatch(
    /^__Host-gogo_invite_ctx=[A-Za-z0-9_-]{43}$/,
  );
  return cookie;
};
const recover = (cookie?: string, headers: Record<string, string> = {}) =>
  api().inject({
    method: 'POST',
    url: recoveryUrl,
    remoteAddress,
    headers: {
      origin,
      'sec-fetch-site': 'same-site',
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
    payload: {},
  });
const expectRecoveryError = (
  response: {
    statusCode: number;
    headers: Record<string, unknown>;
    json(): Record<string, unknown>;
  },
  status: number,
  code: string,
  cleanup = false,
) => {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({
    code,
    field_errors: expect.any(Array),
    request_id: expect.any(String),
    retryable: expect.any(Boolean),
  });
  expect(response.headers['cache-control']).toBe('no-store');
  if (cleanup) {
    const cookies = response.headers['set-cookie'] as string[];
    expect(cookies).toHaveLength(2);
    for (const value of cookies) {
      for (const attribute of ['Max-Age=0', 'Secure', 'Path=/', 'SameSite=Lax'])
        expect(value).toContain(attribute);
      expect(value).not.toMatch(/Domain=/i);
    }
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[1]).not.toContain('HttpOnly');
  } else expect(response.headers['set-cookie']).toBeUndefined();
};

describe('I05 F-01 browser CSRF recovery (real Postgres + Fastify)', () => {
  it('recovers repeatedly/concurrently without key/CSRF and without context/replay/audit writes or cookies', async () => {
    const first = await webBootstrap();
    const cookie = proofCookie(first);
    const snapshot = async () => ({
      contexts: await db.select().from(schema.inviteAttemptContexts),
      replays: await db.select().from(schema.inviteAttemptReplays),
      generic: await db.select().from(schema.idempotencyKeys),
      audit: (await pool.query("select * from audit_logs where action = 'invite_context.created'"))
        .rows,
    });
    const before = await snapshot();
    const responses = await Promise.all([
      recover(cookie),
      recover(cookie, {
        'x-gogo-invite-csrf': 'stale-incidental-header',
        'idempotency-key': randomUUID(),
      }),
    ]);
    responses.push(await recover(cookie));
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(first.json());
      expect(Object.keys(response.json()).sort()).toEqual(['csrfToken', 'expiresAt']);
      expect(response.json().csrfToken).toMatch(/^[a-f0-9]{64}$/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers.vary).toContain('Origin');
      expect(response.body).not.toContain(cookie.split('=')[1]);
    }
    expect(await snapshot()).toEqual(before);
  });
  it.each([undefined, '', 'malformed', 'A'.repeat(42) + 'B', 'A'.repeat(43)])(
    'unusable cookie %s clears cookies without replacement',
    async (proof) => {
      const response = await recover(
        proof === undefined ? undefined : `__Host-gogo_invite_ctx=${proof}`,
      );
      expectRecoveryError(response, 401, 'INVITE_CONTEXT_REQUIRED', true);
      expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(0);
    },
  );
  it.each(['expired', 'revoked', 'mobile'])('rejects %s proof and clears cookies', async (kind) => {
    const first = kind === 'mobile' ? await bootstrap() : await webBootstrap();
    const cookie =
      kind === 'mobile'
        ? `__Host-gogo_invite_ctx=${first.json().contextToken}`
        : proofCookie(first);
    if (kind === 'revoked')
      await db.update(schema.inviteAttemptContexts).set({ revokedAt: new Date() });
    if (kind === 'expired')
      await db.execute(
        sql`update invite_attempt_contexts set created_at = now() - interval '48 hours', expires_at = now()`,
      );
    expectRecoveryError(await recover(cookie), 401, 'INVITE_CONTEXT_REQUIRED', true);
    expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(1);
  });
  it.each(['exact expiry', 'wrong purpose'])('rejects %s from proof validation', async (kind) => {
    const first = await webBootstrap();
    const repository = app.get(InviteAttemptRepository);
    const original = repository.findProof.bind(repository);
    // Invalid purpose cannot be persisted because migration 0106 enforces it.
    // Keep real SQL lookup, overriding just that invalid field or the exact clock boundary.
    const spy = vi.spyOn(repository, 'findProof').mockImplementation(async (hash) => {
      const result = await original(hash);
      return kind === 'exact expiry'
        ? { ...result, now: result.context!.expiresAt }
        : { ...result, context: { ...result.context!, purpose: 'push_device' } };
    });
    try {
      expectRecoveryError(await recover(proofCookie(first)), 401, 'INVITE_CONTEXT_REQUIRED', true);
    } finally {
      spy.mockRestore();
    }
  });
  it('missing crypto fails closed without cleanup or issuance', async () => {
    const first = await webBootstrap();
    const configuredCrypto = app.get(InviteAttemptCrypto);
    const spy = vi.spyOn(configuredCrypto, 'assertConfigured').mockImplementation(() => {
      throw new Error('private-secret-marker');
    });
    try {
      const response = await recover(proofCookie(first));
      expectRecoveryError(response, 503, 'INVITE_LOOKUP_UNAVAILABLE');
      expect(response.body).not.toContain('private-secret-marker');
    } finally {
      spy.mockRestore();
    }
  });
  it('recovery request/response proof and CSRF are absent from application logs', async () => {
    const first = await webBootstrap();
    const cookie = proofCookie(first);
    await recover(cookie, { 'x-gogo-invite-csrf': 'private-stale-csrf-marker' });
    const logs = recoveryLogs.join('');
    expect(logs).toContain('/v1/invite-attempt-contexts/csrf');
    expect(logs).not.toContain(cookie.split('=')[1]);
    expect(logs).not.toContain(first.json().csrfToken);
    expect(logs).not.toContain('private-stale-csrf-marker');
  });
  it.each([
    { origin: undefined },
    { origin: 'null' },
    { origin: 'https://evil.example' },
    { origin: 'https://sibling.gogo.id.vn' },
    { origin: origin + '.evil.example' },
    { origin: origin + ':444' },
    { origin: origin.replace('https:', 'http:') },
    { 'sec-fetch-site': undefined },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects Origin/Fetch-Metadata before proof cleanup: %j', async (change) => {
    const first = await webBootstrap();
    const response = await api().inject({
      method: 'POST',
      url: recoveryUrl,
      remoteAddress,
      headers: Object.fromEntries(
        Object.entries({
          origin,
          'sec-fetch-site': 'same-site',
          cookie: proofCookie(first),
          ...change,
        }).filter(([, value]) => value !== undefined),
      ),
      payload: {},
    });
    expectRecoveryError(response, 403, 'CSRF_FAILED');
    if (change.origin !== undefined)
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (await db.select().from(schema.inviteBootstrapBuckets)).every((row) => row.count === 1),
    ).toBe(true);
  });
  it('accepts same-origin metadata and JSON charset', async () => {
    const first = await webBootstrap();
    expect(
      (
        await recover(proofCookie(first), {
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json; charset=utf-8',
        })
      ).statusCode,
    ).toBe(200);
  });
  it.each([
    { payload: undefined, type: 'application/json', status: 400 },
    { payload: '{', type: 'application/json', status: 400 },
    { payload: 'null', type: 'application/json', status: 400 },
    { payload: '[]', type: 'application/json', status: 400 },
    { payload: '"text"', type: 'application/json', status: 400 },
    {
      payload: '{"transport":"BROWSER_COOKIE","contextToken":"private-marker"}',
      type: 'application/json',
      status: 400,
    },
    { payload: '{}', type: 'text/plain', status: 415 },
    { payload: '{}', type: 'application/x-www-form-urlencoded', status: 415 },
    { payload: '{}', type: 'application/octet-stream', status: 415 },
  ])('strict parser/body validation: $type $payload', async ({ payload, type, status }) => {
    const response = await api().inject({
      method: 'POST',
      url: recoveryUrl,
      remoteAddress,
      headers: { origin, 'sec-fetch-site': 'same-site', 'content-type': type },
      ...(payload === undefined ? {} : { payload }),
    });
    expectRecoveryError(
      response,
      status,
      status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'VALIDATION_FAILED',
    );
    expect(response.body).not.toContain('private-marker');
  });
  it('rejects header-only, mixed and empty-header proof without clearing the browser cookie', async () => {
    const first = await webBootstrap();
    const mobile = await bootstrap();
    for (const cookie of [undefined, proofCookie(first)]) {
      for (const proof of ['', mobile.json().contextToken])
        expectRecoveryError(
          await recover(cookie, { 'x-gogo-invite-context': proof }),
          401,
          'INVITE_CONTEXT_REQUIRED',
        );
    }
  });
  it('A token and tampering fail on B; bootstrap and CODE6 still require valid CSRF', async () => {
    const a = await webBootstrap();
    const b = await webBootstrap();
    const recovered = (await recover(proofCookie(a))).json();
    const cookie = proofCookie(b);
    for (const csrf of [undefined, '0'.repeat(64), recovered.csrfToken]) {
      const response = await api().inject({
        method: 'POST',
        url,
        remoteAddress,
        headers: {
          ...browserHeaders(),
          cookie,
          ...(csrf === undefined ? {} : { 'x-gogo-invite-csrf': csrf }),
        },
        payload: { transport: 'BROWSER_COOKIE' },
      });
      expectRecoveryError(response, 403, 'CSRF_FAILED');
      await expect(
        service.validateForCredential('CODE6', {
          ip: remoteAddress,
          origin,
          fetchSite: 'same-site',
          cookieProof: cookie.split('=')[1],
          csrf,
        }),
      ).rejects.toMatchObject({ code: 'CSRF_FAILED' });
    }
    const reused = await api().inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: {
        ...browserHeaders(),
        cookie: proofCookie(a),
        'x-gogo-invite-csrf': recovered.csrfToken,
      },
      payload: { transport: 'BROWSER_COOKIE' },
    });
    expect(reused.statusCode).toBe(201);
    expect(reused.json()).toEqual(a.json());
  });
  it.each([
    { dimension: 'global', ceiling: 1000 },
    { dimension: 'ip', ceiling: 10 },
    { dimension: 'prefix', ceiling: 30 },
  ])(
    'recovery shares bootstrap $dimension flood keys and Retry-After',
    async ({ dimension, ceiling }) => {
      const first = await webBootstrap();
      const ips = inviteIpBuckets(remoteAddress);
      const identity = dimension === 'global' ? [] : [dimension === 'ip' ? ips.ip : ips.prefix];
      const key = crypto.digest('bucket', dimension, ...identity);
      await db
        .update(schema.inviteBootstrapBuckets)
        .set({ count: ceiling })
        .where(eq(schema.inviteBootstrapBuckets.key, key));
      const [before] = await db
        .select()
        .from(schema.inviteBootstrapBuckets)
        .where(eq(schema.inviteBootstrapBuckets.key, key));
      const response = await recover(proofCookie(first));
      expectRecoveryError(response, 429, 'RATE_LIMITED');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(response.headers['access-control-expose-headers']).toContain('retry-after');
      const [after] = await db
        .select()
        .from(schema.inviteBootstrapBuckets)
        .where(eq(schema.inviteBootstrapBuckets.key, key));
      expect(after?.expiresAt).toEqual(before?.expiresAt);
      expect(after?.count).toBe(ceiling + 1);
    },
  );
  it('bootstrap and recovery consume the same IP allowance', async () => {
    const first = await webBootstrap();
    for (let i = 0; i < 9; i++) expect((await recover(proofCookie(first))).statusCode).toBe(200);
    expectRecoveryError(await recover(proofCookie(first)), 429, 'RATE_LIMITED');
    expect((await bootstrap()).statusCode).toBe(429);
    expect(await db.select().from(schema.inviteAttemptContexts)).toHaveLength(1);
  });
  it.each(['invite_attempt_contexts', 'invite_bootstrap_buckets'])(
    'dependency outage in %s returns sanitized 503 without cookie cleanup',
    async (table) => {
      const first = await webBootstrap();
      const cookie = proofCookie(first);
      expect(
        (await recover(cookie)).statusCode,
        'Context must be recoverable before the outage',
      ).toBe(200);
      await pool.query(`alter table ${table} rename to ${table}_hidden`);
      try {
        const response = await recover(cookie);
        expectRecoveryError(response, 503, 'INVITE_LOOKUP_UNAVAILABLE');
        expect(response.body).not.toContain('hidden');
        expect(response.body).not.toContain(cookie.split('=')[1]);
      } finally {
        await pool.query(`alter table ${table}_hidden rename to ${table}`);
      }
    },
  );
  it('CORS preflight is public, credentialed, exact and exposes no grant to an attacker', async () => {
    for (const requestOrigin of [origin, 'https://sibling.gogo.id.vn']) {
      const response = await api().inject({
        method: 'OPTIONS',
        url: recoveryUrl,
        headers: {
          origin: requestOrigin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      if (requestOrigin === origin) {
        expect(response.statusCode).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe(origin);
        expect(response.headers['access-control-allow-credentials']).toBe('true');
        expect(response.headers.vary).toContain('Origin');
      } else expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
  it('no-store also covers trailing-slash parser and routing/guard errors', async () => {
    for (const target of [url + '/', recoveryUrl + '/']) {
      const response = await api().inject({
        method: 'POST',
        url: target,
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });
});
