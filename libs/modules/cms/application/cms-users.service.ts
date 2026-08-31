import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { SessionRevocationService } from '../../identity/application/session-revocation.service';
import { UserContentService } from '../../reviews/application/user-content.service';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';

export type AppUserStatus = (typeof schema.users.$inferSelect)['status'];

/** Statuses an operator can move an account to. `deleted` has its own route. */
export const MODERATION_STATUSES = ['active', 'suspended', 'banned'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

export type AppUserListQuery = {
  q?: string | undefined;
  status?: AppUserStatus | undefined;
  limit: number;
  cursor?: string | undefined;
};

export type AppUserCounters = {
  roomsCreated: number;
  roomsJoined: number;
  reviews: number;
  savedPlaces: number;
};

export type AppUser = {
  id: string;
  displayName: string;
  email: string | null;
  status: AppUserStatus;
  /**
   * How this account signs in. One value today, because email + password is
   * the only method that exists; it is reported rather than assumed so the
   * console does not have to guess when a second one lands.
   */
  authMethod: 'password' | 'none';
  locale: string;
  createdAt: string;
  lastActiveAt: string | null;
  counters: AppUserCounters;
  reportCount: number;
};

type UserRow = {
  id: string;
  display_name: string;
  email: string | null;
  status: AppUserStatus;
  has_password: boolean;
  locale: string;
  created_at: Date | string;
  last_active_at: Date | string | null;
  rooms_created: number;
  rooms_joined: number;
  reviews: number;
  saved_places: number;
  report_count: number;
};

/**
 * BE-CMS-G7 (#246) — the app-user surface for the console.
 *
 * Two rules shape every query here, and both are subtractive:
 *
 * **Minimum PII.** No coordinates, no device tokens, no raw preference
 * selections. Support work needs to know who someone is and what they have
 * done, not where they were. A field that is not returned cannot leak from a
 * console session, a screenshot, or a browser cache.
 *
 * **No invite codes.** `rooms.code` is a bearer secret — anyone holding it can
 * join — so it never appears in an operations list, however convenient it
 * would be for reproducing a report.
 */
@Injectable()
export class CmsUsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly revocations: SessionRevocationService,
    private readonly userContent: UserContentService,
  ) {}

  /**
   * Counters are scalar subqueries rather than a join-and-group: the row is
   * the unit of meaning here and grouping would fan it out four ways. Capped
   * at 100 rows by the controller — each row costs four indexed lookups, so
   * the page size is what keeps this from being a table scan wearing a filter.
   */
  async list(query: AppUserListQuery): Promise<{
    items: AppUser[];
    nextCursor: string | null;
    totalCount: number;
  }> {
    const where: SQL[] = [];
    if (query.status) where.push(sql`u.status = ${query.status}`);
    if (query.q) {
      const needle = `%${query.q.trim().toLowerCase()}%`;
      where.push(sql`(lower(u.display_name) like ${needle} or lower(u.email) like ${needle})`);
    }

    const countWhere = where.length ? sql.join(where, sql` and `) : sql`true`;
    const pageWhere = [...where];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageWhere.push(sql`(u.created_at, u.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        select u.id, u.display_name, u.email, u.status, u.locale, u.created_at,
               (u.password_hash is not null) as has_password,
               (select max(s.last_used_at) from auth_sessions s where s.user_id = u.id)
                 as last_active_at,
               (select count(*) from rooms r where r.host_user_id = u.id)::int as rooms_created,
               (select count(*) from room_members m where m.user_id = u.id)::int as rooms_joined,
               (select count(*) from reviews rv where rv.user_id = u.id)::int as reviews,
               (select count(*) from saved_items si
                 where si.user_id = u.id and si.target_type = 'place')::int as saved_places,
               (select count(*) from reports rp
                 where rp.target_type = 'member' and rp.target_id = u.id)::int as report_count
        from users u
        where ${pageWhere.length ? sql.join(pageWhere, sql` and `) : sql`true`}
        order by u.created_at desc, u.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(sql`select count(*)::int as n from users u where ${countWhere}`),
    ]);

    const rows = page.rows as UserRow[];
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toAppUser),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }

  /**
   * Detail, plus the rooms this person has been in.
   *
   * `statusReason` comes from the audit log rather than a column on `users`.
   * The reason for a suspension is already written there, with who did it and
   * when; a second copy on the row would be one that drifts, and the audit
   * entry is the one an incident review would trust anyway.
   */
  async detail(id: string) {
    const result = await this.db.execute(sql`
      select u.id, u.display_name, u.email, u.status, u.locale, u.created_at,
             (u.password_hash is not null) as has_password,
             (select max(s.last_used_at) from auth_sessions s where s.user_id = u.id)
               as last_active_at,
             (select count(*) from rooms r where r.host_user_id = u.id)::int as rooms_created,
             (select count(*) from room_members m where m.user_id = u.id)::int as rooms_joined,
             (select count(*) from reviews rv where rv.user_id = u.id)::int as reviews,
             (select count(*) from saved_items si
               where si.user_id = u.id and si.target_type = 'place')::int as saved_places,
             (select count(*) from reports rp
               where rp.target_type = 'member' and rp.target_id = u.id)::int as report_count
      from users u where u.id = ${id}
    `);
    const row = result.rows[0] as UserRow | undefined;
    if (!row) throw AppError.notFound('USER_NOT_FOUND', 'No such account');

    const [recentRooms, statusEntry] = await Promise.all([
      this.db.execute(sql`
        select r.id, r.type, r.status, r.decision_mode, r.participant_count,
               r.title, r.created_at, m.role, m.joined_at
        from room_members m
        join rooms r on r.id = m.room_id
        where m.user_id = ${id}
        order by m.joined_at desc
        limit 20
      `),
      this.db.execute(sql`
        select action, diff, created_at from audit_logs
        where resource_type = 'user' and resource_id = ${id}
          and action in ('user.suspended', 'user.banned', 'user.reactivated')
        order by created_at desc limit 1
      `),
    ]);

    const status = statusEntry.rows[0] as
      { action: string; diff: { reason?: string } | null; created_at: Date | string } | undefined;

    // #255 — so the console can warn before a direct delete: "this user has
    // an open privacy request". A direct delete does not close the request
    // (same user is not same request); the operator has to go through it.
    const openRequests = await this.db.execute(sql`
      select count(*)::int as n from privacy_requests
      where user_id = ${id} and status <> 'closed'
    `);

    return {
      ...toAppUser(row),
      openPrivacyRequestCount: (openRequests.rows[0] as { n: number }).n,
      ...(status?.diff?.reason
        ? {
            statusReason: status.diff.reason,
            statusChangedAt: toIso(status.created_at),
          }
        : {}),
      rooms: (
        recentRooms.rows as {
          id: string;
          type: string;
          status: string;
          decision_mode: string;
          participant_count: number;
          title: string | null;
          created_at: Date | string;
          role: string;
          joined_at: Date | string;
        }[]
      ).map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        decisionMode: r.decision_mode,
        participantCount: r.participant_count,
        ...(r.title ? { title: r.title } : {}),
        role: r.role,
        joinedAt: toIso(r.joined_at),
        createdAt: toIso(r.created_at),
      })),
    };
  }

  /**
   * Suspend, ban, or reactivate.
   *
   * Suspending revokes every session. `AuthGuard` does not re-read the user
   * row — it trusts the access token until the session is revoked — so
   * flipping the status alone would leave the account working for up to the
   * token lifetime. On the console that gap is exactly the wrong length: long
   * enough to matter during an incident, short enough that nobody notices it
   * in testing.
   */
  async setStatus(input: {
    id: string;
    status: ModerationStatus;
    reason: string;
    actorId: string;
  }) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, input.id))
        .limit(1);
      if (!user) throw AppError.notFound('USER_NOT_FOUND', 'No such account');
      // A deleted account is anonymized and its address freed for
      // re-registration. Reviving it would attach a stranger's history to
      // whoever now holds that address.
      if (user.status === 'deleted') {
        throw AppError.conflict('USER_DELETED', 'A deleted account cannot change status');
      }

      await tx
        .update(schema.users)
        .set({ status: input.status, updatedAt: sql`now()` })
        .where(eq(schema.users.id, input.id));

      if (input.status !== 'active') {
        await this.revokeSessions(tx, input.id, `user_${input.status}`);
      }

      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.actorId,
        action:
          input.status === 'active'
            ? 'user.reactivated'
            : input.status === 'banned'
              ? 'user.banned'
              : 'user.suspended',
        resourceType: 'user',
        resourceId: input.id,
        diff: { reason: input.reason, before: user.status, after: input.status },
      });
      return { id: input.id, status: input.status };
    });
  }

  /**
   * Delete on the account holder's behalf, through the consumer flow.
   *
   * Reusing `UserContentService.deleteAccount` rather than writing a second
   * one: two implementations of "erase this person" drift, and the one that
   * drifts is the one that leaves a table behind. The only difference is who
   * asked, which is what the audit entry records.
   */
  async deleteAccount(input: { id: string; reason: string; actorId: string }) {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.id))
      .limit(1);
    if (!user) throw AppError.notFound('USER_NOT_FOUND', 'No such account');
    if (user.status === 'deleted') return { deleted: true };

    return this.userContent.deleteForUser(input.id, {
      actorType: 'admin',
      actorId: input.actorId,
      reason: input.reason,
    });
  }

  /**
   * The same export the account holder gets from `/me/export`, produced for a
   * subject-access request they made through support instead of the app.
   *
   * The audit entry is the point: a staff member reading somebody's data is an
   * event, and one that must be attributable even though the payload is
   * identical to the self-service one.
   */
  async exportData(input: { id: string; reason: string; actorId: string }) {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.id))
      .limit(1);
    if (!user) throw AppError.notFound('USER_NOT_FOUND', 'No such account');

    return this.userContent.exportForUser(input.id, {
      actorType: 'admin',
      actorId: input.actorId,
      reason: input.reason,
    });
  }

  /**
   * Rooms, read-only.
   *
   * `code` is never selected. It is a bearer secret — whoever holds it can
   * join — and an operations list is exactly the kind of place a value like
   * that gets copied out of.
   */
  async listRooms(query: {
    status?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const where: SQL[] = [];
    if (query.status) where.push(sql`r.status = ${query.status}::room_status`);
    const pageWhere = [...where];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageWhere.push(sql`(r.created_at, r.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        select r.id, r.type, r.status, r.decision_mode, r.participant_count, r.title,
               r.host_user_id, r.scheduled_date, r.created_at,
               (select count(*) from room_members m where m.room_id = r.id)::int as member_count,
               (select count(*) from plans p where p.room_id = r.id)::int as plan_count
        from rooms r
        where ${pageWhere.length ? sql.join(pageWhere, sql` and `) : sql`true`}
        order by r.created_at desc, r.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(
        sql`select count(*)::int as n from rooms r where ${where.length ? sql.join(where, sql` and `) : sql`true`}`,
      ),
    ]);

    const rows = page.rows as {
      id: string;
      type: string;
      status: string;
      decision_mode: string;
      participant_count: number;
      title: string | null;
      host_user_id: string;
      scheduled_date: Date | string | null;
      created_at: Date | string;
      member_count: number;
      plan_count: number;
    }[];
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        decisionMode: r.decision_mode,
        participantCount: r.participant_count,
        ...(r.title ? { title: r.title } : {}),
        // The id, not a name or an address: it links to the user detail, which
        // is where identifying data belongs and is access-controlled.
        hostUserId: r.host_user_id,
        memberCount: r.member_count,
        planCount: r.plan_count,
        ...(r.scheduled_date ? { scheduledDate: toIso(r.scheduled_date) } : {}),
        createdAt: toIso(r.created_at),
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }

  async listPlans(query: {
    status?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const where: SQL[] = [];
    if (query.status) where.push(sql`p.status = ${query.status}::plan_status`);
    const pageWhere = [...where];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageWhere.push(sql`(p.created_at, p.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        select p.id, p.room_id, p.version, p.status, p.is_stale, p.created_at,
               (select count(*) from plan_stops s where s.plan_id = p.id)::int as stop_count
        from plans p
        where ${pageWhere.length ? sql.join(pageWhere, sql` and `) : sql`true`}
        order by p.created_at desc, p.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(
        sql`select count(*)::int as n from plans p where ${where.length ? sql.join(where, sql` and `) : sql`true`}`,
      ),
    ]);

    const rows = page.rows as {
      id: string;
      room_id: string;
      version: number;
      status: string;
      is_stale: boolean;
      created_at: Date | string;
      stop_count: number;
    }[];
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((p) => ({
        id: p.id,
        roomId: p.room_id,
        version: p.version,
        status: p.status,
        isStale: p.is_stale,
        stopCount: p.stop_count,
        createdAt: toIso(p.created_at),
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }

  /**
   * BE-CMS-G11 (#254) — the guests of one room.
   *
   * Room-scoped on purpose: there is no global guest directory in v1, because
   * no moderation case needs one and a list of every guest's display name and
   * activity would be a new PII surface with no reader.
   *
   * `token_hash` is never selected. It is the credential.
   */
  async roomGuests(roomId: string) {
    const [room] = await this.db
      .select({ id: schema.rooms.id })
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .limit(1);
    if (!room) throw AppError.notFound('ROOM_NOT_FOUND', 'No such room');

    const result = await this.db.execute(sql`
      select m.id as member_id, m.display_name, m.selection_status, m.joined_at,
             m.removed_at,
             g.id as guest_session_id, g.expires_at, g.revoked_at,
             (g.claimed_by_user_id is not null) as claimed
      from room_members m
      join guest_sessions g on g.id = m.guest_session_id
      where m.room_id = ${roomId} and m.guest_session_id is not null
      order by m.joined_at desc
    `);
    return {
      guests: (
        result.rows as {
          member_id: string;
          display_name: string;
          selection_status: string;
          joined_at: Date | string;
          removed_at: Date | string | null;
          guest_session_id: string;
          expires_at: Date | string;
          revoked_at: Date | string | null;
          claimed: boolean;
        }[]
      ).map((g) => ({
        memberId: g.member_id,
        guestSessionId: g.guest_session_id,
        displayName: g.display_name,
        selectionStatus: g.selection_status,
        joinedAt: toIso(g.joined_at),
        sessionExpiresAt: toIso(g.expires_at),
        ...(g.revoked_at ? { sessionRevokedAt: toIso(g.revoked_at) } : {}),
        ...(g.removed_at ? { removedAt: toIso(g.removed_at) } : {}),
        claimed: g.claimed,
      })),
    };
  }

  /**
   * BE-CMS-G11 (#254) — remove a guest from a room.
   *
   * **Not a ban, and never described as one.** A guest has no durable
   * identity — only a session tied to this room through the invite flow — so
   * whoever holds a still-valid invite can join again and receive a fresh
   * session. This action is "out of the room now": the session is revoked
   * (denylist included, so an access token already in flight dies) and the
   * membership is marked removed.
   *
   * The membership row is kept, not deleted: votes, reports and moderation
   * history reference it, and erasing the row would erase the context of the
   * removal itself.
   */
  async removeGuest(input: { roomId: string; memberId: string; reason: string; actorId: string }) {
    return this.db.transaction(async (tx) => {
      const [member] = await tx
        .select()
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.id, input.memberId),
            eq(schema.roomMembers.roomId, input.roomId),
          ),
        )
        .limit(1);
      if (!member) throw AppError.notFound('MEMBER_NOT_FOUND', 'No such member in this room');
      if (!member.guestSessionId) {
        // Registered members have an account and a different moderation path
        // (#246); this action is scoped to the identity kind it can actually
        // clean up after.
        throw AppError.conflict('NOT_A_GUEST', 'This member is a registered user, not a guest');
      }
      if (member.removedAt) {
        throw AppError.conflict('ALREADY_REMOVED', 'This guest was already removed');
      }

      await tx
        .update(schema.roomMembers)
        .set({ removedAt: sql`now()` })
        .where(eq(schema.roomMembers.id, member.id));
      await tx
        .update(schema.guestSessions)
        .set({ revokedAt: sql`now()` })
        .where(eq(schema.guestSessions.id, member.guestSessionId));
      // The denylist is what stops an access token already issued; the row
      // update only stops the opaque token from minting new ones.
      await this.revocations.revokeSession(member.guestSessionId);

      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.actorId,
        action: 'guest.removed_by_staff',
        resourceType: 'room_member',
        resourceId: member.id,
        diff: { reason: input.reason, roomId: input.roomId, guestSessionId: member.guestSessionId },
      });
      return { memberId: member.id, removed: true };
    });
  }

  private async revokeSessions(
    tx: Pick<Db, 'update'>,
    userId: string,
    reason: string,
  ): Promise<void> {
    const rows = await tx
      .update(schema.authSessions)
      .set({ revokedAt: sql`now()`, revokeReason: reason })
      .where(and(eq(schema.authSessions.userId, userId), isNull(schema.authSessions.revokedAt)))
      .returning({ id: schema.authSessions.id });
    await this.revocations.revokeMany(rows.map((r) => r.id));
  }
}

function toAppUser(row: UserRow): AppUser {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    authMethod: row.has_password ? 'password' : 'none',
    locale: row.locale,
    createdAt: toIso(row.created_at),
    lastActiveAt: row.last_active_at ? toIso(row.last_active_at) : null,
    counters: {
      roomsCreated: row.rooms_created,
      roomsJoined: row.rooms_joined,
      reviews: row.reviews,
      savedPlaces: row.saved_places,
    },
    reportCount: row.report_count,
  };
}
