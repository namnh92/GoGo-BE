import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { writeAudit } from '../../shared/audit';
import { publicMediaUrl } from '../../shared/media-url';
import { pgArray } from '../../search/infrastructure/search.repository';
import { pushAllowed } from '../../notifications/application/push-preference';

export type NotificationSettingsView = {
  pushEnabled: boolean;
  source: 'default' | 'explicit' | 'migrated' | 'legacy';
  updatedAt: string | null;
};

/**
 * No row means never chosen: on, unless an older client left a push opt-out
 * behind — the rule migration 0064 backfilled with, reported as `legacy` so
 * the client can tell a default from a choice it has not seen yet.
 */
export async function readNotificationSettings(
  db: Db,
  userId: string,
): Promise<NotificationSettingsView> {
  const [row] = await db
    .select()
    .from(schema.notificationSettings)
    .where(eq(schema.notificationSettings.userId, userId))
    .limit(1);
  if (row) {
    return {
      pushEnabled: row.pushEnabled,
      source: row.source,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  const { rows } = await db.execute(sql`select ${pushAllowed(sql`${userId}::uuid`)} as allowed`);
  const allowed = (rows[0] as { allowed: boolean }).allowed;
  return { pushEnabled: allowed, source: allowed ? 'default' : 'legacy', updatedAt: null };
}

export type ExportActor = { actorType: 'user' | 'admin'; actorId: string; reason?: string };

export type UserExportDocument = Awaited<ReturnType<typeof collectUserExport>>;

/**
 * #246 — one account's export, addressable by user id. A plain function since
 * GoGo-BE#256: the synchronous `GET /me/export` (via `UserContentService`) and
 * the worker that builds a secure export artifact (no Nest container) read
 * the same allowlist, so the two cannot drift.
 *
 * `by` rather than an assumed self-service actor: staff can run this for a
 * subject-access request made through support, and an audit row saying the
 * user exported their own data when a staff member did is the kind of
 * untruth an audit log exists to prevent.
 */
export async function collectUserExport(
  db: Db,
  userId: string,
  by: ExportActor,
  options: { mediaPublicBaseUrl: string },
) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  // ADR-0022: the profile's optional fields, resolved the way GET /me does.
  const [homeArea] = user?.homeAreaKey
    ? await db
        .select({
          key: schema.serviceAreas.key,
          name: schema.serviceAreas.name,
          city: schema.serviceAreas.city,
        })
        .from(schema.serviceAreas)
        .where(eq(schema.serviceAreas.key, user.homeAreaKey))
        .limit(1)
    : [];
  const [interests] = await db
    .select({ selections: schema.userProfilePreferences.selections })
    .from(schema.userProfilePreferences)
    .where(eq(schema.userProfilePreferences.userId, userId))
    .limit(1);
  const memberships = await db
    .select()
    .from(schema.roomMembers)
    .where(eq(schema.roomMembers.userId, userId));
  const memberIds = memberships.map((m) => m.id);
  const preferences =
    memberIds.length > 0
      ? await db
          .select()
          .from(schema.preferenceSelections)
          .where(
            sql`${schema.preferenceSelections.memberId} = any((${pgArray(memberIds)})::uuid[])`,
          )
      : [];
  const votes =
    memberIds.length > 0
      ? await db
          .select()
          .from(schema.votes)
          .where(sql`${schema.votes.memberId} = any((${pgArray(memberIds)})::uuid[])`)
      : [];
  const saved = await db
    .select()
    .from(schema.savedItems)
    .where(eq(schema.savedItems.userId, userId));
  const reviews = await db.select().from(schema.reviews).where(eq(schema.reviews.userId, userId));
  // ADR-0026 — the reactions this person gave, never anyone else's.
  const reviewReactions = await db
    .select()
    .from(schema.reviewReactions)
    .where(eq(schema.reviewReactions.userId, userId));

  const notificationSettings = await readNotificationSettings(db, userId);

  await writeAudit(db, {
    actorType: by.actorType,
    actorId: by.actorId,
    action: 'user.data_exported',
    resourceType: 'user',
    resourceId: userId,
    ...(by.reason ? { diff: { reason: by.reason } } : {}),
  });

  return {
    exportedAt: new Date().toISOString(),
    // An explicit allowlist, never a spread of the row: the row also holds
    // the password hash, and an export is the one document a person forwards.
    profile: {
      displayName: user?.displayName,
      email: user?.email,
      locale: user?.locale,
      createdAt: user?.createdAt.toISOString(),
      avatarUrl: publicMediaUrl(options.mediaPublicBaseUrl, user?.avatarKey),
      homeArea: homeArea ?? null,
      homeAdministrativeArea: user?.homeAdministrativeArea ?? null,
      interests: { mood: interests?.selections?.mood ?? [] },
      usualBudget:
        user?.usualBudgetPerPerson === null || user?.usualBudgetPerPerson === undefined
          ? null
          : { perPerson: user.usualBudgetPerPerson, currency: user.usualBudgetCurrency },
      dateOfBirth: user?.dateOfBirth ?? null,
    },
    memberships: memberships.map((m) => ({
      roomId: m.roomId,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
    preferences: preferences.map((p) => ({ roomId: p.roomId, selections: p.selections })),
    votes: votes.map((v) => ({ roomId: v.roomId, placeId: v.targetPlaceId, value: v.value })),
    saved: saved.map((s) => ({ type: s.targetType, id: s.targetId })),
    reviews: reviews.map((r) => ({ rating: r.rating, text: r.text, status: r.status })),
    notificationSettings: {
      pushEnabled: notificationSettings.pushEnabled,
      source: notificationSettings.source,
    },
    reviewReactions: reviewReactions.map((r) => ({
      reviewId: r.reviewId,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
