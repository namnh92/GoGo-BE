import { Injectable } from '@nestjs/common';

/**
 * Sliding-window counter. In-memory implementation is per-process — correct
 * for MVP single-instance deploys and tests. BE-BFF-011 swaps the store for
 * Redis behind this same interface before any multi-instance deploy.
 */
export interface RateLimitStore {
  hit(key: string, windowSeconds: number): Promise<number>;
}

@Injectable()
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, number[]>();

  hit(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const cutoff = now - windowSeconds * 1000;
    const times = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);
    times.push(now);
    this.buckets.set(key, times);
    // Opportunistic cleanup to bound memory.
    if (this.buckets.size > 50_000) {
      for (const [k, v] of this.buckets) {
        if (v.every((t) => t <= cutoff)) this.buckets.delete(k);
      }
    }
    return Promise.resolve(times.length);
  }
}

/** Store for the per-action `@RateLimit` specs: exact, shared across instances. */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

/**
 * Store for the per-actor baseline: a flood ceiling, per process on purpose.
 *
 * The baseline ran through the shared store, which made every authenticated
 * request one Redis INCR before it reached a controller — on DEV, billed per
 * command, that was most of the free tier. A ceiling of 300 requests a minute
 * does not need to be exact across instances: with N instances it is N times
 * looser, and a flood that stays under N × 300 a minute is not the flood it is
 * there to stop. The limits that must be exact — login, OTP, invite lookup,
 * provider quota — stay on RATE_LIMIT_STORE.
 */
export const BASELINE_RATE_LIMIT_STORE = Symbol('BASELINE_RATE_LIMIT_STORE');
