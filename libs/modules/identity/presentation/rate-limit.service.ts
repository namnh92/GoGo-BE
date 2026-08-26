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

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
