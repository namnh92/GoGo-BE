import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { writeOutbox } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { PlaceDedupService } from './place-dedup.service';
import { PlaceResolverService } from './place-resolver.service';

export type ResolveLinkResponse = {
  status: 'RESOLVED' | 'ALREADY_EXISTS' | 'CANDIDATE_SELECTION' | 'UNRESOLVED';
  matchConfidence?: number | undefined;
  reasonCodes: string[];
  existingPlaceId?: string | undefined;
  candidate?: {
    googlePlaceId: string;
    name: string;
    address: string;
    location: { lat: number; lng: number };
    googleRating: number | null;
    googleRatingCount: number;
    googleScore: number | null;
    businessStatus: string;
    source: 'google_places';
    fetchedAt: string;
    attributions: string[];
  };
  candidates?:
    { googlePlaceId: string; name: string; address: string; confidence: number }[] | undefined;
};

/**
 * PI-BE-018/019/020 — Mobile add-by-link. Resolve is preview-only; submitting
 * creates at most one pending proposal per provider place (FR-INGEST-010/012)
 * and never publishes to the catalog.
 */
@Injectable()
export class PlaceSubmissionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly resolver: PlaceResolverService,
    private readonly dedup: PlaceDedupService,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async resolveLink(input: {
    url: string;
    cityHint?: string | undefined;
  }): Promise<ResolveLinkResponse> {
    const outcome = await this.resolver.resolveFromUrl(input.url, { city: input.cityHint });

    if (outcome.status === 'UNRESOLVED') {
      return { status: 'UNRESOLVED', reasonCodes: [outcome.reasonCode] };
    }
    if (outcome.status === 'NEEDS_CONFIRMATION') {
      return {
        status: 'CANDIDATE_SELECTION',
        reasonCodes: outcome.decision.reasons,
        matchConfidence: outcome.decision.best?.confidence,
        candidates: outcome.decision.candidates.map((c) => ({
          googlePlaceId: c.target.googlePlaceId,
          name: c.target.name,
          address: c.target.address,
          confidence: c.confidence,
        })),
      };
    }

    const details = outcome.details;
    const verdict = await this.dedup.check(details);
    const score = await this.resolver.scoreFor(details, input.cityHint ?? null, null);
    const candidate = this.toCandidate(details, score);

    if (verdict.kind === 'LINKED_EXISTING') {
      // Existing place opens Place Detail instead of creating a duplicate.
      return {
        status: 'ALREADY_EXISTS',
        existingPlaceId: verdict.placeId,
        matchConfidence: outcome.decision.best?.confidence,
        reasonCodes: outcome.decision.reasons,
        candidate,
      };
    }
    return {
      status: 'RESOLVED',
      matchConfidence: outcome.decision.best?.confidence,
      reasonCodes: outcome.decision.reasons,
      candidate,
      ...(verdict.kind === 'MERGE_CANDIDATE' ? { existingPlaceId: verdict.placeId } : {}),
    };
  }

  private toCandidate(details: ResolvedProviderPlace, score: number) {
    return {
      googlePlaceId: details.providerPlaceId,
      name: details.name,
      address: details.addressText,
      location: { lat: details.lat, lng: details.lng },
      googleRating: details.rating,
      googleRatingCount: details.ratingCount,
      googleScore: score,
      businessStatus: details.businessStatus,
      source: 'google_places' as const,
      fetchedAt: new Date().toISOString(),
      attributions: [details.attribution],
    };
  }

  /** FR-INGEST-011/012 — proposal only; publishing stays with CMS. */
  async submit(
    actor: Actor,
    input: {
      googlePlaceId: string;
      roomId?: string | undefined;
      categoryKey?: string | undefined;
      priceMin?: number | undefined;
      priceMax?: number | undefined;
      priceUnit?: string | undefined;
      vibeKeys?: string[] | undefined;
      note?: string | undefined;
    },
  ) {
    if (actor.type === 'guest' && !input.roomId) {
      throw AppError.forbidden('ROOM_SCOPE_REQUIRED', 'Guests submit within their room only');
    }
    if (actor.type === 'guest' && input.roomId && actor.roomId !== input.roomId) {
      throw AppError.forbidden('ROOM_SCOPE_VIOLATION', 'Guest session is bound to another room');
    }

    const details = await this.resolver
      .resolveFromUrl(`https://www.google.com/maps?place_id=${input.googlePlaceId}`)
      .catch(() => null);
    if (!details || details.status !== 'RESOLVED') {
      throw AppError.badRequest('PLACE_NOT_FOUND', 'Provider place could not be verified');
    }
    if (details.details.businessStatus !== 'OPERATIONAL') {
      throw AppError.conflict('PLACE_CLOSED', 'Place is closed and cannot be added');
    }

    const verdict = await this.dedup.check(details.details);
    if (verdict.kind === 'LINKED_EXISTING') {
      return { status: 'ALREADY_EXISTS' as const, placeId: verdict.placeId };
    }

    // Same provider id from many users bumps the counter, never a new draft.
    const [existing] = await this.db
      .select()
      .from(schema.placeSubmissions)
      .where(
        sql`${schema.placeSubmissions.googlePlaceId} = ${input.googlePlaceId} and ${schema.placeSubmissions.status} = 'pending'`,
      )
      .limit(1);
    if (existing) {
      await this.db
        .update(schema.placeSubmissions)
        .set({ submissionCount: sql`${schema.placeSubmissions.submissionCount} + 1` })
        .where(eq(schema.placeSubmissions.id, existing.id));
      this.metrics.increment('mobile_place_submissions_total', { status: 'deduped' });
      return { status: 'PENDING' as const, submissionId: existing.id, deduped: true };
    }

    const [row] = await this.db
      .insert(schema.placeSubmissions)
      .values({
        googlePlaceId: input.googlePlaceId,
        ...(actor.type === 'user'
          ? { submittedByUserId: actor.id }
          : { submittedByGuestSessionId: actor.id }),
        roomId: input.roomId ?? null,
        categoryKey: input.categoryKey ?? null,
        priceMin: input.priceMin ?? null,
        priceMax: input.priceMax ?? null,
        priceUnit: input.priceUnit ?? null,
        vibeKeys: input.vibeKeys ?? [],
        note: input.note ?? null,
      })
      .returning();
    this.metrics.increment('mobile_place_submissions_total', { status: 'pending' });
    await writeOutbox(this.db, {
      eventType: 'place.submission_created',
      resourceType: 'place_submission',
      resourceId: row!.id,
      payload: { googlePlaceId: input.googlePlaceId },
    });
    return { status: 'PENDING' as const, submissionId: row!.id, deduped: false };
  }

  async getSubmission(actor: Actor, id: string) {
    const [row] = await this.db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, id))
      .limit(1);
    if (!row) throw AppError.notFound('SUBMISSION_NOT_FOUND', 'Submission not found');
    const owner =
      (actor.type === 'user' && row.submittedByUserId === actor.id) ||
      (actor.type === 'guest' && row.submittedByGuestSessionId === actor.id);
    if (!owner) throw AppError.forbidden();
    return {
      id: row.id,
      status: row.status,
      googlePlaceId: row.googlePlaceId,
      placeId: row.resultPlaceId ?? undefined,
      submissionCount: row.submissionCount,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString(),
    };
  }

  /** CMS moderation (PI-CMS-007 backend half). */
  async decide(
    adminId: string,
    id: string,
    decision: 'approved' | 'rejected' | 'merged',
    reason: string,
    mergeIntoPlaceId?: string,
  ) {
    const [row] = await this.db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, id))
      .limit(1);
    if (!row) throw AppError.notFound('SUBMISSION_NOT_FOUND', 'Submission not found');
    if (row.status !== 'pending') {
      throw AppError.conflict('ALREADY_DECIDED', 'Submission already decided');
    }

    let resultPlaceId: string | null = row.resultPlaceId;
    if (decision === 'approved') {
      resultPlaceId = await this.createDraftFromSubmission(row);
    } else if (decision === 'merged') {
      if (!mergeIntoPlaceId) {
        throw AppError.badRequest('MERGE_TARGET_REQUIRED', 'mergeIntoPlaceId is required');
      }
      resultPlaceId = mergeIntoPlaceId;
      await this.dedup.emitReindex(mergeIntoPlaceId, 'merged');
    }

    await this.db
      .update(schema.placeSubmissions)
      .set({
        status: decision,
        decidedByAdminId: adminId,
        decisionReason: reason,
        decidedAt: sql`now()`,
        resultPlaceId,
      })
      .where(eq(schema.placeSubmissions.id, id));
    await this.db.insert(schema.auditLogs).values({
      actorType: 'admin',
      actorId: adminId,
      action: 'place_submission.decided',
      resourceType: 'place_submission',
      resourceId: id,
      diff: { decision, reason, resultPlaceId },
    });
    this.metrics.increment('mobile_place_submissions_total', { status: decision });
    // How long a proposal waited before an editor acted on it (spec §13).
    this.metrics.observe(
      'place_submission_publish_latency_hours',
      (Date.now() - row.createdAt.getTime()) / 3_600_000,
      { decision },
    );
    await writeOutbox(this.db, {
      eventType: 'place.submission_decided',
      resourceType: 'place_submission',
      resourceId: id,
      payload: { decision, resultPlaceId },
    });
    return { id, status: decision, placeId: resultPlaceId ?? undefined };
  }

  private async createDraftFromSubmission(
    row: typeof schema.placeSubmissions.$inferSelect,
  ): Promise<string> {
    const outcome = await this.resolver.resolveFromUrl(
      `https://www.google.com/maps?place_id=${row.googlePlaceId}`,
    );
    if (outcome.status !== 'RESOLVED') {
      throw AppError.conflict('PROVIDER_UNAVAILABLE', 'Cannot verify provider place right now');
    }
    const d = outcome.details;
    const score = await this.resolver.scoreFor(d, null, row.categoryKey);

    return this.db
      .transaction(async (tx) => {
        const [place] = await tx
          .insert(schema.places)
          .values({
            name: d.name,
            nameNormalized: 'set-by-trigger',
            status: 'community_submitted',
            geom: { x: d.lng, y: d.lat },
            addressText: d.addressText,
            rating: d.rating !== null ? d.rating.toFixed(2) : null,
            ratingCount: d.ratingCount,
            priceLevel: d.priceLevel,
            confidence: '0.60',
            freshnessCheckedAt: new Date(),
          })
          .returning();
        for (const h of d.hours) {
          await tx.insert(schema.placeHours).values({
            placeId: place!.id,
            dayOfWeek: h.dayOfWeek,
            openMinute: h.openMinute,
            closeMinute: h.closeMinute,
            isOvernight: h.isOvernight,
            source: 'provider',
            verifiedAt: new Date(),
          });
        }
        if (row.priceMin !== null && row.priceMax !== null) {
          await tx.insert(schema.placePrices).values({
            placeId: place!.id,
            priceMin: row.priceMin,
            priceMax: row.priceMax,
            currency: 'VND',
            unit: row.priceUnit === 'per_item' ? 'per_item' : 'per_person',
            // User-supplied estimate — low confidence until an editor verifies.
            confidence: '0.30',
            source: 'editor',
          });
        }
        return place!.id;
      })
      .then(async (placeId) => {
        await this.dedup.upsertProviderSource({
          placeId,
          details: d,
          derivedScore: score,
          fetchTier: 'quality',
        });
        await this.dedup.emitReindex(placeId, 'published');
        return placeId;
      });
  }
}
