import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import IORedis from 'ioredis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

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

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
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
    const token = await register('idem1@gogo.vn');
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
    const token = await register('idem2@gogo.vn');
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
    const tokenA = await register('idem3a@gogo.vn');
    const tokenB = await register('idem3b@gogo.vn');
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
    const token = await register('idem4@gogo.vn');
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
    const token = await register('idem5@gogo.vn');
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
});
