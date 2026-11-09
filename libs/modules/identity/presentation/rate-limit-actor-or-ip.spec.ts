import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY, OPTIONAL_AUTH_KEY, RATE_LIMIT_KEY, type RateLimitSpec } from './decorators';
import { AuthGuard } from './auth.guard';
import { RateLimitGuard } from './rate-limit.guard';

const actor = { type: 'user', id: 'alice', sessionId: 'session-1' };

async function keys(keyBy: RateLimitSpec['keyBy'], authenticated: boolean) {
  const recorded: string[] = [];
  const handler = () => undefined;
  Reflect.defineMetadata(
    RATE_LIMIT_KEY,
    { action: 'photos', limit: 120, windowSeconds: 60, keyBy },
    handler,
  );
  const guard = new RateLimitGuard(
    new Reflector(),
    { hit: async (key) => (recorded.push(key), 1) },
    { hit: async () => 1 },
  );
  for (const ip of ['192.0.2.1', '192.0.2.2']) {
    await guard.canActivate({
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({ url: '/v1/photos', ip, ...(authenticated ? { actor } : {}) }),
      }),
    } as never);
  }
  return recorded;
}

describe('rate-limit key modes', () => {
  it('uses the actor across IP changes, or the IP when anonymous', async () => {
    expect(await keys('actorOrIp', true)).toEqual(['photos|user:alice', 'photos|user:alice']);
    expect(await keys('actorOrIp', false)).toEqual(['photos|192.0.2.1', 'photos|192.0.2.2']);
  });

  it('uses the same IP bucket for missing and invalid tokens after optional authentication', async () => {
    const recorded: string[] = [];
    const handler = () => undefined;
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    Reflect.defineMetadata(OPTIONAL_AUTH_KEY, true, handler);
    Reflect.defineMetadata(
      RATE_LIMIT_KEY,
      { action: 'photos', limit: 120, windowSeconds: 60, keyBy: 'actorOrIp' },
      handler,
    );
    const auth = new AuthGuard(
      new Reflector(),
      {
        verifyAccessToken: () => {
          throw new Error('invalid private-token');
        },
      } as never,
      {} as never,
      {} as never,
    );
    const limiter = new RateLimitGuard(
      new Reflector(),
      {
        hit: async (key) => (recorded.push(key), 1),
      },
      { hit: async () => 1 },
    );
    for (const authorization of [undefined, 'Bearer private-token']) {
      const request = {
        method: 'GET',
        url: '/v1/photos',
        ip: '192.0.2.1',
        headers: { authorization },
      };
      const context = {
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => request }),
      } as never;
      expect(await auth.canActivate(context)).toBe(true);
      expect(await limiter.canActivate(context)).toBe(true);
    }
    expect(recorded).toEqual(['photos|192.0.2.1', 'photos|192.0.2.1']);
  });

  it('reaches the IP limiter when optional session lookup times out', async () => {
    const recorded: string[] = [];
    const handler = () => undefined;
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    Reflect.defineMetadata(OPTIONAL_AUTH_KEY, true, handler);
    Reflect.defineMetadata(
      RATE_LIMIT_KEY,
      { action: 'photos', limit: 120, windowSeconds: 60, keyBy: 'actorOrIp' },
      handler,
    );
    const auth = new AuthGuard(
      new Reflector(),
      { verifyAccessToken: () => ({ sid: 'session-1', sub: 'alice', act: 'user' }) } as never,
      {} as never,
      {
        findAuthSessionById: async () => {
          throw Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          });
        },
      } as never,
    );
    const limiter = new RateLimitGuard(
      new Reflector(),
      { hit: async (key) => (recorded.push(key), 1) },
      { hit: async () => 1 },
    );
    const request = {
      method: 'GET',
      url: '/v1/photos',
      ip: '192.0.2.1',
      headers: { authorization: 'Bearer valid' },
      actor: { ...actor },
    };
    const context = {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
    expect(await auth.canActivate(context)).toBe(true);
    expect(request.actor).toBeUndefined();
    expect(await limiter.canActivate(context)).toBe(true);
    expect(recorded).toEqual(['photos|192.0.2.1']);
  });

  it.each([
    ['ip', true, ['photos|192.0.2.1', 'photos|192.0.2.2']],
    ['ip', false, ['photos|192.0.2.1', 'photos|192.0.2.2']],
    ['actor', true, ['photos|user:alice', 'photos|user:alice']],
    ['actor', false, ['photos|anon', 'photos|anon']],
    ['ip+actor', true, ['photos|192.0.2.1|user:alice', 'photos|192.0.2.2|user:alice']],
    ['ip+actor', false, ['photos|192.0.2.1|anon', 'photos|192.0.2.2|anon']],
  ] as const)('preserves %s (authenticated=%s)', async (mode, authenticated, expected) => {
    expect(await keys(mode, authenticated)).toEqual(expected);
  });
});
