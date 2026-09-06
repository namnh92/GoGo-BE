import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_KEY, type RateLimitSpec } from './decorators';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitStore } from './rate-limit.service';

/**
 * SEC-004 (#445) — which bucket a share-link resolve lands in.
 *
 * Asserted at the guard rather than end to end, because the property is "these
 * two requests are counted separately" and the limit is 600 a minute: proving
 * it through the HTTP surface would mean twelve hundred requests to observe
 * one boolean. A recording store shows the keys directly.
 */

class RecordingStore implements RateLimitStore {
  readonly keys: string[] = [];
  hit(key: string): Promise<number> {
    this.keys.push(key);
    return Promise.resolve(1);
  }
}

const RESOLVE_SPEC: RateLimitSpec = {
  action: 'share_links.resolve',
  limit: 600,
  windowSeconds: 60,
  keyBy: 'ip',
  edgeClientIp: true,
};

/** Every other IP-keyed route: unchanged by this feature, and asserted so. */
const PLAIN_SPEC: RateLimitSpec = {
  action: 'auth.login',
  limit: 5,
  windowSeconds: 60,
  keyBy: 'ip',
};

function harness(spec: RateLimitSpec) {
  const reflector = new Reflector();
  const store = new RecordingStore();
  const baseline = new RecordingStore();
  const guard = new RateLimitGuard(reflector, store, baseline);
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class {},
  };
  let request: Record<string, unknown> = {};
  const handler = (): void => undefined;
  Reflect.defineMetadata(RATE_LIMIT_KEY, spec, handler);

  return {
    store,
    baseline,
    async call(req: { ip?: string; edgeClientIp?: string; url?: string }) {
      request = { url: '/v1/share-links/abc', ...req };
      await guard.canActivate(context as never);
    },
  };
}

describe('share-link rate limiting keys on the forwarded address', () => {
  it('gives two visitors behind one edge two buckets', async () => {
    // The failure this fixes: without the forwarded address both of these are
    // the Worker's egress, so one visitor's traffic exhausts the other's limit
    // and the ceiling belongs to the whole product.
    const h = harness(RESOLVE_SPEC);
    await h.call({ ip: '198.51.100.1', edgeClientIp: '203.0.113.7' });
    await h.call({ ip: '198.51.100.1', edgeClientIp: '203.0.113.8' });

    expect(h.store.keys).toEqual([
      'share_links.resolve|203.0.113.7',
      'share_links.resolve|203.0.113.8',
    ]);
    expect(new Set(h.store.keys).size).toBe(2);
  });

  it('counts one visitor once, however many edge addresses they arrive through', async () => {
    const h = harness(RESOLVE_SPEC);
    await h.call({ ip: '198.51.100.1', edgeClientIp: '203.0.113.7' });
    await h.call({ ip: '198.51.100.2', edgeClientIp: '203.0.113.7' });
    expect(new Set(h.store.keys).size).toBe(1);
  });

  it('falls back to the connecting address when the hop did not authenticate', async () => {
    // `edgeClientIp` is absent because the hook refused or stripped it. The
    // route still has a limit; it is just the one it had before SEC-004.
    const h = harness(RESOLVE_SPEC);
    await h.call({ ip: '198.51.100.1' });
    expect(h.store.keys).toEqual(['share_links.resolve|198.51.100.1']);
  });

  it('a spoofer cannot mint fresh buckets, because two of them share one address', async () => {
    const h = harness(RESOLVE_SPEC);
    await h.call({ ip: '198.51.100.9' });
    await h.call({ ip: '198.51.100.9' });
    expect(new Set(h.store.keys).size).toBe(1);
  });

  it('leaves every other IP-keyed route on the connecting address', async () => {
    // Scope check. A forwarded value that leaked into `auth.login` would let
    // the edge — or anything that ever impersonated it — reset the login limit
    // at will.
    const h = harness(PLAIN_SPEC);
    await h.call({ ip: '198.51.100.1', edgeClientIp: '203.0.113.7' });
    expect(h.store.keys).toEqual(['auth.login|198.51.100.1']);
  });

  it('leaves the per-actor baseline on the connecting address', async () => {
    // A busy edge is still held to one baseline bucket: that is the origin
    // protection the forwarded value must not dissolve.
    const h = harness(RESOLVE_SPEC);
    await h.call({ ip: '198.51.100.1', edgeClientIp: '203.0.113.7' });
    await h.call({ ip: '198.51.100.1', edgeClientIp: '203.0.113.8' });
    expect(h.baseline.keys).toEqual(['baseline|ip:198.51.100.1', 'baseline|ip:198.51.100.1']);
  });
});
