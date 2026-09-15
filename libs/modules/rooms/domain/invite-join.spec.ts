import { describe, expect, it } from 'vitest';
import { inviteJoinRefusal, type InviteState } from './invite-join';

const NOW = new Date('2026-09-15T00:00:00Z');
const usable: InviteState = {
  revokedAt: null,
  expiresAt: new Date('2026-09-20T00:00:00Z'),
  useCount: 2,
  maxUses: 20,
};

describe('inviteJoinRefusal (GoGo-BE#592)', () => {
  it('lets a usable invite into a room that is still being set up', () => {
    expect(inviteJoinRefusal(usable, 'draft', NOW)).toBeNull();
    expect(inviteJoinRefusal(usable, 'collecting', NOW)).toBeNull();
  });

  it.each(['matching', 'ready', 'active', 'completed', 'cancelled', 'expired'])(
    'refuses a usable invite into a %s room as ROOM_NOT_JOINABLE',
    (status) => {
      expect(inviteJoinRefusal(usable, status, NOW)).toBe('ROOM_NOT_JOINABLE');
    },
  );

  it('refuses a revoked, expired or spent invite as INVITE_NOT_USABLE', () => {
    expect(inviteJoinRefusal({ ...usable, revokedAt: NOW }, 'collecting', NOW)).toBe(
      'INVITE_NOT_USABLE',
    );
    expect(inviteJoinRefusal({ ...usable, expiresAt: NOW }, 'collecting', NOW)).toBe(
      'INVITE_NOT_USABLE',
    );
    expect(inviteJoinRefusal({ ...usable, useCount: 20 }, 'collecting', NOW)).toBe(
      'INVITE_NOT_USABLE',
    );
  });

  it('never treats an invite without a limit as spent', () => {
    expect(
      inviteJoinRefusal({ ...usable, useCount: 10_000, maxUses: null }, 'draft', NOW),
    ).toBeNull();
  });

  it('keeps the answer callers already saw when both are wrong: the invite first', () => {
    expect(inviteJoinRefusal({ ...usable, revokedAt: NOW }, 'ready', NOW)).toBe(
      'INVITE_NOT_USABLE',
    );
  });
});
