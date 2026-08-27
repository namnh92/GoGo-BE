import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { pgArray } from '../../search/infrastructure/search.repository';
import { DB } from '../../shared/tokens';
import { writeOutbox, type DomainEventInput } from '../../shared/outbox';

export type RoomRow = typeof schema.rooms.$inferSelect;
export type ConstraintRow = typeof schema.roomConstraints.$inferSelect;
export type MemberRow = typeof schema.roomMembers.$inferSelect;
export type InviteRow = typeof schema.roomInvites.$inferSelect;
export type PreferenceRow = typeof schema.preferenceSelections.$inferSelect;

export type NewConstraint = {
  originText?: string | null;
  originLat?: number | null;
  originLng?: number | null;
  areaKey?: string | null;
  radiusM?: number | null;
  startAt?: Date | null;
  endAt?: Date | null;
  budgetMode: 'total' | 'per_person';
  budgetAmount: number;
  currency: string;
  dietaryKeys: string[];
  accessibilityKeys: string[];
};

export type RoomListRow = {
  id: string;
  type: string;
  status: string;
  decision_mode: string;
  participant_count: number;
  title: string | null;
  scheduled_date: Date | string | null;
  updated_at: Date | string;
  code: string;
  my_member_id: string;
  my_role: string;
  member_count: number;
  completed_count: number;
  plan_id: string | null;
};

@Injectable()
export class RoomsRepository {
  constructor(@Inject(DB) readonly db: Db) {}

  /**
   * #152 — rooms the actor belongs to, newest activity first.
   *
   * A room used to be reachable only by id, so closing the app mid-flow lost it
   * for good; Mobile shipped a local store purely to remember them. Keyset
   * paging on `(updated_at, id)` because a room's timestamp moves while the
   * list is being read — a vote or a plan is enough.
   */
  async listRoomsForActor(input: {
    actorType: 'user' | 'guest';
    actorId: string;
    statuses?: string[] | undefined;
    limit: number;
    cursor?: { updatedAt: string; id: string } | undefined;
  }) {
    const membership =
      input.actorType === 'user'
        ? sql`rm.user_id = ${input.actorId}`
        : sql`rm.guest_session_id = ${input.actorId}`;

    const conditions = [sql`rm.removed_at is null`, membership];
    if (input.statuses?.length) {
      // `status` is an enum; comparing it to a text[] needs the cast, or
      // Postgres refuses the operator outright.
      conditions.push(sql`r.status::text = any(${pgArray(input.statuses)}::text[])`);
    }
    if (input.cursor) {
      conditions.push(
        sql`(r.updated_at, r.id) < (${input.cursor.updatedAt}::timestamptz, ${input.cursor.id}::uuid)`,
      );
    }

    const rows = await this.db.execute(sql`
      select r.id, r.type, r.status, r.decision_mode, r.participant_count,
             r.title, r.scheduled_date, r.updated_at, r.code,
             rm.id as my_member_id, rm.role as my_role,
             (select count(*)::int from room_members m
               where m.room_id = r.id and m.removed_at is null) as member_count,
             (select count(*)::int from room_members m
               where m.room_id = r.id and m.removed_at is null
                 and m.selection_status = 'completed') as completed_count,
             (select p.id from plans p
               where p.room_id = r.id and p.status = 'current' limit 1) as plan_id
      from rooms r
      join room_members rm on rm.room_id = r.id
      where ${sql.join(conditions, sql` and `)}
      order by r.updated_at desc, r.id desc
      limit ${input.limit + 1}
    `);
    return rows.rows as RoomListRow[];
  }

