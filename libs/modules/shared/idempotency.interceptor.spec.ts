import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../identity/domain/actor';
import { RoomPolicy } from '../rooms/presentation/room-policy';
import {
  beginIdempotent,
  HOST_REPLAY_KEY,
  IdempotencyInterceptor,
  idempotencyScope,
} from './idempotency.interceptor';

const actor: Actor = { type: 'user', id: 'actor-a', sessionId: 'session-a' };
const key = 'regression-879';
function request(route = '/v1/rooms/:id/invites', params: Record<string, string> = { id: 'r1' }) {
  return {
    method: 'POST',
    url: route,
    routeOptions: { url: route },
    params,
    actor,
    ip: '127.0.0.1',
    headers: { 'idempotency-key': key },
    body: { maxUses: 3 },
  } as unknown as FastifyRequest & { actor: Actor };
}
function replayDb(rows: unknown[][]) {
  const limit = vi.fn();
  for (const row of rows) limit.mockResolvedValueOnce(row);
  const db = {
    insert: vi.fn(() => ({
      values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }),
    })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
    execute: vi.fn(),
    delete: vi.fn(),
  };
  return db;
}
function record(req = request(), body: unknown = { inviteId: 'invite-r1', code: 'credential-r1' }) {
  const scope = idempotencyScope(req, key);
  return {
    key: scope.storedKey,
    requestHash: scope.requestHash,
    responseStatus: 201,
    responseBody: body,
  };
}
function intercept(
  req: ReturnType<typeof request>,
  db: ReturnType<typeof replayDb>,
  source: string,
) {
  const handler = () => undefined;
  Reflect.defineMetadata(HOST_REPLAY_KEY, source, handler);
  const reply = { status: vi.fn().mockReturnThis(), header: vi.fn() };
  const context = {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
  } as unknown as ExecutionContext;
  const next = { handle: vi.fn(() => of({ unexpected: true })) };
  return {
    result: firstValueFrom(
      new IdempotencyInterceptor(db as never, new Reflector()).intercept(context, next),
    ),
    next,
    reply,
  };
}
afterEach(() => vi.restoreAllMocks());

