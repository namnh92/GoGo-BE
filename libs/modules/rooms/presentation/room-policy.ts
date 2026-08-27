import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';

export type Membership = typeof schema.roomMembers.$inferSelect;
export type RoomRow = typeof schema.rooms.$inferSelect;

/**
 * Policy layer (core rule #5): authorization = actor + membership + role +
 * resource state, resolved server-side on every call. UI hiding is never
 * enforcement; these checks are.
 */
@Injectable()
export class RoomPolicy {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getRoom(roomId: string): Promise<RoomRow> {
    const [room] = await this.db
      .select()
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .limit(1);
    if (!room) throw AppError.notFound('ROOM_NOT_FOUND', 'Room not found');
    return room;
  }

  /**
   * Requires active membership. Guests additionally must present a token
   * scoped to this exact room — a guest token can never cross rooms even if
   * a membership row somehow existed.
   */
  async requireMember(
    actor: Actor,
    roomId: string,
  ): Promise<{ room: RoomRow; member: Membership }> {
    if (actor.type === 'guest' && actor.roomId !== roomId) {
      throw AppError.forbidden('ROOM_SCOPE_VIOLATION', 'Guest session is bound to another room');
    }
    const room = await this.getRoom(roomId);
    const identity =
      actor.type === 'user'
        ? eq(schema.roomMembers.userId, actor.id)
        : eq(schema.roomMembers.guestSessionId, actor.id);
    const [member] = await this.db
      .select()
      .from(schema.roomMembers)
      .where(
        and(eq(schema.roomMembers.roomId, roomId), identity, isNull(schema.roomMembers.removedAt)),
      )
      .limit(1);
    if (!member) throw AppError.forbidden('NOT_A_MEMBER', 'You are not a member of this room');
    return { room, member };
  }

  /** Host-only actions (FR-ROOM-007/008). */
  async requireHost(actor: Actor, roomId: string): Promise<{ room: RoomRow; member: Membership }> {
    const ctx = await this.requireMember(actor, roomId);
    if (ctx.member.role !== 'host') {
      throw AppError.forbidden('HOST_ONLY', 'Only the host can perform this action');
    }
    return ctx;
  }
}
