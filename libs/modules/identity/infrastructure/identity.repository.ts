import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';

export type UserRow = typeof schema.users.$inferSelect;
export type AuthSessionRow = typeof schema.authSessions.$inferSelect;
export type GuestSessionRow = typeof schema.guestSessions.$inferSelect;

@Injectable()
export class IdentityRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  findUserByEmail(email: string): Promise<UserRow | undefined> {
    return this.db
      .select()
      .from(schema.users)
      .where(
        and(
          sql`lower(${schema.users.email}) = lower(${email})`,
          sql`${schema.users.status} <> 'deleted'`,
        ),
      )
      .limit(1)
      .then((r) => r[0]);
  }

  findUserById(id: string): Promise<UserRow | undefined> {
    return this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1)
      .then((r) => r[0]);
  }

  async createUser(input: {
    email: string;
    passwordHash: string;
    displayName: string;
    locale?: string;
  }): Promise<UserRow> {
    const [row] = await this.db
      .insert(schema.users)
      .values({
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        locale: input.locale ?? 'vi',
      })
      .returning();
    if (!row) throw new Error('user insert returned no row');
    return row;
  }

  async createAuthSession(input: {
    userId: string;
    refreshTokenHash: string;
    familyId: string;
    rotatedFromId?: string;
    expiresAt: Date;
    ipHash?: string;
    userAgent?: string;
  }): Promise<AuthSessionRow> {
    const [row] = await this.db.insert(schema.authSessions).values(input).returning();
    if (!row) throw new Error('auth session insert returned no row');
    return row;
  }

  findAuthSessionByTokenHash(hash: string): Promise<AuthSessionRow | undefined> {
    return this.db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.refreshTokenHash, hash))
      .limit(1)
      .then((r) => r[0]);
  }

  findAuthSessionById(id: string): Promise<AuthSessionRow | undefined> {
    return this.db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.id, id))
      .limit(1)
      .then((r) => r[0]);
  }

  async markSessionSuperseded(id: string): Promise<void> {
    await this.db
      .update(schema.authSessions)
      .set({ supersededAt: sql`now()`, lastUsedAt: sql`now()` })
      .where(eq(schema.authSessions.id, id));
  }

  /** Revoke every session in a rotation family (theft response, logout-all). */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db
      .update(schema.authSessions)
      .set({ revokedAt: sql`now()`, revokeReason: reason })
      .where(
        and(eq(schema.authSessions.familyId, familyId), isNull(schema.authSessions.revokedAt)),
      );
  }

  /** Session ids in a rotation family — used to deny outstanding access tokens. */
  async listFamilySessionIds(familyId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: schema.authSessions.id })
      .from(schema.authSessions)
      .where(eq(schema.authSessions.familyId, familyId));
    return rows.map((r) => r.id);
  }

  async revokeSession(id: string, reason: string): Promise<void> {
    await this.db
      .update(schema.authSessions)
      .set({ revokedAt: sql`now()`, revokeReason: reason })
      .where(eq(schema.authSessions.id, id));
  }

  async recordLoginAttempt(input: {
    identifierHash: string;
    ipHash: string;
    succeeded: boolean;
  }): Promise<void> {
    await this.db.insert(schema.loginAttempts).values(input);
  }

  /** Failed attempts within the sliding window, for lockout decisions. */
  async countRecentFailures(identifierHash: string, windowSeconds: number): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.loginAttempts)
      .where(
        and(
          eq(schema.loginAttempts.identifierHash, identifierHash),
          eq(schema.loginAttempts.succeeded, false),
          gt(schema.loginAttempts.createdAt, sql`now() - make_interval(secs => ${windowSeconds})`),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  // --- guest sessions -------------------------------------------------------

  findRoomByCode(code: string) {
    return this.db
      .select()
      .from(schema.rooms)
      .where(eq(schema.rooms.code, code))
      .limit(1)
      .then((r) => r[0]);
  }

  async createGuestSession(input: {
    roomId: string;
    displayName: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<GuestSessionRow> {
    const [row] = await this.db.insert(schema.guestSessions).values(input).returning();
    if (!row) throw new Error('guest session insert returned no row');
    return row;
  }

  async revokeGuestSession(id: string): Promise<void> {
    await this.db
      .update(schema.guestSessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(schema.guestSessions.id, id));
  }

  findGuestSessionByTokenHash(hash: string): Promise<GuestSessionRow | undefined> {
    return this.db
      .select()
      .from(schema.guestSessions)
      .where(eq(schema.guestSessions.tokenHash, hash))
      .limit(1)
      .then((r) => r[0]);
  }

  findGuestSessionById(id: string): Promise<GuestSessionRow | undefined> {
    return this.db
      .select()
      .from(schema.guestSessions)
      .where(eq(schema.guestSessions.id, id))
      .limit(1)
      .then((r) => r[0]);
  }

  async addGuestMember(input: {
    roomId: string;
    guestSessionId: string;
    displayName: string;
  }): Promise<void> {
    await this.db
      .insert(schema.roomMembers)
      .values({
        roomId: input.roomId,
        guestSessionId: input.guestSessionId,
        displayName: input.displayName,
        role: 'member',
      })
      .onConflictDoNothing();
  }

  /**
   * Guest claim flow (FR-AUTH-003): re-parent memberships and close the guest
   * session, atomically.
   */
  async claimGuestSession(guestSessionId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.guestSessions)
        .set({ claimedByUserId: userId, claimedAt: sql`now()`, revokedAt: sql`now()` })
        .where(eq(schema.guestSessions.id, guestSessionId));
      await tx
        .update(schema.roomMembers)
        .set({ userId, guestSessionId: null })
        .where(eq(schema.roomMembers.guestSessionId, guestSessionId));
    });
  }

  async insertAudit(input: {
    actorType: 'admin' | 'user' | 'system';
    actorId?: string;
    action: string;
    resourceType: string;
    resourceId: string;
    diff?: unknown;
    requestId?: string;
  }): Promise<void> {
    await this.db.insert(schema.auditLogs).values({
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      diff: input.diff,
      requestId: input.requestId,
    });
  }
}
