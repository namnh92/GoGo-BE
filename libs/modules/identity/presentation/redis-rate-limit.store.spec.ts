import { MetricsRegistry } from '@gogo/observability';
import { describe, expect, it } from 'vitest';
import {
  FallbackRateLimitStore,
  RedisRateLimitStore,
  type RedisLike,
} from './redis-rate-limit.store';

function fakeRedis(overrides: Partial<RedisLike> = {}): RedisLike & { calls: string[] } {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  return {
    calls,
    async incr(key) {
      calls.push(`incr ${key}`);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire(key, seconds) {
      calls.push(`expire ${key} ${seconds}`);
      return 1;
    },
    ...overrides,
  };
}

describe('RedisRateLimitStore runtime telemetry (#414)', () => {
  it('records one ok call per hit, whether it took one round trip or two', async () => {
    const registry = new MetricsRegistry();
    const redis = fakeRedis();
    const store = new RedisRateLimitStore(redis, registry);
    expect(await store.hit('login:1.2.3.4', 60)).toBe(1);
    expect(await store.hit('login:1.2.3.4', 60)).toBe(2);
    expect(redis.calls).toEqual([
      'incr rl:login:1.2.3.4',
      'expire rl:login:1.2.3.4 60',
      'incr rl:login:1.2.3.4',
    ]);
    expect(registry.render()).toContain(
      'provider_requests_total{operation="upstash.redis.rate_limit.hit",provider="upstash",service="upstash.redis",status="ok"} 2',
    );
    // The key is never a label.
    expect(registry.render()).not.toContain('login');
  });

  it('records a Redis failure as error and the fail-open wrapper still answers from memory', async () => {
    const registry = new MetricsRegistry();
    const redis = fakeRedis({
      incr: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const store = new FallbackRateLimitStore(new RedisRateLimitStore(redis, registry));
    expect(await store.hit('otp:user-1', 60)).toBe(1);
    expect(registry.render()).toContain('status="error"} 1');
    expect(registry.render()).not.toContain('status="ok"');
  });

  it('measures nothing when no sink is given', async () => {
    const store = new RedisRateLimitStore(fakeRedis());
    expect(await store.hit('k', 1)).toBe(1);
  });
});
