import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeOutbox } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import { APP_CONFIG, type PrivacyLedgerConfig } from '../../shared/config';
import { recordSelfServiceRequest, slaConfigFrom } from '../../shared/privacy-ledger';
import { pgArray } from '../../search/infrastructure/search.repository';
import type { Actor } from '../../identity/domain/actor';
import { writeAudit } from '../../shared/audit';
import { MediaCleanupService } from '../../profile/application/media-cleanup.service';

function requireUser(actor: Actor): string {
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
    @Inject(APP_CONFIG) private readonly config: PrivacyLedgerConfig,
    private readonly cleanup: MediaCleanupService,
  ) {}

  // --- saved (FR-USER-001) --------------------------------------------------

  async listSaved(actor: Actor) {
    const userId = requireUser(actor);
    const rows = await this.db
      .select()
      .from(schema.savedItems)
      .where(eq(schema.savedItems.userId, userId))
      .orderBy(desc(schema.savedItems.createdAt));
    return rows.map((r) => ({
      targetType: r.targetType,
      targetId: r.targetId,
      savedAt: r.createdAt.toISOString(),
    }));
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
  async exportForUser(
    userId: string,
    by: { actorType: 'user' | 'admin'; actorId: string; reason?: string },
  ) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    const memberships = await this.db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.userId, userId));
    const memberIds = memberships.map((m) => m.id);
    const preferences =
      memberIds.length > 0
        ? await this.db
            .select()
            .from(schema.preferenceSelections)
            .where(
              sql`${schema.preferenceSelections.memberId} = any((${pgArray(memberIds)})::uuid[])`,
            )
        : [];
    const votes =
      memberIds.length > 0
        ? await this.db
            .select()
            .from(schema.votes)
            .where(sql`${schema.votes.memberId} = any((${pgArray(memberIds)})::uuid[])`)
        : [];
    const saved = await this.db
      .select()
      .from(schema.savedItems)
      .where(eq(schema.savedItems.userId, userId));
    const reviews = await this.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.userId, userId));

    await writeAudit(this.db, {
      actorType: by.actorType,
      actorId: by.actorId,
      action: 'user.data_exported',
      resourceType: 'user',
      resourceId: userId,
      ...(by.reason ? { diff: { reason: by.reason } } : {}),
    });

    return {
      exportedAt: new Date().toISOString(),
      profile: {
        displayName: user?.displayName,
        email: user?.email,
        locale: user?.locale,
        createdAt: user?.createdAt.toISOString(),
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
    };
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
          deletedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.users.id, userId));
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
    return { deleted: true };
  }

  // --- notification preferences (FR-USER-004) ------------------------------

  async getNotificationPreferences(actor: Actor) {
    const userId = requireUser(actor);
    const rows = await this.db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, userId));
    return rows.map((r) => ({ channel: r.channel, kind: r.kind, enabled: r.enabled }));
  }

  async setNotificationPreference(
    actor: Actor,
    input: { channel: 'push' | 'email'; kind: string; enabled: boolean },
  ) {
    const userId = requireUser(actor);
    await this.db
      .insert(schema.notificationPreferences)
      .values({ userId, channel: input.channel, kind: input.kind as never, enabled: input.enabled })
      .onConflictDoUpdate({
        target: [
          schema.notificationPreferences.userId,
          schema.notificationPreferences.channel,
          schema.notificationPreferences.kind,
        ],
        set: { enabled: input.enabled },
      });
    return { updated: true };
  }
}
