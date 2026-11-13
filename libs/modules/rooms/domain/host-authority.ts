import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import type { Tx } from '../../shared/outbox';

export type HostAuthority = { kind: 'host'; actor: Actor; memberId: string; hostVersion: number };
export type RoomWriteAuthority = HostAuthority | { kind: 'internal'; reason: 'automatic_match' };
export function hostAuthority(
  actor: Actor,
  room: { hostVersion: number },
  member: { id: string },
): HostAuthority {
  return { kind: 'host', actor, memberId: member.id, hostVersion: room.hostVersion };
}

/** Caller holds the room FOR UPDATE through commit. Never authorize from a pre-lock read. */
export async function requireHostWithin(
  tx: Tx,
  room: typeof schema.rooms.$inferSelect,
  authority: HostAuthority,
) {
  const { actor } = authority;
  if (actor.type === 'guest' && actor.roomId !== room.id)
    throw AppError.forbidden('ROOM_SCOPE_VIOLATION', 'Guest session is bound to another room');
  const [member] = await tx
    .select()
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.roomId, room.id),
        actor.type === 'user'
          ? eq(schema.roomMembers.userId, actor.id)
          : eq(schema.roomMembers.guestSessionId, actor.id),
        isNull(schema.roomMembers.removedAt),
      ),
    );
  if (!member) throw AppError.forbidden('NOT_A_MEMBER', 'You are not a member of this room');
  if (
    actor.type !== 'user' ||
    member.id !== authority.memberId ||
    member.role !== 'host' ||
    member.userId !== room.hostUserId ||
    member.guestSessionId !== null
  )
    throw AppError.forbidden('HOST_ONLY', 'Only the current host can perform this action');
  if (room.hostVersion !== authority.hostVersion)
    throw AppError.conflict('HOST_VERSION_CONFLICT', 'Host changed since this operation began');
  return member;
}

export async function lockHostRoom(tx: Tx, roomId: string, authority: HostAuthority) {
  const [room] = await tx
    .select()
    .from(schema.rooms)
    .where(eq(schema.rooms.id, roomId))
    .for('update');
  if (!room) throw AppError.notFound('ROOM_NOT_FOUND', 'Room not found');
  await requireHostWithin(tx, room, authority);
  return room;
}
