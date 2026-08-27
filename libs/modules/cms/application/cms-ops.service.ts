import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { SCORING_WEIGHT_BOUNDS } from '../../suggestions/domain/types';

/** CMS-007/008/009/010 — moderation, ranking console, imports, ops KPIs. */
@Injectable()
export class CmsOpsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async audit(
    adminId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    diff?: unknown,
  ) {
    await this.db.insert(schema.auditLogs).values({
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType,
      resourceId,
      diff,
    });
  }

  // --- moderation queue (CMS-007, FR-CMS-005) ------------------------------

  async moderationQueue(limit: number) {
    const reviews = await this.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.status, 'pending'))
      .orderBy(desc(schema.reviews.createdAt))
      .limit(limit);
    const reports = await this.db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.status, 'open'))
      .orderBy(desc(schema.reports.createdAt))
      .limit(limit);
    const checkins = await this.db
      .select()
      .from(schema.stopCheckins)
      .where(eq(schema.stopCheckins.moderation, 'pending'))
      .orderBy(desc(schema.stopCheckins.createdAt))
      .limit(limit);
    const communityPlaces = await this.db
      .select({
        id: schema.places.id,
        name: schema.places.name,
        createdAt: schema.places.createdAt,
      })
      .from(schema.places)
      .where(eq(schema.places.status, 'community_submitted'))
      .limit(limit);
    return {
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        text: r.text,
        createdAt: r.createdAt.toISOString(),
      })),
      reports: reports.map((r) => ({
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        reasonCode: r.reasonCode,
      })),
      checkins: checkins.map((c) => ({
        id: c.id,
        rating: c.rating,
        note: c.note,
        photoCount: c.photoKeys.length,
        hasBill: c.billTotal !== null,
      })),
      communityPlaces,
    };
  }

  /** Decision reason is mandatory and audited (FR-CMS-005). */
  async decideReview(
    adminId: string,
    reviewId: string,
    decision: 'published' | 'rejected',
    reason: string,
  ) {
    const [row] = await this.db
      .update(schema.reviews)
      .set({
        status: decision,
        moderatedByAdminId: adminId,
        moderationReason: reason,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.reviews.id, reviewId))
      .returning();
    if (!row) throw AppError.notFound('REVIEW_NOT_FOUND', 'Review not found');
    await this.audit(adminId, 'review.moderated', 'review', reviewId, { decision, reason });
    return { id: reviewId, status: decision };
  }

  async decideCheckin(
    adminId: string,
    checkinId: string,
    decision: 'approved' | 'rejected',
    reason: string,
  ) {
    const [row] = await this.db
      .update(schema.stopCheckins)
      .set({ moderation: decision, updatedAt: sql`now()` })
      .where(eq(schema.stopCheckins.id, checkinId))
      .returning();
    if (!row) throw AppError.notFound('CHECKIN_NOT_FOUND', 'Check-in not found');
    await this.audit(adminId, 'checkin.moderated', 'stop_checkin', checkinId, { decision, reason });
    return { id: checkinId, moderation: decision };
  }

  async decideReport(
    adminId: string,
    reportId: string,
    decision: 'actioned' | 'dismissed',
    reason: string,
  ) {
    const [row] = await this.db
      .update(schema.reports)
      .set({
        status: decision,
        decidedByAdminId: adminId,
        decisionReason: reason,
        decidedAt: sql`now()`,
      })
      .where(eq(schema.reports.id, reportId))
      .returning();
    if (!row) throw AppError.notFound('REPORT_NOT_FOUND', 'Report not found');
    await this.audit(adminId, 'report.decided', 'report', reportId, { decision, reason });
    return { id: reportId, status: decision };
  }

  // --- ranking configs + flags (CMS-008, FR-CMS-006/007) -------------------

  async createRankingConfig(
    adminId: string,
    input: { key: string; weights: Record<string, number> },
  ) {
    // Bounds are part of the config row so the engine can re-validate.
    const bounds =
      input.key === 'suggestion.scoring'
        ? SCORING_WEIGHT_BOUNDS
        : Object.fromEntries(Object.keys(input.weights).map((k) => [k, { min: 0, max: 1 }]));
    for (const [k, v] of Object.entries(input.weights)) {
      const b = (bounds as Record<string, { min: number; max: number }>)[k];
      if (!b) {
        throw AppError.badRequest('UNKNOWN_WEIGHT', `Unknown weight: ${k}`);
      }
      if (v < b.min || v > b.max) {
        throw AppError.badRequest('WEIGHT_OUT_OF_BOUNDS', `${k} must be in [${b.min}, ${b.max}]`);
      }
    }
    const [{ maxVersion }] = (await this.db
      .select({ maxVersion: sql<number>`coalesce(max(version), 0)::int` })
      .from(schema.rankingConfigs)
      .where(eq(schema.rankingConfigs.key, input.key))) as [{ maxVersion: number }];
    const [row] = await this.db
      .insert(schema.rankingConfigs)
      .values({
        key: input.key,
        version: maxVersion + 1,
        weights: input.weights,
        bounds: bounds as Record<string, { min: number; max: number }>,
        createdByAdminId: adminId,
      })
      .returning();
    await this.audit(adminId, 'ranking_config.created', 'ranking_config', row!.id, input);
    return { id: row!.id, version: row!.version, status: row!.status };
  }

  /** Four-eyes: approver must differ from creator (FR-CMS-007). */
  async approveRankingConfig(adminId: string, configId: string) {
    const [config] = await this.db
      .select()
      .from(schema.rankingConfigs)
      .where(eq(schema.rankingConfigs.id, configId))
      .limit(1);
    if (!config) throw AppError.notFound('CONFIG_NOT_FOUND', 'Config not found');
    if (config.status !== 'draft')
      throw AppError.conflict('NOT_DRAFT', 'Only drafts can be approved');
    if (config.createdByAdminId === adminId) {
      throw AppError.forbidden('SELF_APPROVAL', 'A different admin must approve');
    }
    await this.db
      .update(schema.rankingConfigs)
      .set({ status: 'approved', approvedByAdminId: adminId })
      .where(eq(schema.rankingConfigs.id, configId));
    await this.audit(adminId, 'ranking_config.approved', 'ranking_config', configId);
    return { id: configId, status: 'approved' };
  }

  async activateRankingConfig(adminId: string, configId: string) {
    const [config] = await this.db
      .select()
      .from(schema.rankingConfigs)
      .where(eq(schema.rankingConfigs.id, configId))
      .limit(1);
    if (!config) throw AppError.notFound('CONFIG_NOT_FOUND', 'Config not found');
    if (config.status !== 'approved') {
      throw AppError.conflict('NOT_APPROVED', 'Approve before activating');
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.rankingConfigs)
        .set({ status: 'rolled_back' })
        .where(
          sql`${schema.rankingConfigs.key} = ${config.key} and ${schema.rankingConfigs.status} = 'active'`,
        );
      await tx
        .update(schema.rankingConfigs)
        .set({ status: 'active', activatedAt: sql`now()` })
        .where(eq(schema.rankingConfigs.id, configId));
    });
    await this.audit(adminId, 'ranking_config.activated', 'ranking_config', configId, {
      key: config.key,
      version: config.version,
    });
    return { id: configId, status: 'active' };
  }

  /** Rollback = deactivate current active; engine falls back to defaults. */
  async rollbackRankingConfig(adminId: string, key: string) {
    const rows = await this.db
      .update(schema.rankingConfigs)
      .set({ status: 'rolled_back' })
      .where(
        sql`${schema.rankingConfigs.key} = ${key} and ${schema.rankingConfigs.status} = 'active'`,
      )
      .returning();
    await this.audit(adminId, 'ranking_config.rolled_back', 'ranking_config', key);
    return { rolledBack: rows.length > 0 };
  }

  async setFeatureFlag(adminId: string, key: string, enabled: boolean, payload?: unknown) {
    await this.db
      .insert(schema.featureFlags)
      .values({ key, enabled, payload: payload ?? null, updatedByAdminId: adminId })
      .onConflictDoUpdate({
        target: schema.featureFlags.key,
        set: {
          enabled,
          payload: payload ?? null,
          updatedByAdminId: adminId,
          updatedAt: sql`now()`,
        },
      });
    await this.audit(adminId, 'feature_flag.set', 'feature_flag', key, { enabled });
    return { key, enabled };
  }

  // --- ops KPIs (CMS-010, FR-CMS-010) --------------------------------------

  async kpis() {
    const one = async <T>(q: ReturnType<typeof sql>): Promise<T> => {
      const res = await this.db.execute(q);
      return res.rows[0] as T;
    };
    const freshness = await one<{ fresh: number; stale: number; unknown: number }>(sql`
      select
        count(*) filter (where freshness_checked_at > now() - interval '30 days')::int as fresh,
        count(*) filter (where freshness_checked_at <= now() - interval '30 days')::int as stale,
        count(*) filter (where freshness_checked_at is null)::int as unknown
      from places where status = 'published'
    `);
    const zeroResults = await one<{ n: number }>(sql`
      select count(*)::int as n from outbox_events
      where event_type = 'search.zero_result' and occurred_at > now() - interval '7 days'
    `);
    const suggestionRuns = await one<{ succeeded: number; failed: number }>(sql`
      select
        count(*) filter (where status = 'succeeded')::int as succeeded,
        count(*) filter (where status = 'failed')::int as failed
      from suggestion_runs where created_at > now() - interval '7 days'
    `);
    const budgetViolations = await one<{ n: number }>(sql`
      select count(*)::int as n from plans
      where status = 'current' and (totals ->> 'overBudget')::boolean = true
    `);
    const providerErrors = await one<{ n: number }>(sql`
      select count(*)::int as n from place_imports
      where reason_code = 'PROVIDER_ERROR' and created_at > now() - interval '7 days'
    `);
    const moderationBacklog = await one<{ reviews: number; reports: number }>(sql`
      select
        (select count(*)::int from reviews where status = 'pending') as reviews,
        (select count(*)::int from reports where status = 'open') as reports
    `);
    return {
      placeFreshness: freshness,
      zeroResultsLast7d: zeroResults.n,
      suggestionRunsLast7d: suggestionRuns,
      currentPlansOverBudget: budgetViolations.n,
      providerErrorsLast7d: providerErrors.n,
      moderationBacklog,
    };
  }
}