describe('resource-bound idempotency identity (#879 F-01)', () => {
  it.each([
    '/v1/rooms/:id/invites',
    '/v1/rooms/:id/title',
    '/v1/plans/:id/stops/:stopId',
    '/v1/cms/users/:id/export',
    '/v1/share-links/:slug',
    '/v1/reviews/:id/helpful',
    '/v1/me/notifications/:id/read',
    '/v1/assistant/conversations/:id/messages',
  ])('keeps the claim namespace but rejects different resources on %s', (route) => {
    const a = idempotencyScope(request(route, { id: 'r1', stopId: 's1', slug: 'a' }), key);
    const b = idempotencyScope(request(route, { id: 'r2', stopId: 's1', slug: 'a' }), key);
    expect(b.storedKey).toBe(a.storedKey);
    expect(b.requestHash).not.toBe(a.requestHash);
  });
  it('binds every nested param and sorts parameter names for stable retries', () => {
    const a = idempotencyScope(
      request('/plans/:id/stops/:stopId', { id: 'p1', stopId: 's1' }),
      key,
    );
    const retry = idempotencyScope(
      request('/plans/:id/stops/:stopId', { stopId: 's1', id: 'p1' }),
      key,
    );
    const other = idempotencyScope(
      request('/plans/:id/stops/:stopId', { id: 'p1', stopId: 's2' }),
      key,
    );
    expect(retry).toEqual(a);
    expect(other.storedKey).toBe(a.storedKey);
    expect(other.requestHash).not.toBe(a.requestHash);
    // A disjoint format prevents any legacy 64-hex body hash from being
    // mistaken for a bound request, regardless of its original body shape.
    expect(a.requestHash).toMatch(/^v2:[a-f0-9]{64}$/);
  });
  it('isolates actors, actor types, methods and route templates; binds body changes', () => {
    const req = request();
    const scope = idempotencyScope(req, key);
    for (const change of [
      { actor: { ...actor, id: 'b' } },
      { actor: { ...actor, type: 'admin' as const } },
      { method: 'PATCH' },
      { routeOptions: { url: '/other/:id' } },
    ]) {
      expect(idempotencyScope({ ...req, ...change } as typeof req, key).storedKey).not.toBe(
        scope.storedKey,
      );
    }
    expect(idempotencyScope({ ...req, body: { maxUses: 4 } }, key).requestHash).not.toBe(
      scope.requestHash,
    );
  });
  it('returns mismatch for another resource before any replay or execution', async () => {
    const existing = record();
    const db = replayDb([[existing]]);
    await expect(
      beginIdempotent(db as never, idempotencyScope(request(undefined, { id: 'r2' }), key)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422 });
  });
  it.each([201, null])(
    'fails closed for legacy body-only records (status %s), retaining the claim',
    async (status) => {
      const req = request();
      const scope = idempotencyScope(req, key);
      const legacyHash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
      const db = replayDb([[{ ...record(req), responseStatus: status, requestHash: legacyHash }]]);
      await expect(
        beginIdempotent(db as never, scope, {
          replayVersion: 1,
          adoptLegacy: () => ({ code: 'unsafe' }),
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422 });
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
    },
  );
});

describe('cached resource authorization (#879 F-01)', () => {
  it.each([
    ['room-param', { id: 'r1', code: 'summary-code' }, []],
    ['created-room', { id: 'r1', code: 'summary-code' }, []],
    ['room-param', { inviteId: 'invite-r1', code: 'invite-code' }, [[{ roomId: 'r1' }]]],
    [
      'share-body',
      { id: 'link-r1', type: 'ROOM_INVITE', url: 'credential' },
      [[{ roomId: 'r1', type: 'ROOM_INVITE' }]],
    ],
  ] as const)('authorizes the actual cached resource for %s', async (source, body, lookups) => {
    const req = request(undefined, { id: 'r2' });
    req.body = { type: 'ROOM_INVITE', entityId: 'r2' };
    const db = replayDb([[record(req, body)], ...lookups.map((rows) => [...rows])]);
    const requireHost = vi
      .spyOn(RoomPolicy.prototype, 'requireHost')
      .mockRejectedValue(new Error('former host'));
    const { result, next, reply } = intercept(req, db, source);
    await expect(result).rejects.toThrow('former host');
    expect(requireHost).toHaveBeenCalledWith(actor, 'r1');
    expect(next.handle).not.toHaveBeenCalled();
    expect(reply.header).not.toHaveBeenCalled();
  });
  it('preserves same-resource credential replay for the current host', async () => {
    const req = request();
    const existing = record(req);
    const db = replayDb([[existing], [{ roomId: 'r1' }]]);
    vi.spyOn(RoomPolicy.prototype, 'requireHost').mockResolvedValue({} as never);
    const { result, next, reply } = intercept(req, db, 'room-param');
    await expect(result).resolves.toEqual(existing.responseBody);
    expect(reply.header).toHaveBeenCalledWith('x-idempotent-replay', 'true');
    expect(next.handle).not.toHaveBeenCalled();
  });
  it.each(['room-param', 'created-room', 'share-body'])(
    'rejects unresolved cached host resources for %s',
    async (source) => {
      const req = request();
      req.body = { type: 'ROOM_INVITE', entityId: 'r1' };
      const db = replayDb([[record(req, {})]]);
      const { result, next, reply } = intercept(req, db, source);
      await expect(result).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        httpStatus: 422,
      });
      expect(next.handle).not.toHaveBeenCalled();
      expect(reply.header).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['room-param', { inviteId: 'deleted-invite', code: 'credential' }],
    ['share-body', { id: 'deleted-link', type: 'ROOM_INVITE', url: 'credential' }],
  ] as const)('fails closed when the cached %s resource no longer exists', async (source, body) => {
    const req = request();
    const db = replayDb([[record(req, body)], []]);
    const { result, reply } = intercept(req, db, source);
    await expect(result).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422 });
    expect(reply.header).not.toHaveBeenCalled();
  });
});
