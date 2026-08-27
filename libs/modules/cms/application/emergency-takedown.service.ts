import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { writeOutbox } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import type { AdminRole } from './admin-auth.service';

/**
 * SEC-001 — emergency takedown (break-glass), deliberately asymmetric.
 *
 * Normal writes stay with the role that owns them, which is right until nobody
 * who owns them is awake. Without an escape hatch the practical outcome is that
 * everyone shares the `super_admin` account, and a shared account collapses the
 * audit trail into a single identity — losing exactly what RBAC exists to give.
 *
 * So the hatch is narrow rather than absent: **taking content down** is open to
 * any active admin, because it is reversible and reduces harm. **Putting it
 * back up** — restore, publish, activate — keeps its usual privileged role. Wrongly
 * suspending costs five minutes of an editor's time; wrongly publishing has
 * already reached users.
 *
 * Not included on purpose: delete and archive (side effects that do not undo
 * cleanly), ranking configs and feature flags (ops-only config, and ops is
 * usually the one on call anyway).
 */
export type TakedownActor = { id: string; role: AdminRole };

@Injectable()
export class EmergencyTakedownService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /** `published → suspended`. Any other current state is refused, not coerced. */
  async suspendPlace(actor: TakedownActor, placeId: string, reason: string) {
    const [place] = await this.db
      .select({ id: schema.places.id, status: schema.places.status })
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
    if (place.status !== 'published') {
      // Break-glass covers exactly one transition. Anything else is ordinary
      // catalog work and belongs to the role that owns it.
      throw AppError.conflict(
        'NOT_TAKEDOWNABLE',
        `Emergency takedown applies to published places only (is ${place.status})`,
      );
    }

    await this.db
      .update(schema.places)
      .set({ status: 'suspended', updatedAt: sql`now()` })
      .where(eq(schema.places.id, placeId));

    // Search and suggestion read `status` live today, so the place leaves
    // discovery on the next query. The event is emitted anyway: the moment an
    // external index exists (SE-009), a takedown that only wrote a row would
    // silently stop working.
    await writeOutbox(this.db, {
      eventType: 'place.updated',
      resourceType: 'place',
      resourceId: placeId,
      payload: { reason: 'emergency_takedown' },
    });

    await this.record(actor, {
      action: 'place.emergency_suspended',
      resourceType: 'place',
      resourceId: placeId,
      from: place.status,
      to: 'suspended',
      reason,
    });
    return { id: placeId, status: 'suspended' as const };
  }

  /** `published → hidden`. */
  async hideReview(actor: TakedownActor, reviewId: string, reason: string) {
    const [review] = await this.db
      .select({ id: schema.reviews.id, status: schema.reviews.status })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId))
      .limit(1);
    if (!review) throw AppError.notFound('REVIEW_NOT_FOUND', 'Review not found');
    if (review.status !== 'published') {
      throw AppError.conflict(
        'NOT_TAKEDOWNABLE',
        `Emergency takedown applies to published reviews only (is ${review.status})`,
      );
    }

    await this.db
      .update(schema.reviews)
      .set({ status: 'hidden', moderationReason: reason, updatedAt: sql`now()` })
      .where(eq(schema.reviews.id, reviewId));

    await this.record(actor, {
      action: 'review.emergency_hidden',
      resourceType: 'review',
      resourceId: reviewId,
      from: review.status,
      to: 'hidden',
      reason,
    });
    return { id: reviewId, status: 'hidden' as const };
  }

  /** `moderation: approved|pending → hidden`. */
  async hideCheckin(actor: TakedownActor, checkinId: string, reason: string) {
    const [checkin] = await this.db
      .select({ id: schema.stopCheckins.id, moderation: schema.stopCheckins.moderation })
      .from(schema.stopCheckins)
      .where(eq(schema.stopCheckins.id, checkinId))
      .limit(1);
    if (!checkin) throw AppError.notFound('CHECKIN_NOT_FOUND', 'Check-in not found');
    if (checkin.moderation === 'hidden') {
      throw AppError.conflict('NOT_TAKEDOWNABLE', 'Check-in is already hidden');
    }

    await this.db
      .update(schema.stopCheckins)
      .set({ moderation: 'hidden', updatedAt: sql`now()` })
      .where(eq(schema.stopCheckins.id, checkinId));

    await this.record(actor, {
      action: 'checkin.emergency_hidden',
      resourceType: 'stop_checkin',
      resourceId: checkinId,
      from: checkin.moderation,
      to: 'hidden',
      reason,
    });
    return { id: checkinId, moderation: 'hidden' as const };
  }

  /**
   * One audit row and one metric per takedown. `writeAudit` supplies the
   * request id and the staff IP from the request context (BE-IMP-007), so the
   * record answers who, from where, when, why, and what changed.
   *
   * The metric is the alerting hook: break-glass must page, not sit in a
   * dashboard nobody opens until the next audit.
   */
  private async record(
    actor: TakedownActor,
    input: {
      action: string;
      resourceType: string;
      resourceId: string;
      from: string;
      to: string;
      reason: string;
    },
  ): Promise<void> {
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: actor.id,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      diff: {
        breakGlass: true,
        role: actor.role,
        reason: input.reason,
        before: { status: input.from },
        after: { status: input.to },
      },
    });
    this.metrics.increment('cms_emergency_takedown_total', {
      resource_type: input.resourceType,
      role: actor.role,
    });
  }
}
