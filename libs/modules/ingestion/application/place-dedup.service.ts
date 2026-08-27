import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import { normalizeVietnamese } from '../../search/domain/normalize';
import { DB } from '../../shared/tokens';
import { writeOutbox } from '../../shared/outbox';

export type DedupVerdict =
  | { kind: 'LINKED_EXISTING'; placeId: string }
  | { kind: 'MERGE_CANDIDATE'; placeId: string; similarity: number; distanceM: number }
  | { kind: 'NEW' };

/**
 * PI-BE-006 / FR-INGEST-009 — duplicate rules, strongest signal first:
 * provider id (exact) → same name within 150 m (merge candidate) → new.
 * Ambiguity always becomes a human decision, never an automatic merge.
 */
@Injectable()
export class PlaceDedupService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async check(details: ResolvedProviderPlace): Promise<DedupVerdict> {
    const byProvider = await this.db.execute(sql`
      select place_id from place_provider_sources
      where provider = 'google_places' and external_id = ${details.providerPlaceId}
      limit 1
    `);
    const linked = byProvider.rows[0] as { place_id: string } | undefined;
    if (linked) return { kind: 'LINKED_EXISTING', placeId: linked.place_id };

    // Legacy place_sources rows count as the same signal.
    const legacy = await this.db.execute(sql`
      select place_id from place_sources
      where provider = 'google' and external_id = ${details.providerPlaceId}
      limit 1
    `);
    const legacyHit = legacy.rows[0] as { place_id: string } | undefined;
    if (legacyHit) return { kind: 'LINKED_EXISTING', placeId: legacyHit.place_id };

    const normalized = normalizeVietnamese(details.name);
    const near = await this.db.execute(sql`
      select id,
        similarity(name_normalized, ${normalized}) as sim,
        ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(${details.lng}, ${details.lat}), 4326)::geography) as dist
      from places
      where status <> 'archived'
        and ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${details.lng}, ${details.lat}), 4326)::geography, 150)
        and similarity(name_normalized, ${normalized}) > 0.5
      order by sim desc
      limit 1
    `);
    const candidate = near.rows[0] as { id: string; sim: number; dist: number } | undefined;
    if (candidate) {
      return {
        kind: 'MERGE_CANDIDATE',
        placeId: candidate.id,
        similarity: Number(candidate.sim),
        distanceM: Math.round(Number(candidate.dist)),
      };
    }
    return { kind: 'NEW' };
  }

  /**
   * PI-BE-007/009 — upsert the provider snapshot. Raw aggregates and the
   * derived score are stored side by side with freshness + attribution.
   */
  async upsertProviderSource(input: {
    placeId: string;
    details: ResolvedProviderPlace;
    derivedScore: number;
    fetchTier: 'core' | 'quality' | 'detail';
    refreshAfterDays?: number;
  }): Promise<void> {
    const refreshAfter = new Date(Date.now() + (input.refreshAfterDays ?? 30) * 24 * 3600 * 1000);
    // `CLOSED_TEMPORARILY` used to land on 'unknown', which conflated "shut for
    // now" with "we have no idea" — and the two lead to different decisions.
    const sourceStatus =
      input.details.businessStatus === 'CLOSED_PERMANENTLY'
        ? 'closed'
        : input.details.businessStatus === 'CLOSED_TEMPORARILY'
          ? 'temporarily_closed'
          : 'active';
    await this.db
      .insert(schema.placeProviderSources)
      .values({
        placeId: input.placeId,
        provider: 'google_places',
        externalId: input.details.providerPlaceId,
        rating: input.details.rating !== null ? input.details.rating.toFixed(2) : null,
        ratingCount: input.details.ratingCount,
        derivedScore: input.derivedScore.toFixed(2),
        priceLevel: input.details.priceLevel,
        refreshAfter,
        attribution: { text: input.details.attribution },
        sourceStatus,
        fetchTier: input.fetchTier,
      })
      .onConflictDoUpdate({
        target: [schema.placeProviderSources.provider, schema.placeProviderSources.externalId],
        set: {
          placeId: input.placeId,
          rating: input.details.rating !== null ? input.details.rating.toFixed(2) : null,
          ratingCount: input.details.ratingCount,
          derivedScore: input.derivedScore.toFixed(2),
          fetchedAt: sql`now()`,
          refreshAfter,
          sourceStatus,
          fetchTier: input.fetchTier,
        },
      });
  }

  /** PI-BE-010 — publish/merge must nudge search; consumers are idempotent. */
  async emitReindex(placeId: string, reason: 'published' | 'merged' | 'updated'): Promise<void> {
    await writeOutbox(this.db, {
      eventType: 'place.updated',
      resourceType: 'place',
      resourceId: placeId,
      payload: { reason },
    });
  }
}
