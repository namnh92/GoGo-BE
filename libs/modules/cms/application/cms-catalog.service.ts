import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';

type PlaceStatus = (typeof schema.places.$inferSelect)['status'];

/** FR-CMS-002 — place status workflow. */
const PLACE_TRANSITIONS: Record<PlaceStatus, PlaceStatus[]> = {
  draft: ['review', 'archived'],
  community_submitted: ['review', 'published', 'archived'],
  review: ['published', 'draft', 'archived'],
  published: ['suspended', 'archived'],
  suspended: ['published', 'archived'],
  archived: [],
};

export type PlaceEditInput = {
  name?: string | undefined;
  description?: string | undefined;
  addressText?: string | undefined;
  areaKey?: string | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  avgVisitMinutes?: number | undefined;
  suitability?: Record<string, number> | undefined;
  isLodging?: boolean | undefined;
  curatedRank?: number | null | undefined;
  taxonomyIds?: string[] | undefined;
};

/** CMS-002/003/004 — canonical place editing, sources/hours/prices, dedup. */
@Injectable()
export class CmsCatalogService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async audit(adminId: string, action: string, resourceId: string, diff?: unknown) {
    await this.db.insert(schema.auditLogs).values({
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'place',
      resourceId,
      diff,
    });
  }

  async listPlaces(filter: { status?: string | undefined; q?: string | undefined; limit: number }) {
    const conditions = [
      ...(filter.status ? [eq(schema.places.status, filter.status as PlaceStatus)] : []),
      ...(filter.q ? [ilike(schema.places.name, `%${filter.q}%`)] : []),
    ];
    const rows = await this.db
      .select()
      .from(schema.places)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.places.updatedAt))
      .limit(filter.limit);
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      areaKey: p.areaKey ?? undefined,
      rating: p.rating !== null ? Number(p.rating) : undefined,
      confidence: Number(p.confidence),
      freshnessCheckedAt: p.freshnessCheckedAt?.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
  }

  async updatePlace(adminId: string, placeId: string, input: PlaceEditInput) {
    const [before] = await this.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!before) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    const [after] = await this.db
      .update(schema.places)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.addressText !== undefined ? { addressText: input.addressText } : {}),
        ...(input.areaKey !== undefined ? { areaKey: input.areaKey } : {}),
        ...(input.lat !== undefined && input.lng !== undefined
          ? { geom: { x: input.lng, y: input.lat } }
          : {}),
        ...(input.avgVisitMinutes !== undefined ? { avgVisitMinutes: input.avgVisitMinutes } : {}),
        ...(input.suitability !== undefined ? { suitability: input.suitability } : {}),
        ...(input.isLodging !== undefined ? { isLodging: input.isLodging } : {}),
        ...(input.curatedRank !== undefined ? { curatedRank: input.curatedRank } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.places.id, placeId))
      .returning();

    if (input.taxonomyIds) {
      await this.db
        .delete(schema.placeTaxonomies)
        .where(eq(schema.placeTaxonomies.placeId, placeId));
      if (input.taxonomyIds.length > 0) {
        await this.db
          .insert(schema.placeTaxonomies)
          .values(input.taxonomyIds.map((taxonomyId) => ({ placeId, taxonomyId })))
          .onConflictDoNothing();
      }
    }

    // FR-CMS-008: before/after diff of the sensitive write.
    await this.audit(adminId, 'place.updated', placeId, {
      before: { name: before.name, status: before.status },
      changed: Object.keys(input),
    });
    return { id: after!.id, status: after!.status };
  }

  async transitionPlace(adminId: string, placeId: string, to: PlaceStatus) {
    const [place] = await this.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
    if (!PLACE_TRANSITIONS[place.status].includes(to)) {
      throw AppError.conflict('INVALID_PLACE_TRANSITION', `${place.status} → ${to} is not allowed`);
    }
    await this.db
      .update(schema.places)
      .set({ status: to, updatedAt: sql`now()` })
      .where(eq(schema.places.id, placeId));
    await this.audit(adminId, 'place.status_changed', placeId, { from: place.status, to });
    return { id: placeId, status: to };
  }

  /** CMS-003 — replace weekly hours (editor-verified). */
  async setHours(
    adminId: string,
    placeId: string,
    hours: { dayOfWeek: number; openMinute: number; closeMinute: number; isOvernight: boolean }[],
  ) {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.placeHours).where(eq(schema.placeHours.placeId, placeId));
      if (hours.length > 0) {
        await tx.insert(schema.placeHours).values(
          hours.map((h) => ({
            placeId,
            ...h,
            source: 'editor' as const,
            verifiedAt: new Date(),
          })),
        );
      }
      await tx
        .update(schema.places)
        .set({ freshnessCheckedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.places.id, placeId));
    });
    await this.audit(adminId, 'place.hours_set', placeId, { count: hours.length });
    return { updated: true };
  }

  /** CMS-003 — add a verified price observation. */
  async addPrice(
    adminId: string,
    placeId: string,
    input: {
      priceMin: number;
      priceMax: number;
      unit: 'per_person' | 'per_item' | 'per_hour' | 'per_night';
    },
  ) {
    await this.db.insert(schema.placePrices).values({
      placeId,
      priceMin: input.priceMin,
      priceMax: input.priceMax,
      currency: 'VND',
      unit: input.unit,
      confidence: '0.90',
      source: 'editor',
      verifiedAt: new Date(),
    });
    await this.audit(adminId, 'place.price_added', placeId, input);
    return { added: true };
  }

  async touchFreshness(adminId: string, placeId: string) {
    await this.db
      .update(schema.places)
      .set({ freshnessCheckedAt: sql`now()`, confidence: '0.90', updatedAt: sql`now()` })
      .where(eq(schema.places.id, placeId));
    await this.audit(adminId, 'place.freshness_verified', placeId);
    return { verified: true };
  }

  /** CMS-003 — stale queue: places whose facts haven't been checked recently. */
  async staleQueue(days: number, limit: number) {
    const rows = await this.db.execute(sql`
      select id, name, status, freshness_checked_at
      from places
      where status = 'published'
        and (freshness_checked_at is null or freshness_checked_at < now() - make_interval(days => ${days}))
      order by freshness_checked_at asc nulls first
      limit ${limit}
    `);
    return rows.rows;
  }

  /** CMS-004 — duplicate candidates: same provider id, or near + similar name. */
  async duplicateCandidates(limit: number) {
    const rows = await this.db.execute(sql`
      select a.id as place_a, b.id as place_b, a.name as name_a, b.name as name_b,
        similarity(a.name_normalized, b.name_normalized) as name_similarity,
        ST_Distance(a.geom::geography, b.geom::geography) as distance_m
      from places a
      join places b on a.id < b.id
      where a.status <> 'archived' and b.status <> 'archived'
        and ST_DWithin(a.geom::geography, b.geom::geography, 150)
        and similarity(a.name_normalized, b.name_normalized) > 0.5
      order by name_similarity desc
      limit ${limit}
    `);
    return rows.rows;
  }

  /** CMS-004 — merge: duplicate's references move to canonical; history kept. */
  async mergePlaces(adminId: string, canonicalId: string, duplicateId: string) {
    if (canonicalId === duplicateId) {
      throw AppError.badRequest('INVALID_MERGE', 'Cannot merge a place into itself');
    }
    await this.db.transaction(async (tx) => {
      for (const table of [
        schema.placeSources,
        schema.placeMedia,
        schema.placePrices,
        schema.reviews,
        schema.roomSeedPlaces,
      ] as const) {
        await tx
          .update(table)
          .set({ placeId: canonicalId } as never)
          .where(eq((table as typeof schema.placeSources).placeId, duplicateId));
      }
      await tx
        .update(schema.places)
        .set({ status: 'archived', updatedAt: sql`now()` })
        .where(eq(schema.places.id, duplicateId));
      await tx.insert(schema.auditLogs).values({
        actorType: 'admin',
        actorId: adminId,
        action: 'place.merged',
        resourceType: 'place',
        resourceId: canonicalId,
        diff: { duplicateId },
      });
    });
    return { merged: true, canonicalId };
  }
}
