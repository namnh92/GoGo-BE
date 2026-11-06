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
