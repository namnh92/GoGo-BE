import { describe, expect, it } from 'vitest';
import { RoomPolicy } from '../presentation/room-policy';
import { RoomsService } from './rooms.service';

const roomId = '8ff67cc7-8470-4a01-83ed-6bd448a4b50b';
const actor = { type: 'user', id: 'old-host', sessionId: 's' } as const;
describe('host transfer regressions (#879)', () => {
  it('a stale host role cannot override the current host pointer', async () => {
    const room = { id: roomId, hostUserId: 'new-host' };
    const member = { id: 'old-member', userId: 'old-host', guestSessionId: null, role: 'host' };
    const policy = new RoomPolicy({} as never);
    policy.requireMember = async () => ({ room, member }) as never;
    await expect(policy.requireHost(actor, roomId)).rejects.toMatchObject({ code: 'HOST_ONLY' });
  });
  it('an invite issued by the old host previews its original active issuer', async () => {
    const repo = {
      findInviteByHash: async () => ({
        roomId,
        createdByMemberId: 'old-member',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        useCount: 0,
        maxUses: null,
      }),
      getCurrentConstraint: async () => undefined,
      getMemberById: async () => ({
        id: 'old-member',
        roomId,
        userId: 'old-host',
        guestSessionId: null,
        role: 'member',
        displayName: 'Issuer',
        removedAt: null,
      }),
    };
    const policy = {
      getRoom: async () => ({
        id: roomId,
        hostUserId: 'new-host',
        status: 'collecting',
        constraintVersion: 1,
        type: 'group',
        participantCount: 4,
        expiresAt: null,
      }),
    };
    const identity = {
      findUserById: async (id: string) => ({
        id,
        status: 'active',
        avatarKey: null,
        emailVerifiedAt: null,
      }),
    };
    const service = new RoomsService(
      repo as never,
      policy as never,
      { hashOpaqueToken: (v: string) => v } as never,
      identity as never,
      {} as never,
      {} as never,
    );
    await expect(service.previewInvite('old-invite')).resolves.toMatchObject({
      inviter: { displayName: 'Issuer' },
      roomType: 'group',
    });
  });
});
