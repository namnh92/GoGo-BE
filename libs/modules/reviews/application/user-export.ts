import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { schema, type Db } from '@gogo/database';
import { writeAudit } from '../../shared/audit';
import { publicMediaUrl } from '../../shared/media-url';
import { pgArray } from '../../search/infrastructure/search.repository';
import { pushAllowed } from '../../notifications/application/push-preference';
import { ExportTooLargeError } from '../../privacy/domain/export-envelope';
import { collectAssistantExport } from '../../assistant/application/assistant-privacy';

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

/** Rows fetched per query while collecting (PR #677 F-03). */
export const EXPORT_PAGE_SIZE = 500;

/**
 * PR #677 F-03 — a running byte budget charged while rows are collected, so an
 * oversized account fails after reading roughly `maxBytes` of data rather than
 * after holding every table in memory. Serialization re-checks exactly.
 */
class ExportBudget {
  private used = 0;
  constructor(private readonly maxBytes: number) {}
  charge(value: unknown): void {
    if (!Number.isFinite(this.maxBytes)) return;
    this.used += Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8') + 1;
    if (this.used > this.maxBytes) throw new ExportTooLargeError(this.maxBytes);
  }
}

/** Keyset pages by `id`, each mapped item charged as it arrives. */
async function collectPaged<R extends { id: string }, O>(
  fetchPage: (after: string | null, limit: number) => Promise<R[]>,
  map: (row: R) => O,
  budget: ExportBudget,
  onRow?: (row: R) => void,
): Promise<O[]> {
  const out: O[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await fetchPage(after, EXPORT_PAGE_SIZE);
    for (const row of page) {
      const item = map(row);
      budget.charge(item);
      onRow?.(row);
      out.push(item);
    }
    if (page.length < EXPORT_PAGE_SIZE) return out;
    after = page[page.length - 1]!.id;
  }
}

export async function collectUserExport(
  db: Db,
  userId: string,
  by: ExportActor,
  options: { mediaPublicBaseUrl: string; maxBytes?: number },
) {
  const budget = new ExportBudget(options.maxBytes ?? Number.POSITIVE_INFINITY);
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

  // An explicit allowlist, never a spread of the row: the row also holds
  // the password hash, and an export is the one document a person forwards.
  const profile = {
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
  };
  budget.charge(profile);

  const memberIds: string[] = [];
  const m = schema.roomMembers;
  const memberships = await collectPaged(
    (after, limit) =>
      db
        .select()
        .from(m)
        .where(and(eq(m.userId, userId), after ? gt(m.id, after) : undefined))
        .orderBy(asc(m.id))
        .limit(limit),
    (row) => ({ roomId: row.roomId, role: row.role, joinedAt: row.joinedAt.toISOString() }),
    budget,
    (row) => memberIds.push(row.id),
  );
  const ofMembers = (column: AnyPgColumn) => sql`${column} = any((${pgArray(memberIds)})::uuid[])`;
  const p = schema.preferenceSelections;
  const preferences =
    memberIds.length > 0
      ? await collectPaged(
          (after, limit) =>
            db
              .select()
              .from(p)
              .where(and(ofMembers(p.memberId), after ? gt(p.id, after) : undefined))
              .orderBy(asc(p.id))
              .limit(limit),
          (row) => ({ roomId: row.roomId, selections: row.selections }),
          budget,
        )
      : [];
  const v = schema.votes;
  const votes =
    memberIds.length > 0
      ? await collectPaged(
          (after, limit) =>
            db
              .select()
              .from(v)
              .where(and(ofMembers(v.memberId), after ? gt(v.id, after) : undefined))
              .orderBy(asc(v.id))
              .limit(limit),
          (row) => ({ roomId: row.roomId, placeId: row.targetPlaceId, value: row.value }),
          budget,
        )
      : [];
  const si = schema.savedItems;
  const saved = await collectPaged(
    (after, limit) =>
      db
        .select()
        .from(si)
        .where(and(eq(si.userId, userId), after ? gt(si.id, after) : undefined))
        .orderBy(asc(si.id))
        .limit(limit),
    (row) => ({ type: row.targetType, id: row.targetId }),
    budget,
  );
  const r = schema.reviews;
  const reviews = await collectPaged(
    (after, limit) =>
      db
        .select()
        .from(r)
        .where(and(eq(r.userId, userId), after ? gt(r.id, after) : undefined))
        .orderBy(asc(r.id))
        .limit(limit),
    (row) => ({ rating: row.rating, text: row.text, status: row.status }),
    budget,
  );
  // ADR-0026 — the reactions this person gave, never anyone else's. Keyed by
  // (review, type) within one user, encoded as the page cursor.
  const rr = schema.reviewReactions;
  const reviewReactions = await collectPaged(
    async (after, limit) => {
      const [afterReview, afterType] = after ? after.split('|') : [];
      const rows = await db
        .select()
        .from(rr)
        .where(
          and(
            eq(rr.userId, userId),
            after
              ? sql`(${rr.reviewId}, ${rr.type}) > (${afterReview}::uuid, ${afterType})`
              : undefined,
          ),
        )
        .orderBy(asc(rr.reviewId), asc(rr.type))
        .limit(limit);
      return rows.map((row) => ({ ...row, id: `${row.reviewId}|${row.type}` }));
    },
    (row) => ({ reviewId: row.reviewId, type: row.type, createdAt: row.createdAt.toISOString() }),
    budget,
  );

  const notificationSettings = await readNotificationSettings(db, userId);
  // GoGo-BE#713 Q2 — retained GoGo AI conversations (absent before the module).
  const assistantConversations = await collectAssistantExport(db, userId, (v) => budget.charge(v));

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
    profile,
    memberships,
    preferences,
    votes,
    saved,
    reviews,
    notificationSettings: {
      pushEnabled: notificationSettings.pushEnabled,
      source: notificationSettings.source,
    },
    reviewReactions,
    assistantConversations,
  };
}
