import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import IORedis from 'ioredis';
import argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { MetricsRegistry } from '@gogo/observability';

/**
 * Platform contract pieces: Idempotency-Key semantics (api-contract rule)
 * and the Redis-backed rate-limit store (multi-instance correctness).
 */

let container: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.50.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const roomPayload = {
  type: 'group',
  decisionMode: 'vote',
  participantCount: 4,
  constraint: { budgetMode: 'per_person', budgetAmount: 300_000, currency: 'VND' },
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_platform_test')
    .start();
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  // BE-IMP-003: browser clients (CMS, Web) are an explicit allowlist.
  process.env.CORS_ORIGINS = 'http://localhost:5174,https://cms.gogo.id.vn';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
  await redisContainer?.stop();
});

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: 'U' },
  });
  return res.json().accessToken as string;
}

describe('Idempotency-Key (api-contract rule)', () => {
  it('replays the original response instead of re-applying the mutation', async () => {
    const token = await register('idem1@gogo.id.vn');
    const key = 'client-key-0001';
    const first = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(token), 'idempotency-key': key },
      payload: roomPayload,
    });
    expect(first.statusCode).toBe(201);
    const second = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(token), 'idempotency-key': key },
      payload: roomPayload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.json().id).toBe(first.json().id);

    const rooms = await db.select().from(schema.rooms).where(eq(schema.rooms.id, first.json().id));
    expect(rooms).toHaveLength(1);
  });

  it('same key + different body → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const token = await register('idem2@gogo.id.vn');
    const key = 'client-key-0002';
    await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(token), 'idempotency-key': key },
      payload: roomPayload,
    });
    const mismatch = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(token), 'idempotency-key': key },
      payload: { ...roomPayload, participantCount: 6 },
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keys are scoped per actor — same key from another user is independent', async () => {
    const tokenA = await register('idem3a@gogo.id.vn');
    const tokenB = await register('idem3b@gogo.id.vn');
    const key = 'shared-key-0003';
    const a = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(tokenA), 'idempotency-key': key },
      payload: roomPayload,
    });
    const b = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(tokenB), 'idempotency-key': key },
      payload: roomPayload,
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
  });

  it('a failed request releases the key so retry works', async () => {
    const token = await register('idem4@gogo.id.vn');
    const key = 'client-key-0004';
    const bad = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(token), 'idempotency-key': key },
      payload: { ...roomPayload, decisionMode: 'match' }, // invalid for group → 400
    });
    expect(bad.statusCode).toBe(400);
    const retry = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(token), 'idempotency-key': key },
      payload: roomPayload, // corrected body, same key
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['x-idempotent-replay']).toBeUndefined();
  });

  it('rejects malformed keys', async () => {
    const token = await register('idem5@gogo.id.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: { ...auth(token), 'idempotency-key': 'short' },
      payload: roomPayload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});

describe('readiness endpoint (downtime monitoring target)', () => {
  it('reports dependency checks — db ok, redis skipped in test env', async () => {
    const res = await api().inject({ method: 'GET', url: '/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { db: 'ok', redis: 'skipped' } });
  });
});

describe('Redis rate-limit store (multi-instance)', () => {
  it('counts across store instances sharing one Redis (unlike in-memory)', async () => {
    const { RedisRateLimitStore } =
      await import('../../../libs/modules/identity/presentation/redis-rate-limit.store.js');
    const url = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    const redisA = new IORedis(url);
    const redisB = new IORedis(url);
    const storeA = new RedisRateLimitStore(redisA);
    const storeB = new RedisRateLimitStore(redisB); // simulates a second api instance
    expect(await storeA.hit('login|1.2.3.4', 60)).toBe(1);
    expect(await storeB.hit('login|1.2.3.4', 60)).toBe(2);
    expect(await storeA.hit('login|1.2.3.4', 60)).toBe(3);
    const ttl = await redisA.ttl('rl:login|1.2.3.4');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    redisA.disconnect();
    redisB.disconnect();
  });

  it('fails open to the in-memory fallback when Redis is down', async () => {
    const { RedisRateLimitStore, FallbackRateLimitStore } =
      await import('../../../libs/modules/identity/presentation/redis-rate-limit.store.js');
    const dead = new IORedis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    const store = new FallbackRateLimitStore(new RedisRateLimitStore(dead));
    expect(await store.hit('k', 60)).toBe(1);
    expect(await store.hit('k', 60)).toBe(2); // memory fallback keeps counting
    dead.disconnect();
  });

  /**
   * COST-BE-037 (#424). The production client is `lazyConnect` with the
   * offline queue off, so the first command of a cold client is refused
   * (fail-open, answered from memory) — one `status="error"` per boot on
   * DEV. Warming the client at bootstrap is what makes the first real hit
   * `ok`. Real ioredis against a real Redis, because the guarantee rests on
   * `connect()` resolving only once the connection is *ready*.
   */
  it('a client warmed at bootstrap answers its first hit ok; a cold one records an error (#424)', async () => {
    const { createRateLimitRedis, warmRateLimitRedis } =
      await import('../../../libs/modules/identity/presentation/rate-limit-redis.js');
    const { RedisRateLimitStore, FallbackRateLimitStore } =
      await import('../../../libs/modules/identity/presentation/redis-rate-limit.store.js');
    const url = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    const hit = 'provider_requests_total{operation="upstash.redis.rate_limit.hit"';

    // Cold: the defect as shipped before #424.
    const cold = createRateLimitRedis(url);
    const coldMetrics = new MetricsRegistry();
    const coldStore = new FallbackRateLimitStore(new RedisRateLimitStore(cold, coldMetrics));
    expect(await coldStore.hit('boot|cold', 60)).toBe(1); // from memory
    expect(coldMetrics.render()).toContain(
      `${hit},provider="upstash",service="upstash.redis",status="error"} 1`,
    );

    // Warmed: what RateLimitRedisWarmup does in onApplicationBootstrap.
    const warm = createRateLimitRedis(url);
    expect(await warmRateLimitRedis(warm)).toBe('ready');
    const warmMetrics = new MetricsRegistry();
    const warmStore = new FallbackRateLimitStore(new RedisRateLimitStore(warm, warmMetrics));
    expect(await warmStore.hit('boot|warm', 60)).toBe(1);
    expect(await warm.ttl('rl:boot|warm')).toBeGreaterThan(0); // it really went to Redis
    const out = warmMetrics.render();
    expect(out).toContain(`${hit},provider="upstash",service="upstash.redis",status="ok"} 1`);
    expect(out).not.toContain('status="error"');

    cold.disconnect();
    warm.disconnect();
  });
});

describe('CORS allowlist (BE-IMP-003)', () => {
  const preflight = (origin: string) =>
    api().inject({
      method: 'OPTIONS',
      url: '/v1/cms/places',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-gogo-csrf',
      },
    });

  it('allows a listed origin and the headers the CMS actually sends', async () => {
    const res = await preflight('http://localhost:5174');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5174');
    // Cookie-based session: without this the browser drops the response.
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const allowed = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowed).toContain('x-gogo-csrf');
    expect(allowed).toContain('idempotency-key');
  });

  it('refuses an origin that is not on the list', async () => {
    const res = await preflight('https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard origin', async () => {
    // `*` plus credentials would hand the session to any page the user opens.
    const res = await preflight('http://localhost:5174');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('per-actor rate-limit baseline (BE-IMP-005)', () => {
  const sharedIp = '10.90.0.1';

  async function admin(email: string) {
    const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
    await db
      .insert(schema.adminUsers)
      .values({ email, passwordHash, displayName: 'A', role: 'editor' });
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: '10.90.9.9',
      payload: { email, password: 'admin-password-123' },
    });
    return res.json().accessToken as string;
  }

  it("two admins behind one IP do not eat each other's budget", async () => {
    const a = await admin('rl-a@gogo.local');
    const b = await admin('rl-b@gogo.local');

    // Same source IP for both — the case that used to share one bucket.
    const call = (token: string) =>
      api().inject({
        method: 'GET',
        url: '/v1/cms/places?limit=1',
        remoteAddress: sharedIp,
        headers: { authorization: `Bearer ${token}` },
      });

    for (let i = 0; i < 40; i++) expect((await call(a)).statusCode).toBe(200);
    // B is untouched by A's traffic.
    expect((await call(b)).statusCode).toBe(200);
  });

  it('a higher admin baseline does not loosen a provider-quota limit', async () => {
    const token = await admin('rl-quota@gogo.local');
    // places.resolve_link is 10/min by IP regardless of who is calling: the
    // point of the endpoint limit is cost, not identity.
    const call = () =>
      api().inject({
        method: 'POST',
        url: '/v1/places/resolve-google-maps-link',
        remoteAddress: '10.91.0.1',
        headers: { authorization: `Bearer ${token}` },
        payload: { url: 'https://www.google.com/maps?place_id=fake-rl' },
      });

    let limited = false;
    for (let i = 0; i < 14 && !limited; i++) {
      if ((await call()).statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it('anonymous traffic is still bounded by IP', async () => {
    let limited = false;
    for (let i = 0; i < 200 && !limited; i++) {
      const res = await api().inject({
        method: 'GET',
        url: '/v1/taxonomies',
        remoteAddress: '10.92.0.1',
      });
      if (res.statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});
