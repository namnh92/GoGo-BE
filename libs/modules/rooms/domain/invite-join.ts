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

export type RoomState = { status: string; expiresAt: Date | null };

export type JoinRefusal = 'INVITE_NOT_USABLE' | 'ROOM_NOT_JOINABLE' | 'ROOM_EXPIRED';

/**
 * Which refusals a join path applies beyond the invite and the room status.
 *
 * `enforceRoomExpiry` refuses a room past its expiry before a use is spent.
 * Both join routes set it: the guest route (a guest session is refused for an
 * expired room in `AuthService.createGuestSession`) and, since GoGo-BE#606,
 * `POST /rooms/join` for a signed-in user who is not already a member. It stays
 * a rule rather than a default so a caller that only consumes an invite has to
 * say which expiry it means.
 */
export type JoinRules = { enforceRoomExpiry?: boolean };

/**
 * GoGo-BE#592 — why a join through this invite would be refused, decided
 * before a use is spent. Consuming first and checking the room afterwards
 * charged every refused join against `maxUses`, so a small invite could be
 * exhausted by attempts that never let anyone in.
 *
 * The order of the answers is the one callers already saw: an invite that is
 * revoked, expired or spent says so first; then a room that no longer takes
 * members; then, where the path enforces it, a room past its expiry.
 */
export function inviteJoinRefusal(
  invite: InviteState,
  room: RoomState,
  now: Date,
  rules: JoinRules = {},
): JoinRefusal | null {
  const spent = invite.maxUses !== null && invite.useCount >= invite.maxUses;
  if (invite.revokedAt !== null || invite.expiresAt.getTime() <= now.getTime() || spent) {
    return 'INVITE_NOT_USABLE';
  }
  if (!isJoinable(room.status)) return 'ROOM_NOT_JOINABLE';
  if (
    rules.enforceRoomExpiry &&
    room.expiresAt !== null &&
    room.expiresAt.getTime() <= now.getTime()
  ) {
    return 'ROOM_EXPIRED';
  }
  return null;
}
