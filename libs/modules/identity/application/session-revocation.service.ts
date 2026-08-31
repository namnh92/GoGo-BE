import { Inject, Injectable } from '@nestjs/common';
import type { RedisLike } from '../presentation/redis-rate-limit.store';

export const REVOCATION_STORE = Symbol('REVOCATION_STORE');

export interface RevocationStore {
  revoke(sessionId: string, ttlSeconds: number): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}

/**
 * Access tokens are self-contained, so logging out only kills the refresh
 * chain — the outstanding access token keeps working until it expires. This
 * denylist closes that window: revoked session ids are remembered for exactly
 * one access-token lifetime, which is all the time a leaked token has left.
 */
export class RedisRevocationStore implements RevocationStore {
  constructor(private readonly redis: RedisLike & { setex?: unknown; exists?: unknown }) {}

  async revoke(sessionId: string, ttlSeconds: number): Promise<void> {
    const r = this.redis as unknown as {
      set(k: string, v: string, mode: string, ttl: number): Promise<unknown>;
    };
    await r.set(`revoked:${sessionId}`, '1', 'EX', Math.max(1, ttlSeconds));
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    const r = this.redis as unknown as { get(k: string): Promise<string | null> };
    return (await r.get(`revoked:${sessionId}`)) !== null;
  }
}

/** Per-process fallback: correct for single-instance dev/test deployments. */
@Injectable()
export class InMemoryRevocationStore implements RevocationStore {
  private readonly entries = new Map<string, number>();

  revoke(sessionId: string, ttlSeconds: number): Promise<void> {
    this.entries.set(sessionId, Date.now() + ttlSeconds * 1000);
    if (this.entries.size > 10_000) {
      const now = Date.now();
      for (const [k, exp] of this.entries) if (exp <= now) this.entries.delete(k);
    }
    return Promise.resolve();
  }

  isRevoked(sessionId: string): Promise<boolean> {
    const exp = this.entries.get(sessionId);
    if (exp === undefined) return Promise.resolve(false);
    if (exp <= Date.now()) {
      this.entries.delete(sessionId);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }
}

/**
 * Redis is the shared source of truth; the in-memory copy keeps this instance
 * correct if Redis blips. A revocation is never *lost* locally, so the common
 * case (this instance logged the user out) stays enforced during an outage.
 */
export class FallbackRevocationStore implements RevocationStore {
  private readonly local = new InMemoryRevocationStore();

  constructor(private readonly primary: RevocationStore) {}

  async revoke(sessionId: string, ttlSeconds: number): Promise<void> {
    await this.local.revoke(sessionId, ttlSeconds);
    try {
      await this.primary.revoke(sessionId, ttlSeconds);
    } catch {
      // Local record still blocks this instance; other instances rely on the
      // authoritative DB check applied to sensitive routes.
    }
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    if (await this.local.isRevoked(sessionId)) return true;
    try {
      return await this.primary.isRevoked(sessionId);
    } catch {
      return false;
    }
  }
}

/**
 * Remembers "not revoked" for a few seconds, so an authenticated request does
 * not cost a Redis round trip.
 *
 * Every request through AuthGuard asked Redis whether its session was revoked.
 * Measured on DEV: one phone polling a room screen was 225 GETs a minute on
 * this key alone, and DEV is billed per command. The answer is "no" for every
 * request but the handful after a logout, so it is the one worth caching.
 *
 * What the cache costs: a logout performed on ANOTHER api instance takes effect
 * here up to `negativeTtlMs` later. On this instance it is immediate — `revoke`
 * drops the cached entry before writing through. The access token itself lives
 * fifteen minutes past a logout by design; this denylist narrows that window,
 * and five seconds of it are now spent on the cache.
 *
 * "Revoked" is never cached here: the layer below already remembers it locally
 * for the token's lifetime, and a revoked session is rejected on the first
 * request, after which the client stops sending it.
 */
export class CachedRevocationStore implements RevocationStore {
  private readonly clearedUntil = new Map<string, number>();

  constructor(
    private readonly inner: RevocationStore,
    private readonly negativeTtlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async revoke(sessionId: string, ttlSeconds: number): Promise<void> {
    this.clearedUntil.delete(sessionId);
    await this.inner.revoke(sessionId, ttlSeconds);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    const until = this.clearedUntil.get(sessionId);
    if (until !== undefined && until > this.now()) return false;

    const revoked = await this.inner.isRevoked(sessionId);
    if (revoked) {
      this.clearedUntil.delete(sessionId);
      return true;
    }
    this.clearedUntil.set(sessionId, this.now() + this.negativeTtlMs);
    if (this.clearedUntil.size > 50_000) this.sweep();
    return false;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, until] of this.clearedUntil) if (until <= now) this.clearedUntil.delete(id);
  }
}

@Injectable()
export class SessionRevocationService {
  constructor(
    @Inject(REVOCATION_STORE) private readonly store: RevocationStore,
    @Inject('ACCESS_TTL_SECONDS') private readonly accessTtlSeconds: number,
  ) {}

  async revokeSession(sessionId: string): Promise<void> {
    await this.store.revoke(sessionId, this.accessTtlSeconds);
  }

  async revokeMany(sessionIds: string[]): Promise<void> {
    await Promise.all(sessionIds.map((id) => this.revokeSession(id)));
  }

  isRevoked(sessionId: string): Promise<boolean> {
    return this.store.isRevoked(sessionId);
  }
}
