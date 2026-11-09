import { lockAssistantAccount } from '../../shared/assistant-credits';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeOutbox } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import { APP_CONFIG, type MediaConfig, type PrivacyLedgerConfig } from '../../shared/config';
import { recordSelfServiceRequest, slaConfigFrom } from '../../shared/privacy-ledger';
import type { Actor } from '../../identity/domain/actor';
import { writeAudit } from '../../shared/audit';
import { MediaCleanupService } from '../../profile/application/media-cleanup.service';
import { PRIVACY_EXPORT_STORAGE, type StoragePort } from '@gogo/providers';
import { cleanupDueArtifacts } from '../../privacy/application/export-artifacts';
import {
  collectUserExport,
  readNotificationSettings,
  type ExportActor,
  type NotificationSettingsView,
} from './user-export';
import {
  mutateNotificationSettings,
  mutateNotificationEmail,
  type SettingsPatch,
} from '../../notifications/application/category-preferences';
import { effectivePush } from '../../notifications/domain/notification-registry';
import type { IdempotencyScope } from '../../shared/idempotency.interceptor';
import { activeDataset } from '../../administrative/application/unit-lookup';
import {
  UNKNOWN_AREA,
  codesToLabel,
  placeArea,
  planArea,
  withLabels,
  type SavedAreaCodes,
  type SavedItemArea,
} from '../domain/saved-area';
import { READABLE_PLACE_STATUSES } from '../domain/public-review';
import { loadGogoRatings } from '../infrastructure/gogo-ratings';
import { eraseAssistantDataForUser } from '../../assistant/application/assistant-privacy';
import {
  INDEPENDENT_SOURCE_TYPES,
  contactOwnership,
  isGoogleReference,
  isTransportReference,
} from '../../shared/place-contact';

/** The kinds the per-kind contract (`NotificationKind`) exposes; campaigns never had a toggle. */
const LEGACY_PUSH_KINDS = [
  'invite',
  'preference_reminder',
  'plan_ready',
  'plan_changed',
  'date_reminder',
  'moderation_update',
] as const;

export type { NotificationSettingsView };

export function requireUser(actor: Actor): string {
  if (actor.type !== 'user') {
    throw AppError.forbidden('USER_ONLY', 'Register an account to use this feature');
  }
  return actor.id;
}

type SavedPlanConditionVersions = {
  planConstraintVersion: number;
  currentConstraintVersion: number;
};

/** GoGo-BE#759 — version facts, never localized warning copy. */
export function toSavedPlanConditionFacts(versions: SavedPlanConditionVersions) {
  return {
    conditionsChanged: versions.currentConstraintVersion > versions.planConstraintVersion,
    ...versions,
  };
}

type MyReviewRow = {
  id: string;
  placeId: string | null;
  planId: string | null;
  rating: number;
  text: string | null;
  status: 'pending' | 'published' | 'rejected' | 'removed' | 'hidden';
  moderationReason: string | null;
  createdAt: Date;
  placeName: string | null;
  placeAddressText: string | null;
  addressSourceType: string | null;
  addressSourceReference: string | null;
  addressCollectedAt: Date | null;
  helpfulCount: number;
};

type MyReviewRoomFacts = {
  planTitle: string | null;
  planScheduledDate: Date | null;
};

type MyReviewNameProvenance = {
  placeId: string;
  sourceType: string;
  sourceReference: string | null;
};

function hasIndependentPlaceNameProvenance(
  provenance: MyReviewNameProvenance | undefined,
): boolean {
  if (!provenance) return false;
  const reference = provenance.sourceReference?.trim();
  return (
    (INDEPENDENT_SOURCE_TYPES as readonly string[]).includes(provenance.sourceType) &&
    reference !== undefined &&
    reference !== '' &&
    !isGoogleReference(reference) &&
    !isTransportReference(reference)
  );
}

