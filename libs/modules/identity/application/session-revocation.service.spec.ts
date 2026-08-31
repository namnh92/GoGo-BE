import { describe, expect, it, vi } from 'vitest';
import { CachedRevocationStore, type RevocationStore } from './session-revocation.service';

function inner(revoked: Set<string> = new Set()) {
  const store: RevocationStore & { reads: number } = {
    reads: 0,
    async revoke(id) {
      revoked.add(id);
    },
    async isRevoked(id) {
      store.reads += 1;
      return revoked.has(id);
    },
  };
  return store;
}

describe('CachedRevocationStore', () => {
  it('answers "not revoked" from memory for the TTL, then asks again', async () => {
    let now = 1_000;
    const store = inner();
    const cached = new CachedRevocationStore(store, 5_000, () => now);

    expect(await cached.isRevoked('s1')).toBe(false);
    expect(await cached.isRevoked('s1')).toBe(false);
    expect(await cached.isRevoked('s1')).toBe(false);
    expect(store.reads).toBe(1);

    now += 5_000;
    expect(await cached.isRevoked('s1')).toBe(false);
    expect(store.reads).toBe(2);
  });

  it('never caches "revoked", so a revoked session is refused on the first request', async () => {
    const store = inner(new Set(['s2']));
    const cached = new CachedRevocationStore(store, 5_000, () => 0);

    expect(await cached.isRevoked('s2')).toBe(true);
    expect(await cached.isRevoked('s2')).toBe(true);
    expect(store.reads).toBe(2);
  });

  it('a revoke on this instance takes effect immediately, not after the TTL', async () => {
    const revoked = new Set<string>();
    const store = inner(revoked);
    const cached = new CachedRevocationStore(store, 5_000, () => 0);

    expect(await cached.isRevoked('s3')).toBe(false);
    await cached.revoke('s3', 900);
    expect(await cached.isRevoked('s3')).toBe(true);
  });

  it('a revoke elsewhere is seen once the cached answer expires', async () => {
    let now = 0;
    const revoked = new Set<string>();
    const store = inner(revoked);
    const cached = new CachedRevocationStore(store, 5_000, () => now);

    expect(await cached.isRevoked('s4')).toBe(false);
    revoked.add('s4'); // another instance wrote to Redis
    expect(await cached.isRevoked('s4')).toBe(false); // still cached: the documented window
    now += 5_000;
    expect(await cached.isRevoked('s4')).toBe(true);
  });

  it('keys are independent', async () => {
    const store = inner(new Set(['bad']));
    const cached = new CachedRevocationStore(store, 5_000, () => 0);
    const spy = vi.spyOn(store, 'isRevoked');

    expect(await cached.isRevoked('good')).toBe(false);
    expect(await cached.isRevoked('bad')).toBe(true);
    expect(await cached.isRevoked('good')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
