import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AppError } from '../../shared/app-error';
import type { TokenService } from '../application/token.service';
import type { SessionRevocationService } from '../application/session-revocation.service';
import type { IdentityRepository } from '../infrastructure/identity.repository';

describe('consumer authoritative session guard', () => {
  function setup(
    act = 'user',
    session: unknown = { userId: 'user-1', supersededAt: new Date(), revokedAt: null },
  ) {
    const repo = { findAuthSessionById: vi.fn().mockResolvedValue(session) };
    const req = { headers: { authorization: 'Bearer access' }, method: 'GET' };
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const guard = new AuthGuard(
      { getAllAndOverride: () => false } as unknown as Reflector,
      {
        verifyAccessToken: () => ({ sid: 'session-1', sub: 'user-1', act }),
      } as unknown as TokenService,
      { isRevoked: async () => false } as unknown as SessionRevocationService,
      repo as unknown as IdentityRepository,
    );
    return { guard, context, repo };
  }

  it.each([undefined, { userId: 'other-user' }, { userId: 'user-1', revokedAt: new Date() }])(
    'rejects missing, wrong-owner or revoked sessions despite a negative cache',
    async (session) => {
      const { guard, context, repo } = setup();
      repo.findAuthSessionById.mockResolvedValue(session);
      await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    },
  );

  it('accepts superseded access sessions', async () => {
    const { guard, context } = setup();
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('fails closed when the database cannot answer', async () => {
    const { guard, context, repo } = setup();
    repo.findAuthSessionById.mockRejectedValue(new Error('database unavailable'));
    await expect(guard.canActivate(context)).rejects.toThrow('database unavailable');
  });

  it.each([
    ...[
      'ECONNREFUSED',
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      '08000',
      '08001',
      '08003',
      '08006',
      '08007',
      '53300',
      '57P01',
      '57P02',
      '57P03',
    ].map((code) => Object.assign(new Error('sanitized driver diagnostic'), { code })),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    ...[
      'timeout exceeded when trying to connect',
      'Connection terminated due to connection timeout',
      'Connection terminated unexpectedly',
      'Query read timeout',
    ].map((message) => new Error(message)),
  ])(
    'maps direct and Drizzle-wrapped operational lookup failure %s to retryable 503',
    async (cause) => {
      for (const error of [
        cause,
        new Error('Failed query: private params', { cause: new Error('wrapper', { cause }) }),
      ]) {
        const { guard, context, repo } = setup();
        repo.findAuthSessionById.mockRejectedValue(error);
        await expect(guard.canActivate(context)).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          httpStatus: 503,
          options: { retryable: true },
          cause: undefined,
        });
      }
    },
  );

  it.each([
    new TypeError('programming error'),
    ...['42601', '42P01', '42703', '42501', '28P01', '3D000', '57014', '55P03'].map((code) =>
      Object.assign(new Error('unexpected or non-timeout failure'), { code }),
    ),
    AppError.forbidden('DENIED', 'Existing application error'),
    new Error('wrapper', { cause: AppError.internal() }),
    new Error('wrapper', { cause: new TypeError('unexpected cause') }),
    Object.assign(new Error('permission failure'), {
      code: '42501',
      cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    }),
  ])(
    'preserves unexpected, configuration and existing AppError lookup failures %s',
    async (error) => {
      const { guard, context, repo } = setup();
      repo.findAuthSessionById.mockRejectedValue(error);
      await expect(guard.canActivate(context)).rejects.toBe(error);
    },
  );

  it('bounds cyclic cause traversal', async () => {
    const error = new Error('cyclic');
    error.cause = error;
    const { guard, context, repo } = setup();
    repo.findAuthSessionById.mockRejectedValue(error);
    await expect(guard.canActivate(context)).rejects.toBe(error);
  });

  it.each(['guest', 'admin'])('leaves %s session behavior unchanged', async (act) => {
    const { guard, context, repo } = setup(act);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(repo.findAuthSessionById).not.toHaveBeenCalled();
  });
});

describe('optional authentication', () => {
  function setup(publicRoute: boolean, optional: boolean, authorization?: string) {
    const request = {
      method: 'GET',
      headers: { authorization },
      actor: undefined,
      cookies: {} as Record<string, string>,
    };
    const verifyAccessToken = vi.fn(() => ({ sid: 's1', sub: 'u1', act: 'user' }));
    const repo = { findAuthSessionById: vi.fn().mockResolvedValue({ userId: 'u1' }) };
    const isRevoked = vi.fn().mockResolvedValue(false);
    const guard = new AuthGuard(
      {
        getAllAndOverride: (key: string) => (key === 'gogo:is_public' ? publicRoute : optional),
      } as unknown as Reflector,
      { verifyAccessToken } as unknown as TokenService,
      { isRevoked } as unknown as SessionRevocationService,
      repo as unknown as IdentityRepository,
    );
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { guard, context, request, verifyAccessToken, repo, isRevoked };
  }

  it('allows anonymous requests without token verification', async () => {
    const h = setup(true, true);
    await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
    expect(h.verifyAccessToken).not.toHaveBeenCalled();
    expect(h.request.actor).toBeUndefined();
  });

  it('resolves a supplied token through authoritative session checks', async () => {
    const h = setup(true, true, 'Bearer valid');
    await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
    expect(h.repo.findAuthSessionById).toHaveBeenCalledWith('s1');
    expect(h.request.actor).toMatchObject({ type: 'user', id: 'u1', sessionId: 's1' });
  });

  it.each(['Bearer ', 'Basic invalid'])(
    'treats malformed header %s as anonymous',
    async (header) => {
      const h = setup(true, true, header);
      await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
      expect(h.request.actor).toBeUndefined();
      expect(h.verifyAccessToken).not.toHaveBeenCalled();
    },
  );

  it.each(['bearer', 'cookie'])(
    'discards invalid/expired %s credentials and verifier details',
    async (source) => {
      const h = setup(true, true, source === 'bearer' ? 'Bearer private-token' : undefined);
      if (source === 'cookie') h.request.cookies.gogo_at = 'private-token';
      h.verifyAccessToken.mockImplementation(() => {
        throw new Error('expired private-token: private claims');
      });
      const spies = ['log', 'warn', 'error', 'info', 'debug'].map((method) =>
        vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
      );
      try {
        await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
        expect(h.request.actor).toBeUndefined();
        expect(h.repo.findAuthSessionById).not.toHaveBeenCalled();
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    },
  );

  it.each([null, { userId: 'other' }, { userId: 'u1', revokedAt: new Date() }])(
    'treats an invalid authoritative session as anonymous',
    async (session) => {
      const h = setup(true, true, 'Bearer valid');
      h.repo.findAuthSessionById.mockResolvedValue(session);
      await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
      expect(h.request.actor).toBeUndefined();
    },
  );

  it('treats a denylisted session as anonymous', async () => {
    const h = setup(true, true, 'Bearer valid');
    h.isRevoked.mockResolvedValue(true);
    await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
    expect(h.request.actor).toBeUndefined();
  });

  it('keeps invalid credentials rejected on protected routes', async () => {
    const h = setup(false, false, 'Bearer invalid');
    h.verifyAccessToken.mockImplementation(() => {
      throw new Error('invalid');
    });
    await expect(h.guard.canActivate(h.context)).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('keeps ordinary public routes bypassing authentication', async () => {
    const h = setup(true, false, 'Bearer invalid');
    await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
    expect(h.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('keeps protected routes requiring credentials', async () => {
    const h = setup(false, false);
    await expect(h.guard.canActivate(h.context)).rejects.toBeInstanceOf(AppError);
  });
});
