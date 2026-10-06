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
import { pushAllowed } from '../../notifications/application/push-preference';
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

/** The kinds the per-kind contract (`NotificationKind`) exposes; campaigns never had a toggle. */
const LEGACY_PUSH_KINDS = [
  'invite',
  'preference_reminder',
  'plan_ready',
  'plan_changed',
  'date_reminder',
  'moderation_update',
] as const;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * One account's notification writes run one at a time. The switch and the
 * per-kind rows below must agree when a transaction commits; two writers
 * interleaving could otherwise leave the switch off and a per-kind row on.
 * `for no key update` does not block the foreign-key checks of rows that
 * reference the account (inbox, subscriptions).
 */
async function lockNotificationChoices(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select 1 from users where id = ${userId}::uuid for no key update`);
}

/**
 * ADR-0025, rollback compatibility. The release before the switch decides push
 * from per-kind `push` rows alone: the outbox skips a kind whose row is off, and
 * campaigns skip a `campaign` row that is off. Writing the switch's value into
 * every kind's row, campaign included, means a rolled-back release pushes to
 * this account exactly when this release does. This release ignores these rows
 * once a switch row exists, so they cannot override the switch here.
 */
async function mirrorPushChoice(tx: Tx, userId: string, enabled: boolean): Promise<void> {
  await tx
    .insert(schema.notificationPreferences)
    .values(
      schema.notificationKind.enumValues.map((kind) => ({
        userId,
        channel: 'push' as const,
        kind,
        enabled,
      })),
    )
    .onConflictDoUpdate({
      target: [
        schema.notificationPreferences.userId,
        schema.notificationPreferences.channel,
        schema.notificationPreferences.kind,
      ],
      set: { enabled },
    });
}

export type { NotificationSettingsView };

export function requireUser(actor: Actor): string {
  if (actor.type !== 'user') {
    throw AppError.forbidden('USER_ONLY', 'Register an account to use this feature');
  }
  return actor.id;
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
    const areas = await this.savedAreas(
      rows.filter((r) => r.targetType === 'place').map((r) => r.targetId),
      rows.filter((r) => r.targetType === 'plan').map((r) => r.targetId),
    );
    return rows.map((r) => ({
      targetType: r.targetType,
      targetId: r.targetId,
      savedAt: r.createdAt.toISOString(),
      area: areas.get(`${r.targetType}:${r.targetId}`) ?? UNKNOWN_AREA,
    }));
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
    return { id: row!.id, status: row!.status };
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
    return { id: updated!.id, status: updated!.status };
  }

  async myReviews(actor: Actor) {
    const userId = requireUser(actor);
    const rows = await this.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.userId, userId))
      .orderBy(desc(schema.reviews.createdAt));
    return rows.map((r) => ({
      id: r.id,
      placeId: r.placeId ?? undefined,
      planId: r.planId ?? undefined,
      rating: r.rating,
      text: r.text ?? undefined,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
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
      await tx.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
      await tx
        .delete(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.userId, userId));
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

  // --- notification settings (NTF-BE-014, ADR-0025) -------------------------

  /** The one app-level push switch for this account. */
  async getNotificationSettings(actor: Actor): Promise<NotificationSettingsView> {
    return this.notificationSettingsFor(requireUser(actor));
  }

  async setNotificationSettings(
    actor: Actor,
    input: { pushEnabled: boolean },
  ): Promise<NotificationSettingsView> {
    const userId = requireUser(actor);
    await this.db.transaction(async (tx) => {
      await lockNotificationChoices(tx, userId);
      await tx
        .insert(schema.notificationSettings)
        .values({ userId, pushEnabled: input.pushEnabled, source: 'explicit' })
        .onConflictDoUpdate({
          target: schema.notificationSettings.userId,
          set: { pushEnabled: input.pushEnabled, source: 'explicit', updatedAt: sql`now()` },
        });
      await mirrorPushChoice(tx, userId, input.pushEnabled);
    });
    return this.notificationSettingsFor(userId);
  }

  private notificationSettingsFor(userId: string): Promise<NotificationSettingsView> {
    return readNotificationSettings(this.db, userId);
  }

  // --- legacy per-kind preferences (FR-USER-004, older clients) -------------

  /**
   * ADR-0025: push is one switch now, so every push kind reads as that switch.
   * An older client showing a kind as on while nothing is pushed would be
   * telling the person something untrue. Email rows come back as stored.
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
        enabled: settings.pushEnabled,
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
    await this.db.transaction(async (tx) => {
      await lockNotificationChoices(tx, userId);
      const row = {
        userId,
        channel: input.channel,
        kind: input.kind as never,
        enabled: input.enabled,
      };
      const upsertRow = () =>
        tx
          .insert(schema.notificationPreferences)
          .values(row)
          .onConflictDoUpdate({
            target: [
              schema.notificationPreferences.userId,
              schema.notificationPreferences.channel,
              schema.notificationPreferences.kind,
            ],
            set: { enabled: input.enabled },
          });

      if (input.channel === 'email') {
        await upsertRow();
        return;
      }
      if (!input.enabled) {
        await tx
          .insert(schema.notificationSettings)
          .values({ userId, pushEnabled: false, source: 'legacy' })
          .onConflictDoUpdate({
            target: schema.notificationSettings.userId,
            set: { pushEnabled: false, source: 'legacy', updatedAt: sql`now()` },
          });
        await mirrorPushChoice(tx, userId, false);
        return;
      }
      // A push opt-in is stored only while push is allowed. Stored while push is
      // off, it would make a rolled-back release push a kind this release does
      // not — the one outcome ADR-0025 rules out.
      const { rows } = await tx.execute(
        sql`select ${pushAllowed(sql`${userId}::uuid`)} as allowed`,
      );
      if ((rows[0] as { allowed: boolean }).allowed) await upsertRow();
    });
    return { updated: true };
  }
}