/** GoGo-BE#752 — facts needed to identify what an own-review row is about. */
export function toMyReview(
  row: MyReviewRow,
  roomFacts?: MyReviewRoomFacts,
  nameProvenance?: MyReviewNameProvenance,
) {
  const addressOwnership = row.addressSourceType
    ? contactOwnership({
        source_type: row.addressSourceType,
        source_reference: row.addressSourceReference,
        collected_at: row.addressCollectedAt,
      })
    : 'unknown';
  const verifiedPlaceAddress = addressOwnership === 'gogo' ? row.placeAddressText : null;
  const verifiedPlaceName = hasIndependentPlaceNameProvenance(nameProvenance)
    ? row.placeName
    : null;
  const rejectionReason =
    row.status === 'rejected' ? row.moderationReason?.trim() || undefined : undefined;

  return {
    id: row.id,
    placeId: row.placeId ?? undefined,
    planId: row.planId ?? undefined,
    rating: row.rating,
    text: row.text ?? undefined,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    ...(verifiedPlaceName !== null ? { placeName: verifiedPlaceName } : {}),
    ...(verifiedPlaceAddress !== null ? { placeAddressText: verifiedPlaceAddress } : {}),
    ...(roomFacts?.planTitle != null ? { planTitle: roomFacts.planTitle } : {}),
    ...(roomFacts?.planScheduledDate != null
      ? { planScheduledDate: roomFacts.planScheduledDate.toISOString() }
      : {}),
    helpfulCount: row.helpfulCount,
    ...(rejectionReason ? { rejectionReason } : {}),
  };
}

/** Private room facts for reviewed plans the caller may still read. */
export function activePlanRoomFactsQuery(db: Db, userId: string, planIds: string[]) {
  return db
    .select({
      planId: schema.plans.id,
      planTitle: schema.rooms.title,
      planScheduledDate: schema.rooms.scheduledDate,
    })
    .from(schema.plans)
    .innerJoin(schema.rooms, eq(schema.rooms.id, schema.plans.roomId))
    .innerJoin(
      schema.roomMembers,
      and(
        eq(schema.roomMembers.roomId, schema.rooms.id),
        eq(schema.roomMembers.userId, userId),
        isNull(schema.roomMembers.removedAt),
      ),
    )
    .where(inArray(schema.plans.id, planIds));
}

/** Independent provenance for every reviewed place name, read without an N+1 query. */
export function placeNameProvenanceQuery(db: Db, placeIds: string[]) {
  return db
    .select({
      placeId: schema.placeFieldProvenance.placeId,
      sourceType: schema.placeFieldProvenance.sourceType,
      sourceReference: schema.placeFieldProvenance.sourceReference,
    })
    .from(schema.placeFieldProvenance)
    .where(
      and(
        inArray(schema.placeFieldProvenance.placeId, placeIds),
        eq(schema.placeFieldProvenance.field, 'name'),
      ),
    );
}