  async createRoom(input: {
    code: string;
    type: 'couple' | 'group';
    decisionMode: 'match' | 'vote' | 'host';
    hostUserId: string;
    hostDisplayName: string;
    participantCount: number;
    title?: string;
    scheduledDate?: Date;
    expiresAt?: Date;
    constraint: NewConstraint;
    seedPlaceIds: string[];
    event: DomainEventInput | null;
  }): Promise<{ room: RoomRow; member: MemberRow }> {
    return this.db.transaction(async (tx) => {
      const [room] = await tx
        .insert(schema.rooms)
        .values({
          code: input.code,
          type: input.type,
          decisionMode: input.decisionMode,
          hostUserId: input.hostUserId,
          participantCount: input.participantCount,
          title: input.title,
          scheduledDate: input.scheduledDate,
          expiresAt: input.expiresAt,
          // A room exists to be joined, so it starts open to joining. Creating
          // it in `draft` gave clients a state nothing moved them out of: the
          // server would report the room ready for matching and then refuse to
          // match it, and every client had to walk the state machine itself.
          status: 'collecting',
        })
        .returning();
      const [member] = await tx
        .insert(schema.roomMembers)
        .values({
          roomId: room!.id,
          userId: input.hostUserId,
          role: 'host',
          displayName: input.hostDisplayName,
        })
        .returning();
      await tx.insert(schema.roomConstraints).values({
        roomId: room!.id,
        version: 1,
        ...input.constraint,
        createdByMemberId: member!.id,
      });
      if (input.seedPlaceIds.length > 0) {
        await tx.insert(schema.roomSeedPlaces).values(
          input.seedPlaceIds.map((placeId, i) => ({
            roomId: room!.id,
            placeId,
            position: i,
            createdByMemberId: member!.id,
          })),
        );
      }
      if (input.event) {
        await writeOutbox(tx, { ...input.event, resourceId: room!.id });
      }
      return { room: room!, member: member! };
    });
  }

  getCurrentConstraint(roomId: string, version: number): Promise<ConstraintRow | undefined> {
    return this.db
      .select()
      .from(schema.roomConstraints)
      .where(
        and(eq(schema.roomConstraints.roomId, roomId), eq(schema.roomConstraints.version, version)),
      )
      .limit(1)
      .then((r) => r[0]);
  }

