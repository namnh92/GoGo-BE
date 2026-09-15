import { describe, expect, it } from 'vitest';
import { inviteJoinRefusal, type InviteState, type RoomState } from './invite-join';

const NOW = new Date('2026-09-15T00:00:00Z');
const PAST = new Date('2026-09-14T00:00:00Z');
const usable: InviteState = {
  revokedAt: null,
  expiresAt: new Date('2026-09-20T00:00:00Z'),
  useCount: 2,
  maxUses: 20,
};
const room = (status: string, expiresAt: Date | null = null): RoomState => ({ status, expiresAt });
const GUEST = { enforceRoomExpiry: true };

describe('inviteJoinRefusal (GoGo-BE#592)', () => {
  it('lets a usable invite into a room that is still being set up', () => {
    expect(inviteJoinRefusal(usable, room('draft'), NOW)).toBeNull();
    expect(inviteJoinRefusal(usable, room('collecting'), NOW)).toBeNull();
  });

  it.each(['matching', 'ready', 'active', 'completed', 'cancelled', 'expired'])(
    'refuses a usable invite into a %s room as ROOM_NOT_JOINABLE',
    (status) => {
      expect(inviteJoinRefusal(usable, room(status), NOW)).toBe('ROOM_NOT_JOINABLE');
    },
  );

  it('refuses a revoked, expired or spent invite as INVITE_NOT_USABLE', () => {
    const collecting = room('collecting');
    expect(inviteJoinRefusal({ ...usable, revokedAt: NOW }, collecting, NOW)).toBe(
      'INVITE_NOT_USABLE',
    );
    expect(inviteJoinRefusal({ ...usable, expiresAt: NOW }, collecting, NOW)).toBe(
      'INVITE_NOT_USABLE',
    );
    expect(inviteJoinRefusal({ ...usable, useCount: 20 }, collecting, NOW)).toBe(
      'INVITE_NOT_USABLE',
    );
  });

  it('never treats an invite without a limit as spent', () => {
    expect(
      inviteJoinRefusal({ ...usable, useCount: 10_000, maxUses: null }, room('draft'), NOW),
    ).toBeNull();
  });

  it('keeps the answer callers already saw when both are wrong: the invite first', () => {
    expect(inviteJoinRefusal({ ...usable, revokedAt: NOW }, room('ready'), NOW)).toBe(
      'INVITE_NOT_USABLE',
    );
  });
});

describe('inviteJoinRefusal × room expiry (GoGo-BE#592 review)', () => {
  it('refuses a room past its expiry as ROOM_EXPIRED where the path enforces it', () => {
    expect(inviteJoinRefusal(usable, room('collecting', PAST), NOW, GUEST)).toBe('ROOM_EXPIRED');
    expect(inviteJoinRefusal(usable, room('collecting', NOW), NOW, GUEST)).toBe('ROOM_EXPIRED');
  });

  it('orders INVITE_NOT_USABLE, then ROOM_NOT_JOINABLE, then ROOM_EXPIRED', () => {
    expect(inviteJoinRefusal({ ...usable, revokedAt: NOW }, room('ready', PAST), NOW, GUEST)).toBe(
      'INVITE_NOT_USABLE',
    );
    expect(inviteJoinRefusal(usable, room('ready', PAST), NOW, GUEST)).toBe('ROOM_NOT_JOINABLE');
  });

  it('adds no expiry rule to a path that does not enforce it', () => {
    expect(inviteJoinRefusal(usable, room('collecting', PAST), NOW)).toBeNull();
  });

  it('never expires a room without an expiry', () => {
    expect(inviteJoinRefusal(usable, room('collecting', null), NOW, GUEST)).toBeNull();
  });
});
