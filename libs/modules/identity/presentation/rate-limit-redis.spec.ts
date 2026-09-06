import { MetricsRegistry } from '@gogo/observability';
import { describe, expect, it } from 'vitest';
import { RateLimitRedisWarmup, warmRateLimitRedis, type RateLimitRedis } from './rate-limit-redis';
import { FallbackRateLimitStore, RedisRateLimitStore } from './redis-rate-limit.store';

/**
 * A client with ioredis's `lazyConnect` + `enableOfflineQueue: false`
 * semantics: a command before the socket is up is refused at once with the
 * message ioredis uses; `connect()` resolves once ready.
 */
function fakeRedis(mode: 'up' | 'refused' | 'never' = 'up', connectDelayMs = 5) {
  let connected = false;
  const counts = new Map<string, number>();
  const refuse = () => new Error("Stream isn't writeable and enableOfflineQueue options is false");
  const redis: RateLimitRedis & { connectCalls: number } = {
    status: 'wait',
    connectCalls: 0,
    connect() {
      redis.connectCalls += 1;
      if (mode === 'never') return new Promise<void>(() => undefined);
      if (mode === 'refused') return Promise.reject(new Error('connect ECONNREFUSED'));
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          connected = true;
          redis.status = 'ready';
          resolve();
        }, connectDelayMs),
      );
    },
    async incr(key) {
      if (!connected) throw refuse();
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire() {
      if (!connected) throw refuse();
      return 1;
    },
  };
  return redis;
}

const HIT = 'provider_requests_total{operation="upstash.redis.rate_limit.hit"';

describe('rate-limit Redis warm-up (#424)', () => {
  it('documents the defect: without warm-up the first hit after boot is an error answered from memory', async () => {
    const registry = new MetricsRegistry();
    const store = new FallbackRateLimitStore(new RedisRateLimitStore(fakeRedis(), registry));
    expect(await store.hit('login:1.1.1.1', 60)).toBe(1);
    expect(registry.render()).toContain(
      `${HIT},provider="upstash",service="upstash.redis",status="error"} 1`,
    );
  });

  it('after bootstrap warm-up, the first hit is ok and no error series exists', async () => {
    const registry = new MetricsRegistry();
    const redis = fakeRedis();
    const store = new FallbackRateLimitStore(new RedisRateLimitStore(redis, registry));
    await new RateLimitRedisWarmup(redis).onApplicationBootstrap();
    expect(redis.status).toBe('ready');
    expect(await store.hit('login:1.1.1.1', 60)).toBe(1);
    const out = registry.render();
    expect(out).toContain(`${HIT},provider="upstash",service="upstash.redis",status="ok"} 1`);
    expect(out).not.toContain('status="error"');
  });

  it('Redis down at startup: warm-up reports unavailable, never throws, and the store still fails open', async () => {
    const registry = new MetricsRegistry();
    const redis = fakeRedis('refused');
    const store = new FallbackRateLimitStore(new RedisRateLimitStore(redis, registry));
    await expect(warmRateLimitRedis(redis)).resolves.toBe('unavailable');
    await expect(new RateLimitRedisWarmup(redis).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(await store.hit('otp:u1', 60)).toBe(1);
    expect(registry.render()).toContain('status="error"} 1');
  });

  it('warm-up is bounded: a Redis that never answers yields timeout within the budget', async () => {
    const started = Date.now();
    await expect(warmRateLimitRedis(fakeRedis('never'), 30)).resolves.toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('an already-ready client is left alone', async () => {
    const redis = fakeRedis();
    await redis.connect();
    await expect(warmRateLimitRedis(redis)).resolves.toBe('already');
    expect(redis.connectCalls).toBe(1);
  });

  it('no Redis configured: the bootstrap hook is a no-op', async () => {
    await expect(new RateLimitRedisWarmup(null).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