  /**
   * Constraint edit (FR-ROOM-005 + core rule #6): new version row, bump
   * rooms.constraint_version, and mark every dependent score/plan stale —
   * one transaction, no partial states.
   */
  async applyConstraintVersion(input: {
    roomId: string;
    expectedVersion: number;
    constraint: NewConstraint;
    memberId: string;
    participantCount?: number;
    event: DomainEventInput;
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.rooms)
        .set({
          constraintVersion: sql`${schema.rooms.constraintVersion} + 1`,
          ...(input.participantCount ? { participantCount: input.participantCount } : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.rooms.id, input.roomId),
            eq(schema.rooms.constraintVersion, input.expectedVersion),
          ),
        )
        .returning({ version: schema.rooms.constraintVersion });
      if (updated.length === 0) return -1; // optimistic concurrency conflict
      const version = updated[0]!.version;
      await tx.insert(schema.roomConstraints).values({
        roomId: input.roomId,
        version,
        ...input.constraint,
        createdByMemberId: input.memberId,
      });
      await tx
        .update(schema.candidateScores)
        .set({ isStale: true })
        .where(eq(schema.candidateScores.roomId, input.roomId));
      await tx
        .update(schema.plans)
        .set({ isStale: true, updatedAt: sql`now()` })
        .where(eq(schema.plans.roomId, input.roomId));
      await writeOutbox(tx, input.event);
      return version;
    });
  }

  async updateStatus(roomId: string, status: RoomRow['status'], event: DomainEventInput) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.rooms)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(schema.rooms.id, roomId));
      await writeOutbox(tx, event);
    });
  }

  listMembers(roomId: string): Promise<MemberRow[]> {
    return this.db
      .select()
      .from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), isNull(schema.roomMembers.removedAt)))
      .orderBy(asc(schema.roomMembers.joinedAt));
  }

  getMemberById(memberId: string): Promise<MemberRow | undefined> {
    return this.db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.id, memberId))
      .limit(1)
      .then((r) => r[0]);
  }

  async removeMember(input: {
    memberId: string;
    removedByMemberId: string;
    event: DomainEventInput;
  }): Promise<{ guestSessionId: string | null }> {
    return this.db.transaction(async (tx) => {
      const [member] = await tx
        .update(schema.roomMembers)
        .set({ removedAt: sql`now()`, removedByMemberId: input.removedByMemberId })
        .where(eq(schema.roomMembers.id, input.memberId))
        .returning();
      if (member?.guestSessionId) {
        await tx
          .update(schema.guestSessions)
          .set({ revokedAt: sql`now()` })
          .where(eq(schema.guestSessions.id, member.guestSessionId));
      }
      await writeOutbox(tx, input.event);
      return { guestSessionId: member?.guestSessionId ?? null };
    });
  }

  async addUserMember(input: {
    roomId: string;
    userId: string;
    displayName: string;
    event: DomainEventInput;
  }): Promise<MemberRow> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.roomId, input.roomId),
            eq(schema.roomMembers.userId, input.userId),
            isNull(schema.roomMembers.removedAt),
          ),
        )
        .limit(1);
      if (existing) return existing; // idempotent re-join
      const [member] = await tx
        .insert(schema.roomMembers)
        .values({
          roomId: input.roomId,
          userId: input.userId,
          role: 'member',
          displayName: input.displayName,
        })
        .returning();
      await writeOutbox(tx, input.event);
      return member!;
    });
  }

  // --- invites (FR-ROOM-006/009) -------------------------------------------

  async createInvite(input: {
    roomId: string;
    codeHash: string;
    createdByMemberId: string;
    expiresAt: Date;
    maxUses?: number;
  }): Promise<InviteRow> {
    const [row] = await this.db.insert(schema.roomInvites).values(input).returning();
    return row!;
  }

  findInviteByHash(codeHash: string): Promise<InviteRow | undefined> {
    return this.db
      .select()
      .from(schema.roomInvites)
      .where(eq(schema.roomInvites.codeHash, codeHash))
      .limit(1)
      .then((r) => r[0]);
  }

  listInvites(roomId: string): Promise<InviteRow[]> {
    return this.db
      .select()
      .from(schema.roomInvites)
      .where(eq(schema.roomInvites.roomId, roomId))
      .orderBy(asc(schema.roomInvites.createdAt));
  }

  async revokeInvite(inviteId: string): Promise<void> {
    await this.db
      .update(schema.roomInvites)
      .set({ revokedAt: sql`now()` })
      .where(eq(schema.roomInvites.id, inviteId));
  }

  /** Atomic use-count increment guarded by max_uses. Returns false when spent. */
  async consumeInvite(inviteId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.roomInvites)
      .set({ useCount: sql`${schema.roomInvites.useCount} + 1` })
      .where(
        and(
          eq(schema.roomInvites.id, inviteId),
          isNull(schema.roomInvites.revokedAt),
          sql`${schema.roomInvites.expiresAt} > now()`,
          sql`(${schema.roomInvites.maxUses} is null or ${schema.roomInvites.useCount} < ${schema.roomInvites.maxUses})`,
        ),
      )
      .returning({ id: schema.roomInvites.id });
    return rows.length > 0;
  }

  // --- seed places (FR-ROOM-010/011) ---------------------------------------

  async listPublishedPlaces(placeIds: string[]): Promise<string[]> {
    if (placeIds.length === 0) return [];
    const rows = await this.db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(and(inArray(schema.places.id, placeIds), eq(schema.places.status, 'published')));
    return rows.map((r) => r.id);
  }

  listSeedPlaces(roomId: string) {
    return this.db
      .select({
        placeId: schema.roomSeedPlaces.placeId,
        position: schema.roomSeedPlaces.position,
        name: schema.places.name,
      })
      .from(schema.roomSeedPlaces)
      .innerJoin(schema.places, eq(schema.places.id, schema.roomSeedPlaces.placeId))
      .where(eq(schema.roomSeedPlaces.roomId, roomId))
      .orderBy(asc(schema.roomSeedPlaces.position));
  }

  async addSeedPlaces(roomId: string, placeIds: string[], memberId: string): Promise<void> {
    const existing = await this.db
      .select({ n: sql<number>`coalesce(max(${schema.roomSeedPlaces.position}), -1)` })
      .from(schema.roomSeedPlaces)
      .where(eq(schema.roomSeedPlaces.roomId, roomId));
    const base = (existing[0]?.n ?? -1) + 1;
    await this.db
      .insert(schema.roomSeedPlaces)
      .values(
        placeIds.map((placeId, i) => ({
          roomId,
          placeId,
          position: base + i,
          createdByMemberId: memberId,
        })),
      )
      .onConflictDoNothing();
  }

  async removeSeedPlace(roomId: string, placeId: string): Promise<void> {
    await this.db
      .delete(schema.roomSeedPlaces)
      .where(
        and(eq(schema.roomSeedPlaces.roomId, roomId), eq(schema.roomSeedPlaces.placeId, placeId)),
      );
  }
}
