import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';

/** #879: fixtures obey the same committed single-host invariant as production. */
export async function hostedRoom(db: Db, input: typeof schema.rooms.$inferInsert) {
  return db.transaction(async (tx) => {
    const [room] = await tx.insert(schema.rooms).values(input).returning();
    const [user] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.hostUserId));
    await tx.insert(schema.roomMembers).values({
      roomId: room!.id,
      userId: input.hostUserId,
      role: 'host',
      displayName: user!.displayName,
    });
    return [room!] as const;
  });
}

/** Set the explicit fixture host's name/selection flags without duplicating its identity. */
export async function fixtureMembers(
  db: Db,
  input: typeof schema.roomMembers.$inferInsert | (typeof schema.roomMembers.$inferInsert)[],
) {
  return db.transaction(async (tx) => {
    const rows: (typeof schema.roomMembers.$inferSelect)[] = [];
    for (const value of Array.isArray(input) ? input : [input]) {
      const [existing] =
        value.role === 'host' && value.userId
          ? await tx
              .select()
              .from(schema.roomMembers)
              .where(
                and(
                  eq(schema.roomMembers.roomId, value.roomId),
                  eq(schema.roomMembers.userId, value.userId),
                  eq(schema.roomMembers.role, 'host'),
                  isNull(schema.roomMembers.removedAt),
                ),
              )
          : [];
      const [row] = existing
        ? await tx
            .update(schema.roomMembers)
            .set(value)
            .where(eq(schema.roomMembers.id, existing.id))
            .returning()
        : await tx.insert(schema.roomMembers).values(value).returning();
      rows.push(row!);
    }
    return rows;
  });
}
export async function fixtureHostAuthority(db: Db, roomId: string) {
  const [room] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId));
  const [member] = await db
    .select()
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.roomId, roomId),
        eq(schema.roomMembers.role, 'host'),
        isNull(schema.roomMembers.removedAt),
      ),
    );
  return {
    kind: 'host',
    actor: { type: 'user', id: room!.hostUserId, sessionId: 'fixture' },
    memberId: member!.id,
    hostVersion: room!.hostVersion,
  } as const;
}

/** Build an ownership snapshot for legacy downstream tests without invalid intermediate commits. */
export async function fixtureTransferHost(db: Db, roomId: string, targetId?: string) {
  return db.transaction(async (tx) => {
    const [room] = await tx
      .select()
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .for('update');
    let target = targetId;
    if (!target) {
      const [u] = await tx
        .insert(schema.users)
        .values({ displayName: 'Replacement fixture host' })
        .returning();
      const [m] = await tx
        .insert(schema.roomMembers)
        .values({ roomId, userId: u!.id, role: 'member', displayName: u!.displayName })
        .returning();
      target = m!.id;
    }
    const [member] = await tx
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.id, target));
    await tx
      .update(schema.roomMembers)
      .set({ role: 'member' })
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.role, 'host')));
    await tx
      .update(schema.roomMembers)
      .set({ role: 'host' })
      .where(eq(schema.roomMembers.id, target));
    await tx
      .update(schema.rooms)
      .set({ hostUserId: member!.userId!, hostVersion: room!.hostVersion + 1 })
      .where(eq(schema.rooms.id, roomId));
    return member!;
  });
}