/** BE-BFF-009 — saved items, reviews, profile, privacy (export/delete). */
@Injectable()
export class UserContentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: PrivacyLedgerConfig & MediaConfig,
    private readonly cleanup: MediaCleanupService,
    /**
     * PR #677 S-F-13 — the fail-closed private bucket: `null` when this process
     * has no real one and is not under test. Never the general fake: a fake
     * delete returns, and `cleanupDueArtifacts` would then record the export
     * as gone while its bytes stayed in R2.
     */
    @Inject(PRIVACY_EXPORT_STORAGE) private readonly privateStorage: StoragePort | null,
  ) {}

  // --- saved (FR-USER-001) --------------------------------------------------

  async listSaved(actor: Actor) {
    const userId = requireUser(actor);
    const rows = await this.db
      .select()
      .from(schema.savedItems)
      .where(eq(schema.savedItems.userId, userId))
      .orderBy(desc(schema.savedItems.createdAt));
    const placeIds = rows.filter((r) => r.targetType === 'place').map((r) => r.targetId);
    const planIds = rows.filter((r) => r.targetType === 'plan').map((r) => r.targetId);
    const [areas, gogoRatings, planConditionFacts] = await Promise.all([
      this.savedAreas(placeIds, planIds),
      loadGogoRatings(this.db, placeIds),
      this.savedPlanConditionFacts(userId, planIds),
    ]);
    return rows.map((r) => ({
      targetType: r.targetType,
      targetId: r.targetId,
      savedAt: r.createdAt.toISOString(),
      area: areas.get(`${r.targetType}:${r.targetId}`) ?? UNKNOWN_AREA,
      ...(r.targetType === 'place' ? gogoRatings.get(r.targetId) : {}),
      ...(r.targetType === 'plan' ? (planConditionFacts.get(r.targetId) ?? {}) : {}),
    }));
  }

  /**
   * GoGo-BE#759 — one authorized batch for every saved plan. A removed member
   * keeps their own bookmark but learns no later room state from this list.
   */
  private async savedPlanConditionFacts(userId: string, planIds: string[]) {
    if (planIds.length === 0)
      return new Map<string, ReturnType<typeof toSavedPlanConditionFacts>>();
    const rows = await this.db
      .select({
        planId: schema.plans.id,
        planConstraintVersion: schema.plans.constraintVersion,
        currentConstraintVersion: schema.rooms.constraintVersion,
      })
      .from(schema.plans)
      .innerJoin(schema.rooms, eq(schema.rooms.id, schema.plans.roomId))
      .innerJoin(
        schema.roomMembers,
        and(
          eq(schema.roomMembers.roomId, schema.rooms.id),
          eq(schema.roomMembers.userId, userId),
          isNull(schema.roomMembers.removedAt),
        ),
      )
      .where(inArray(schema.plans.id, planIds));
    return new Map(
      rows.map((row) => [
        row.planId,
        toSavedPlanConditionFacts({
          planConstraintVersion: row.planConstraintVersion,
          currentConstraintVersion: row.currentConstraintVersion,
        }),
      ]),
    );
  }

  /**
   * ADM-022 (#569) — area facts for the whole saved list in five queries
   * whatever its length: the published dataset, plan stops, place mappings,
   * unit labels. The list is not paginated, so a client groups all of it, not a
   * page of it. No published dataset means every item is `unknown`, not an error.
   */
  private async savedAreas(
    placeIds: string[],
    planIds: string[],
  ): Promise<Map<string, SavedItemArea>> {
    const result = new Map<string, SavedItemArea>();
    if (placeIds.length === 0 && planIds.length === 0) return result;
    const dataset = await activeDataset(this.db);
    if (!dataset) return result;

    const stops =
      planIds.length > 0
        ? await this.db
            .select({ planId: schema.planStops.planId, placeId: schema.planStops.placeId })
            .from(schema.planStops)
            .where(inArray(schema.planStops.planId, planIds))
        : [];
    const allPlaceIds = [...new Set([...placeIds, ...stops.map((s) => s.placeId)])];
    const mappings =
      allPlaceIds.length > 0
        ? await this.db
            .select({
              id: schema.places.id,
              provinceCode: schema.places.provinceCode,
              communeCode: schema.places.communeCode,
              status: schema.places.administrativeMappingStatus,
              datasetVersion: schema.places.administrativeDatasetVersion,
            })
            .from(schema.places)
            .where(inArray(schema.places.id, allPlaceIds))
        : [];
    const mappingById = new Map(mappings.map((m) => [m.id, m]));
    const areaOf = (placeId: string) =>
      placeArea(mappingById.get(placeId), dataset.combinedDatasetVersion);

    const codesByItem = new Map<string, SavedAreaCodes>();
    for (const id of placeIds) {
      const codes = areaOf(id);
      codesByItem.set(`place:${id}`, codes ? { scope: 'commune', ...codes } : { scope: 'unknown' });
    }
    const stopsByPlan = new Map<string, string[]>();
    for (const stop of stops) {
      stopsByPlan.set(stop.planId, [...(stopsByPlan.get(stop.planId) ?? []), stop.placeId]);
    }
    for (const id of planIds) {
      codesByItem.set(`plan:${id}`, planArea((stopsByPlan.get(id) ?? []).map(areaOf)));
    }

    const codes = codesToLabel(codesByItem.values());
    const units =
      codes.length > 0
        ? await this.db
            .select({
              code: schema.administrativeUnits.code,
              level: schema.administrativeUnits.level,
              fullName: schema.administrativeUnits.fullName,
              parentCode: schema.administrativeUnits.parentCode,
            })
            .from(schema.administrativeUnits)
            .where(
              and(
                eq(schema.administrativeUnits.datasetVersionId, dataset.id),
                inArray(schema.administrativeUnits.code, codes),
                eq(schema.administrativeUnits.status, 'ACTIVE'),
                isNull(schema.administrativeUnits.effectiveTo),
              ),
            )
        : [];
    const unitByKey = new Map(units.map((u) => [`${u.level}:${u.code}`, u]));
    for (const [key, itemCodes] of codesByItem) {
      result.set(key, withLabels(itemCodes, dataset.combinedDatasetVersion, unitByKey));
    }
    return result;
  }

  async save(actor: Actor, targetType: 'place' | 'plan', targetId: string) {
    const userId = requireUser(actor);
    if (targetType === 'place') {
      const [place] = await this.db
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(eq(schema.places.id, targetId));
      if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
    }
    await this.db
      .insert(schema.savedItems)
      .values({ userId, targetType, targetId })
      .onConflictDoNothing();
    return { saved: true };
  }

  async unsave(actor: Actor, targetType: 'place' | 'plan', targetId: string) {
    const userId = requireUser(actor);
    await this.db
      .delete(schema.savedItems)
      .where(
        and(
          eq(schema.savedItems.userId, userId),
          eq(schema.savedItems.targetType, targetType),
          eq(schema.savedItems.targetId, targetId),
        ),
      );
    return { saved: false };
  }

  // --- reviews (FR-USER-002) ------------------------------------------------

  async createReview(
    actor: Actor,
    input: {
      placeId?: string | undefined;
      planId?: string | undefined;
      rating: number;
      text?: string | undefined;
    },
  ) {
    const userId = requireUser(actor);
    const [row] = await this.db
      .insert(schema.reviews)
      .values({
        userId,
        placeId: input.placeId ?? null,
        planId: input.planId ?? null,
        rating: input.rating,
        text: input.text ?? null,
      })
      .returning();
    await writeOutbox(this.db, {
      eventType: 'review.submitted',
      resourceType: 'review',
      resourceId: row!.id,
      payload: { placeId: input.placeId ?? null },
    });
    return { id: row!.id, rating: row!.rating, status: row!.status };
  }

  async updateReview(
    actor: Actor,
    reviewId: string,
    input: { rating?: number | undefined; text?: string | undefined },
  ) {
    const userId = requireUser(actor);
    const [review] = await this.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId))
      .limit(1);
    if (!review) throw AppError.notFound('REVIEW_NOT_FOUND', 'Review not found');
    // Ownership is the rule — even admins edit via moderation, not here.
    if (review.userId !== userId) throw AppError.forbidden();
    const [updated] = await this.db
      .update(schema.reviews)
      .set({
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        status: 'pending', // edits go back through moderation
        updatedAt: sql`now()`,
      })
      .where(eq(schema.reviews.id, reviewId))
      .returning();
    return { id: updated!.id, rating: updated!.rating, status: updated!.status };
  }

  async myReviews(actor: Actor) {
    const userId = requireUser(actor);
    // Derived from reactions rather than copied onto the review, so the list
    // cannot drift from the public helpful count.
    const helpfulCount = sql<number>`(
      select count(*)::int from ${schema.reviewReactions} rr
      where rr.review_id = ${schema.reviews.id} and rr.type = 'helpful'
    )`.mapWith(Number);
    const rows = await this.db
      .select({
        id: schema.reviews.id,
        placeId: schema.reviews.placeId,
        planId: schema.reviews.planId,
        rating: schema.reviews.rating,
        text: schema.reviews.text,
        status: schema.reviews.status,
        moderationReason: schema.reviews.moderationReason,
        createdAt: schema.reviews.createdAt,
        placeName: schema.places.name,
        placeAddressText: schema.places.addressText,
        addressSourceType: schema.placeFieldProvenance.sourceType,
        addressSourceReference: schema.placeFieldProvenance.sourceReference,
        addressCollectedAt: schema.placeFieldProvenance.collectedAt,
        helpfulCount,
      })
      .from(schema.reviews)
      .leftJoin(
        schema.places,
        and(
          eq(schema.places.id, schema.reviews.placeId),
          inArray(schema.places.status, READABLE_PLACE_STATUSES),
        ),
      )
      .leftJoin(
        schema.placeFieldProvenance,
        and(
          eq(schema.placeFieldProvenance.placeId, schema.places.id),
          eq(schema.placeFieldProvenance.field, 'address_text'),
        ),
      )
      .where(eq(schema.reviews.userId, userId))
      .orderBy(desc(schema.reviews.createdAt));

    // The catalogue column alone does not establish ownership. Read the name
    // origin once for all reviewed places and fail closed for absent, Google,
    // or otherwise non-independent provenance.
    const placeIds = [
      ...new Set(rows.flatMap((row) => (row.placeId === null ? [] : [row.placeId]))),
    ];
    const nameProvenanceRows =
      placeIds.length > 0 ? await placeNameProvenanceQuery(this.db, placeIds) : [];
    const nameProvenanceByPlace = new Map(
      nameProvenanceRows.map((provenance) => [provenance.placeId, provenance]),
    );

    // One batched authorization query for every reviewed plan. Joining active
    // membership here keeps the review visible while making private room facts
    // disappear immediately for non-members and removed members.
    const planIds = [...new Set(rows.flatMap((row) => (row.planId === null ? [] : [row.planId])))];
    const roomFactRows =
      planIds.length > 0 ? await activePlanRoomFactsQuery(this.db, userId, planIds) : [];
    const roomFactsByPlan = new Map<string, MyReviewRoomFacts>(
      roomFactRows.map(({ planId, planTitle, planScheduledDate }) => [
        planId,
        { planTitle, planScheduledDate },
      ]),
    );
    return rows.map((row) =>
      toMyReview(
        row,
        row.planId === null ? undefined : roomFactsByPlan.get(row.planId),
        row.placeId === null ? undefined : nameProvenanceByPlace.get(row.placeId),
      ),
    );
  }

  // --- privacy (security rules: export + delete) ----------------------------

  /** Data export — every actor-owned row, JSON, no internal ids beyond needed. */
  async exportData(actor: Actor) {
    const userId = requireUser(actor);
    const data = await this.exportForUser(userId, { actorType: 'user', actorId: userId });
    // #255 — the ledger records self-service too, born-completed. A report
    // that silently omits self-service undercounts most real requests. Only
    // here, in the actor-facing wrapper: the CMS execute path already has a
    // ledger row and must not grow a duplicate.
    await recordSelfServiceRequest(this.db, {
      type: 'export',
      userId,
      sla: slaConfigFrom(this.config.PRIVACY_SLA_JSON),
      retentionMonths: this.config.PRIVACY_RETENTION_MONTHS,
    });
    return data;
  }

  /**
   * #246 — the same export, addressable by user id.
   *
   * `by` rather than an assumed self-service actor: staff can run this for a
   * subject-access request made through support, and an audit row saying the
   * user exported their own data when a staff member did is the kind of
   * untruth an audit log exists to prevent.
   */
  async exportForUser(userId: string, by: ExportActor) {
    return collectUserExport(this.db, userId, by, {
      mediaPublicBaseUrl: this.config.MEDIA_PUBLIC_BASE_URL,
    });
  }

  /**
   * Account deletion: PII nulled, sessions revoked, content pseudonymized —
   * partial-unique email index frees the address for re-registration.
   */
  async deleteAccount(actor: Actor) {
    const userId = requireUser(actor);
    const result = await this.deleteForUser(userId, { actorType: 'user', actorId: userId });
    // #255 — see exportData. Recorded after the delete succeeds, so a failed
    // erasure cannot leave a ledger row claiming completion.
    await recordSelfServiceRequest(this.db, {
      type: 'delete',
      userId,
      sla: slaConfigFrom(this.config.PRIVACY_SLA_JSON),
      retentionMonths: this.config.PRIVACY_RETENTION_MONTHS,
    });
    return result;
  }

  /**
   * #246 — the same erasure, addressable by user id, so the console does not
   * grow a second implementation. Two implementations of "erase this person"
   * drift, and the one that drifts is the one that leaves a table behind.
   */
  async deleteForUser(
    userId: string,
    by: { actorType: 'user' | 'admin'; actorId: string; reason?: string },
  ) {
    const enqueued = await this.db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      // ADR-0022: the picture leaves with the person. Read under the row lock
      // so a concurrent avatar change cannot slip a new key past the null below.
      const [before] = await tx
        .select({ avatarKey: schema.users.avatarKey })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('update')
        .limit(1);
      await tx
        .update(schema.users)
        .set({
          status: 'deleted',
          email: null,
          passwordHash: null,
          displayName: 'Người dùng đã xóa',
          avatarKey: null,
          homeAreaKey: null,
          homeAdministrativeArea: null,
          usualBudgetPerPerson: null,
          dateOfBirth: null,
          deletedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.users.id, userId));
      // The row is soft-deleted, so the cascade never fires; the interests go
      // by hand, like the push subscriptions below.
      await tx
        .delete(schema.userProfilePreferences)
        .where(eq(schema.userProfilePreferences.userId, userId));
      const cleanupIds = before?.avatarKey
        ? await this.cleanup.enqueue(tx, [
            { bucket: 'public', objectKey: before.avatarKey, reason: 'account_deleted' },
          ])
        : [];
      await tx
        .update(schema.authSessions)
        .set({ revokedAt: sql`now()`, revokeReason: 'account_deleted' })
        .where(
          and(
            eq(schema.authSessions.userId, userId),
            sql`${schema.authSessions.revokedAt} is null`,
          ),
        );
      await tx.delete(schema.deviceTokens).where(eq(schema.deviceTokens.userId, userId));
      // #515: the account is soft-deleted, so the cascade on `users` never
      // fires and the subscription rows have to go by hand. The audience
      // already excludes `status = 'deleted'`, so this is about not keeping
      // them rather than about delivery.
      await tx.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
      // ADR-0023 — what erasure keeps is a short, named list: the technical
      // account row, reviews, and photos contributed to a place. Everything
      // else this person accumulated is theirs and goes: what they saved, the
      // notifications addressed to them, and how they wanted to be notified.
      // These are personal records, not contributions, and nothing in the
      // product reads them for a deleted account.
      await tx.delete(schema.savedItems).where(eq(schema.savedItems.userId, userId));
      // ADR-0026: a reaction is a personal signal, not a contribution, and is not
      // on ADR-0023's retention list; the counts it added are derived and drop
      // with it.
      await tx.delete(schema.reviewReactions).where(eq(schema.reviewReactions.userId, userId));
      await tx
        .delete(schema.placeSubmissionContributors)
        .where(eq(schema.placeSubmissionContributors.userId, userId));
      // GoGo-BE#713 — GoGo AI history is personal data, not a contribution:
      // hard-deleted, with its sources, proposals and feedback.
      await eraseAssistantDataForUser(tx, userId);
      // Account erasure is a soft delete: FK cascades do not remove inbox state.
      // Match the read-all worker's lock order: operations before inbox rows.
      await tx
        .delete(schema.notificationReadOperations)
        .where(eq(schema.notificationReadOperations.userId, userId));
      await tx.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
      // ADR-0023: inviter profile snapshots are PII even in somebody else's
      // inbox or an already-published outbox event. Retain event/dedupe records
      // and every unrelated fact; absence selects the client's generic copy.
      // Capture and fan-out share-lock this account before writing snapshots.
      await tx.execute(sql`
        update outbox_events e set payload = jsonb_set(e.payload, '{notificationFacts}',
          (e.payload->'notificationFacts') - 'inviterName' - 'inviterAvatar')
        where e.payload->'notificationFacts'->>'_inviterMemberId' in (
          select id::text from room_members where user_id = ${userId}::uuid
        )
      `);
      await tx.execute(sql`
        update notifications n set payload = n.payload - 'inviterName' - 'inviterAvatar'
        where n.payload->>'_inviterMemberId' in (
          select id::text from room_members where user_id = ${userId}::uuid
        )
        or exists (
          -- Legacy inbox facts predate the private membership marker. Their
          -- retained outbox/dedupe evidence still identifies the inviter.
          select 1 from outbox_events e join room_members m
            on m.id::text = e.payload->>'inviterMemberId'
          where m.user_id = ${userId}::uuid and (
            n.dedupe_key = e.id::text
            or n.dedupe_key = 'outbox:' || e.id::text || ':' || n.user_id::text
          )
        )
      `);
      await tx
        .delete(schema.notificationInboxState)
        .where(eq(schema.notificationInboxState.userId, userId));
      await tx
        .delete(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.userId, userId));
      await tx
        .delete(schema.notificationCategoryPreferences)
        .where(eq(schema.notificationCategoryPreferences.userId, userId));
      await tx.execute(
        sql`delete from notification_push_deliveries where user_id = ${userId}::uuid`,
      );
      await tx
        .delete(schema.notificationSettings)
        .where(eq(schema.notificationSettings.userId, userId));
      // The membership row stays so a room still adds up for the people left
      // in it; only the name a co-member could read goes.
      await tx
        .update(schema.roomMembers)
        .set({ displayName: 'Đã rời' })
        .where(eq(schema.roomMembers.userId, userId));
      await writeAudit(tx, {
        actorType: by.actorType,
        actorId: by.actorId,
        action: 'user.account_deleted',
        resourceType: 'user',
        resourceId: userId,
        ...(by.reason ? { diff: { reason: by.reason } } : {}),
      });
      return cleanupIds;
    });
    // After the commit, never inside it: a provider call under a row lock is
    // the rule this codebase does not break. The worker retries what fails.
    await this.cleanup.attemptNow(enqueued);
    // GoGo-BE#256 — the status change above bumped the export epoch, and the
    // trigger revoked every live export in the same transaction. Their bytes
    // go now when this process has the bucket; otherwise the cleanup stays due
    // and the worker sweep deletes them (S-F-13: never "confirmed" by a fake).
    if (this.privateStorage) {
      const revoked = await this.db
        .select({ id: schema.privacyExportArtifacts.id })
        .from(schema.privacyExportArtifacts)
        .where(
          and(
            eq(schema.privacyExportArtifacts.subjectUserId, userId),
            isNull(schema.privacyExportArtifacts.cleanedAt),
            sql`${schema.privacyExportArtifacts.cleanupDueAt} is not null`,
          ),
        );
      await cleanupDueArtifacts(this.db, this.privateStorage, {
        ids: revoked.map((r) => r.id),
      }).catch(() => undefined);
    }
    return { deleted: true };
  }

  // --- notification settings (ADR-0050) -------------------------

  /** Account master plus five independent, remembered category choices. */
  async getNotificationSettings(actor: Actor): Promise<NotificationSettingsView> {
    return this.notificationSettingsFor(requireUser(actor));
  }

  async setNotificationSettings(
    actor: Actor,
    input: { pushEnabled: boolean },
  ): Promise<NotificationSettingsView> {
    return mutateNotificationSettings(this.db, requireUser(actor), input, { legacyPut: true });
  }

  async patchNotificationSettings(
    actor: Actor,
    input: SettingsPatch,
    ifMatch: string | undefined,
    scope: IdempotencyScope,
  ) {
    return mutateNotificationSettings(this.db, requireUser(actor), input, {
      ...(ifMatch === undefined ? {} : { ifMatch }),
      scope,
    });
  }

  private notificationSettingsFor(userId: string): Promise<NotificationSettingsView> {
    return readNotificationSettings(this.db, userId);
  }

  // --- legacy per-kind preferences (FR-USER-004, older clients) -------------

  /**
   * ADR-0050: legacy clients see each kind's effective push permission.
   * Configured category choices stay separate from master suspension.
   * Email rows come back as stored.
   */
  async getNotificationPreferences(actor: Actor) {
    const userId = requireUser(actor);
    const [settings, rows] = await Promise.all([
      this.notificationSettingsFor(userId),
      this.db
        .select()
        .from(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.userId, userId)),
    ]);
    return [
      ...LEGACY_PUSH_KINDS.map((kind) => ({
        channel: 'push' as const,
        kind,
        enabled: effectivePush(kind, settings.pushEnabled, settings.categories),
      })),
      ...rows
        .filter((r) => r.channel === 'email')
        .map((r) => ({ channel: r.channel, kind: r.kind, enabled: r.enabled })),
    ];
  }

  /**
   * An older client can still write one kind. The row is kept — a rollback
   * reads it — but only an opt-out moves push: "stop sending me this" can only
   * be honoured now by stopping push, while "send me this" does not say the
   * person wants every other kind too. Turning push back on is the switch's job.
   */
  async setNotificationPreference(
    actor: Actor,
    input: { channel: 'push' | 'email'; kind: string; enabled: boolean },
  ) {
    const userId = requireUser(actor);
    if (input.channel === 'email') await mutateNotificationEmail(this.db, userId, input);
    else
      await mutateNotificationSettings(
        this.db,
        userId,
        input.enabled ? {} : { pushEnabled: false },
        { source: 'legacy', legacyOptIn: input.enabled },
      );
    return { updated: true };
  }
}
