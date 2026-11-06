import { describe, expect, it, vi } from 'vitest';
import type { IdentityRepository } from '../infrastructure/identity.repository';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import type { SessionRevocationService } from './session-revocation.service';
import type { TokenService } from './token.service';
import type { RoomEventBus } from '../../realtime/application/room-event-bus';

describe('AuthService legacy password login', () => {
  it('authenticates an existing account whose password fails the registration policy', async () => {
    const passwords = new PasswordService();
    const passwordHash = await passwords.hash('old');
    const repo = {
      withAuthTransaction: vi.fn(async (_email, _id, work) => work(repo, { id: 'user-1', status: 'active', passwordHash })),
      countRecentFailures: vi.fn().mockResolvedValue(0),
      findUserByEmail: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active', passwordHash }),
      recordLoginAttempt: vi.fn().mockResolvedValue(undefined),
      createAuthSession: vi.fn().mockResolvedValue({ id: 'session-1' }),
    };
    const tokens = {
      generateOpaqueToken: () => 'refresh-token',
      hashOpaqueToken: () => 'refresh-hash',
      issueAccessToken: () => 'access-token',
      accessTtlSeconds: 900,
    };
    const auth = new AuthService(
      repo as unknown as IdentityRepository,
      passwords,
      tokens as unknown as TokenService,
      {} as SessionRevocationService,
      { refreshTtlSeconds: 3600, guestTtlSeconds: 3600, lockoutThreshold: 5, lockoutWindowSeconds: 60 },
      {} as RoomEventBus,
    );

    await expect(auth.login({ email: 'old@gogo.id.vn', password: 'old' })).resolves.toMatchObject({
      userId: 'user-1',
      tokens: { accessToken: 'access-token' },
    });
    expect(repo.recordLoginAttempt).toHaveBeenCalledWith(expect.objectContaining({ succeeded: true }));
  });
});

describe('authentication serialization against recovery', () => {
  function setup(valid = true) {
    const order: string[] = [];
    const session = { id: 'old-session', userId: 'user-1', familyId: 'family', expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
    const scoped = {
      countRecentFailures: vi.fn(async () => 0),
      recordLoginAttempt: vi.fn(async () => { order.push('attempt'); }),
      createAuthSession: vi.fn(async () => ({ id: 'new-session' })),
      findAuthSessionByTokenHash: vi.fn(async () => ({ ...session, revokedAt: new Date() })),
      markSessionSuperseded: vi.fn(),
    };
    const repo = {
      findAuthSessionByTokenHash: vi.fn(async () => session),
      withAuthTransaction: vi.fn(async (_email, _id, work) => {
        order.push('locked');
        const result = await work(scoped, { id: 'user-1', status: 'active', passwordHash: 'current-hash' });
        order.push('committed');
        return result;
      }),
    };
    const passwords = { verifyOrBurn: vi.fn(async (hash) => { order.push(`verify:${hash}`); return valid; }) };
    const auth = new AuthService(repo as unknown as IdentityRepository, passwords as unknown as PasswordService,
      { hashOpaqueToken: () => 'hash', generateOpaqueToken: () => 'refresh', issueAccessToken: () => 'access', accessTtlSeconds: 900 } as unknown as TokenService,
      { revokeMany: vi.fn(async () => undefined) } as unknown as SessionRevocationService,
      { refreshTtlSeconds: 3600, guestTtlSeconds: 3600, lockoutThreshold: 5, lockoutWindowSeconds: 60 }, {} as RoomEventBus);
    return { auth, repo, scoped, order };
  }

  it('verifies current locked password and records failed attempts before commit, then rejects', async () => {
    const { auth, order, scoped } = setup(false);
    await expect(auth.login({ email: 'person@example.com', password: 'old' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(order).toEqual(['locked', 'verify:current-hash', 'attempt', 'committed']);
    expect(scoped.createAuthSession).not.toHaveBeenCalled();
  });

  it('rejects refresh revoked during the gap before the user lock, without issuing a successor', async () => {
    const { auth, repo, scoped, order } = setup();
    await expect(auth.refresh('refresh')).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect(repo.withAuthTransaction).toHaveBeenCalledWith(null, 'user-1', expect.any(Function));
    expect(scoped.findAuthSessionByTokenHash).toHaveBeenCalledOnce();
    expect(scoped.createAuthSession).not.toHaveBeenCalled();
    expect(order).toEqual(['locked', 'committed']);
  });
});
