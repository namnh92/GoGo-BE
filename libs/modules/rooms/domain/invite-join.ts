import type { RoomStatus } from './room-state';

/** A room takes new members only while it is being set up (FR-ROOM-006). */
export const JOINABLE_ROOM_STATUSES: readonly RoomStatus[] = ['draft', 'collecting'];

export function isJoinable(status: string): boolean {
  return (JOINABLE_ROOM_STATUSES as readonly string[]).includes(status);
}

export type InviteState = {
  revokedAt: Date | null;
  expiresAt: Date;
  useCount: number;
  maxUses: number | null;
};

export type JoinRefusal = 'INVITE_NOT_USABLE' | 'ROOM_NOT_JOINABLE';

/**
 * GoGo-BE#592 — why a join through this invite would be refused, decided
 * before a use is spent. Consuming first and checking the room afterwards
 * charged every refused join against `maxUses`, so a small invite could be
 * exhausted by attempts that never let anyone in.
 *
 * The order of the two answers is the one callers already saw: an invite that
 * is revoked, expired or spent says so even when the room has also moved on.
 */
export function inviteJoinRefusal(
  invite: InviteState,
  roomStatus: string,
  now: Date,
): JoinRefusal | null {
  const spent = invite.maxUses !== null && invite.useCount >= invite.maxUses;
  if (invite.revokedAt !== null || invite.expiresAt.getTime() <= now.getTime() || spent) {
    return 'INVITE_NOT_USABLE';
  }
  if (!isJoinable(roomStatus)) return 'ROOM_NOT_JOINABLE';
  return null;
}
