import { InMemoryRateLimitStore, type RateLimitStore } from './rate-limit.service';

/** Structural slice of ioredis we use — keeps client versions decoupled. */
export type RedisLike = {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
};

/**
 * Fixed-window counter in Redis — correct across api instances (the
 * in-memory store is per-process and only for single-instance/dev).
 * INCR + EXPIRE-on-first-hit keeps it one round trip in the common case.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike) {}

  async hit(key: string, windowSeconds: number): Promise<number> {
    const bucket = `rl:${key}`;
    const count = await this.redis.incr(bucket);
    if (count === 1) {
      await this.redis.expire(bucket, windowSeconds);
    }
    return count;
  }
}

/**
 * Fail-open wrapper: when Redis is unreachable, rate limiting degrades to
 * the per-process store instead of failing every request. Availability of
 * the API wins; the security regression window is bounded to the outage.
 */
export class FallbackRateLimitStore implements RateLimitStore {
  private readonly fallback = new InMemoryRateLimitStore();

  constructor(private readonly primary: RateLimitStore) {}

  async hit(key: string, windowSeconds: number): Promise<number> {
    try {
      return await this.primary.hit(key, windowSeconds);
    } catch {
      return this.fallback.hit(key, windowSeconds);
    }
  }
}
