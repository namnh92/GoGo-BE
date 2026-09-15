import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../shared/app-error';
import type { RoomEventBus } from '../../realtime/application/room-event-bus';
import type { TokenService } from '../../identity/application/token.service';
import type { IdentityRepository } from '../../identity/infrastructure/identity.repository';
import type { SessionRevocationService } from '../../identity/application/session-revocation.service';
import type { RoomsRepository } from '../infrastructure/rooms.repository';
import type { RoomPolicy } from '../presentation/room-policy';
import { RoomsService } from './rooms.service';

/**
 * GoGo-BE#592 — a join the server refuses must not spend a use of the invite.
 * Shared by `POST /rooms/join` and `POST /rooms/join/guest`.
 */
const ROOM_ID = '311f5bd8-f853-4ced-af68-e04398d1451a';

function serviceWith(opts: {
  roomStatus: string[];
  roomExpiresAt?: Date | null;
  invite?: Partial<{
    revokedAt: Date | null;
    expiresAt: Date;
    useCount: number;
    maxUses: number | null;
  }>;
  consumed?: boolean;
  member?: { id: string; role: 'host' | 'member' };
}) {
  const statuses = [...opts.roomStatus];
  const consumeInvite = vi.fn(async () => opts.consumed ?? true);
  const repo = {
    findInviteByHash: vi.fn(async () => ({
      id: 'invite-1',
      roomId: ROOM_ID,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      useCount: 2,
      maxUses: 20,
      ...opts.invite,
    })),
    consumeInvite,
    findActiveUserMember: vi.fn(async () => opts.member),
    addUserMember: vi.fn(async () => ({ id: 'new-member', role: 'member' })),
  } as unknown as RoomsRepository;
  const policy = {
    getRoom: vi.fn(async () => ({
      id: ROOM_ID,
      status: statuses.shift() ?? statuses.at(-1),
      expiresAt: opts.roomExpiresAt ?? null,
    })),
  } as unknown as RoomPolicy;
  const tokens = { hashOpaqueToken: (code: string) => `hash:${code}` } as unknown as TokenService;
  const events = { publish: vi.fn(async () => undefined) };
  const service = new RoomsService(
    repo,
    policy,
    tokens,
    { findUserById: vi.fn(async () => ({ displayName: 'Lan' })) } as unknown as IdentityRepository,
    {} as SessionRevocationService,
    events as unknown as RoomEventBus,
  );
  return { service, consumeInvite, repo, events };
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return (error as AppError).code;
  }
  throw new Error('expected a rejection');
}

describe('RoomsService.consumeInviteCode (GoGo-BE#592)', () => {
  it('refuses a room that no longer takes members without spending a use', async () => {
    const { service, consumeInvite } = serviceWith({ roomStatus: ['ready'] });
    expect(await codeOf(service.consumeInviteCode('code'))).toBe('ROOM_NOT_JOINABLE');
    expect(consumeInvite).not.toHaveBeenCalled();
  });

  it('refuses an expired room on the guest route without spending a use', async () => {
    const { service, consumeInvite } = serviceWith({
      roomStatus: ['collecting'],
      roomExpiresAt: new Date(Date.now() - 60_000),
    });
    expect(await codeOf(service.consumeInviteCode('code', { enforceRoomExpiry: true }))).toBe(
      'ROOM_EXPIRED',
    );
    expect(consumeInvite).not.toHaveBeenCalled();
  });

  it('passes the expiry rule on to the guarded consume only where it is enforced', async () => {
    const { service, consumeInvite } = serviceWith({ roomStatus: ['collecting'] });
    await service.consumeInviteCode('code', { enforceRoomExpiry: true });
    expect(consumeInvite).toHaveBeenCalledWith('invite-1', {
      joinableStatuses: ['draft', 'collecting'],
      enforceRoomExpiry: true,
    });
  });

  it('refuses a revoked invite without spending a use', async () => {
    const { service, consumeInvite } = serviceWith({
      roomStatus: ['collecting'],
      invite: { revokedAt: new Date() },
    });
    expect(await codeOf(service.consumeInviteCode('code'))).toBe('INVITE_NOT_USABLE');
    expect(consumeInvite).not.toHaveBeenCalled();
  });

  it('spends exactly one use on a join it lets through, guarded by the joinable statuses', async () => {
    const { service, consumeInvite } = serviceWith({ roomStatus: ['collecting'] });
    await expect(service.consumeInviteCode('code')).resolves.toMatchObject({ id: ROOM_ID });
    expect(consumeInvite).toHaveBeenCalledTimes(1);
    expect(consumeInvite).toHaveBeenCalledWith('invite-1', {
      joinableStatuses: ['draft', 'collecting'],
    });
  });

  it('answers ROOM_NOT_JOINABLE when the room moved on between the read and the consume', async () => {
    const { service } = serviceWith({ roomStatus: ['collecting', 'matching'], consumed: false });
    expect(await codeOf(service.consumeInviteCode('code'))).toBe('ROOM_NOT_JOINABLE');
  });

  it('answers INVITE_NOT_USABLE when the last use went to someone else in between', async () => {
    const { service } = serviceWith({ roomStatus: ['collecting', 'collecting'], consumed: false });
    expect(await codeOf(service.consumeInviteCode('code'))).toBe('INVITE_NOT_USABLE');
  });
});

