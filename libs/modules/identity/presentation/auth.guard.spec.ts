import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import type { TokenService } from '../application/token.service';
import type { SessionRevocationService } from '../application/session-revocation.service';
import type { IdentityRepository } from '../infrastructure/identity.repository';

describe('consumer authoritative session guard', () => {
  function setup(act = 'user', session: unknown = { userId: 'user-1', supersededAt: new Date(), revokedAt: null }) {
    const repo = { findAuthSessionById: vi.fn().mockResolvedValue(session) };
    const req = { headers: { authorization: 'Bearer access' }, method: 'GET' };
    const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    const guard = new AuthGuard(
      { getAllAndOverride: () => false } as unknown as Reflector,
      { verifyAccessToken: () => ({ sid: 'session-1', sub: 'user-1', act }) } as unknown as TokenService,
      { isRevoked: async () => false } as unknown as SessionRevocationService,
      repo as unknown as IdentityRepository,
    );
    return { guard, context, repo };
  }

  it.each([undefined, { userId: 'other-user' }, { userId: 'user-1', revokedAt: new Date() }])('rejects missing, wrong-owner or revoked sessions despite a negative cache', async (session) => {
    const { guard, context, repo } = setup();
    repo.findAuthSessionById.mockResolvedValue(session);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
  });

  it('accepts superseded access sessions', async () => {
    const { guard, context } = setup();
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('fails closed when the database cannot answer', async () => {
    const { guard, context, repo } = setup();
    repo.findAuthSessionById.mockRejectedValue(new Error('database unavailable'));
    await expect(guard.canActivate(context)).rejects.toThrow('database unavailable');
  });

  it.each(['guest', 'admin'])('leaves %s session behavior unchanged', async (act) => {
    const { guard, context, repo } = setup(act);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(repo.findAuthSessionById).not.toHaveBeenCalled();
  });
});