describe('RoomsService.joinAsUser × existing member (GoGo-BE#597)', () => {
  const user = { type: 'user', id: 'user-1', sessionId: 'session-1' } as never;

  it('returns the membership of someone already in a finalised room, spending nothing', async () => {
    const { service, consumeInvite, repo, events } = serviceWith({
      roomStatus: ['ready'],
      member: { id: 'member-1', role: 'member' },
    });
    await expect(service.joinAsUser(user, 'code')).resolves.toEqual({
      roomId: ROOM_ID,
      memberId: 'member-1',
      role: 'member',
    });
    expect(consumeInvite).not.toHaveBeenCalled();
    expect(repo.addUserMember).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('lets a member back in through a revoked invite: the membership grants access', async () => {
    const { service, consumeInvite } = serviceWith({
      roomStatus: ['ready'],
      invite: { revokedAt: new Date() },
      member: { id: 'host-1', role: 'host' },
    });
    await expect(service.joinAsUser(user, 'code')).resolves.toMatchObject({ role: 'host' });
    expect(consumeInvite).not.toHaveBeenCalled();
  });

  it('still refuses someone who is not an active member with ROOM_NOT_JOINABLE', async () => {
    // `findActiveUserMember` returns nothing for a removed member too.
    const { service, consumeInvite, repo } = serviceWith({ roomStatus: ['ready'] });
    expect(await codeOf(service.joinAsUser(user, 'code'))).toBe('ROOM_NOT_JOINABLE');
    expect(repo.findActiveUserMember).toHaveBeenCalledWith(ROOM_ID, 'user-1');
    expect(consumeInvite).not.toHaveBeenCalled();
  });

  it('still refuses a non-member holding a revoked invite with INVITE_NOT_USABLE', async () => {
    const { service } = serviceWith({
      roomStatus: ['collecting'],
      invite: { revokedAt: new Date() },
    });
    expect(await codeOf(service.joinAsUser(user, 'code'))).toBe('INVITE_NOT_USABLE');
  });

  it('joins a new member into a room still collecting, spending one use', async () => {
    const { service, consumeInvite, repo } = serviceWith({ roomStatus: ['collecting'] });
    await expect(service.joinAsUser(user, 'code')).resolves.toEqual({
      roomId: ROOM_ID,
      memberId: 'new-member',
      role: 'member',
    });
    expect(consumeInvite).toHaveBeenCalledTimes(1);
    expect(repo.addUserMember).toHaveBeenCalledTimes(1);
  });

  it('never answers a guest session through this path', async () => {
    const { service, repo } = serviceWith({ roomStatus: ['collecting'] });
    const guest = { type: 'guest', id: 'guest-1', sessionId: 'guest-1', roomId: ROOM_ID } as never;
    expect(await codeOf(service.joinAsUser(guest, 'code'))).toBe('USER_ONLY');
    expect(repo.findActiveUserMember).not.toHaveBeenCalled();
  });
});
