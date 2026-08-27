import { Inject, Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { normalizeVietnamese } from '../../search/domain/normalize';
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

export const PLACE_SORTS = ['updated_at', 'created_at', 'name', 'confidence'] as const;
export type PlaceSort = (typeof PLACE_SORTS)[number];

export const PLACE_SOURCES = ['google', 'community', 'manual'] as const;
export type PlaceSource = (typeof PLACE_SOURCES)[number];

/**
 * Keyset paging needs a NOT NULL sort column — a null would break the tuple
 * comparison and silently drop rows. `nullable` is asserted, not assumed.
 * `name` sorts on the normalized column so ordering does not depend on the
 * database collation.
 */
const SORTABLE: Record<PlaceSort, { column: SQL; nullable: boolean; cast: SQL }> = {
  // `cast` matters: the cursor travels as text, and comparing a timestamptz
  // column against untyped text makes Postgres pick the wrong operator.
  updated_at: { column: sql`p.updated_at`, nullable: false, cast: sql`::timestamptz` },
  created_at: { column: sql`p.created_at`, nullable: false, cast: sql`::timestamptz` },
  name: { column: sql`p.name_normalized`, nullable: false, cast: sql`::text` },
  confidence: { column: sql`p.confidence`, nullable: false, cast: sql`::numeric` },
};

export type PlaceListQuery = {
  status?: PlaceStatus | undefined;
  q?: string | undefined;
  areaKey?: string | undefined;
  category?: string | undefined;
  source?: PlaceSource | undefined;
  staleBefore?: Date | undefined;
  sort: PlaceSort;
  direction: 'asc' | 'desc';
  limit: number;
  cursor?: string | undefined;
};

export type PlaceListItem = {
  id: string;
  name: string;
  status: string;
  areaKey?: string | undefined;
  rating?: number | undefined;
  confidence: number;
  freshnessCheckedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type PlaceListPage = { items: PlaceListItem[]; nextCursor: string | null };

type PlaceListRow = {
  id: string;
  name: string;
  status: string;
  area_key: string | null;
  rating: string | null;
  confidence: string;
  // `db.execute` returns driver rows: timestamps may arrive as Date or as the
  // raw string, depending on the parser in play. Normalize instead of assuming.
  freshness_checked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  sort_value: string | number | Date;
};

function toIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * "Where did this place come from" — derived from the links that exist, not
 * from `created_by`, so a place keeps its provenance when staff change.
 */
function sourcePredicate(source: PlaceSource): SQL {
  const linkedToProvider = sql`(
    exists (select 1 from place_provider_sources ps where ps.place_id = p.id)
    or exists (select 1 from place_sources s where s.place_id = p.id and s.provider = 'google')
  )`;
  const fromCommunity = sql`exists (
    select 1 from place_submissions sub where sub.result_place_id = p.id
  )`;
  if (source === 'community') return fromCommunity;
  if (source === 'google') return sql`${linkedToProvider} and not ${fromCommunity}`;
  return sql`not ${linkedToProvider} and not ${fromCommunity}`;
}

export function encodePlaceCursor(value: string | number | Date, id: string): string {
  const raw = value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(JSON.stringify([raw, id])).toString('base64url');
}

export function decodePlaceCursor(cursor: string): { value: string; id: string } {
  try {
    const [value, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad');
    return { value, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

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

  /**
   * BE-IMP-001/002 — CMS place list.
   *
   * Keyset (cursor) pagination, not offset: the catalog is written to while
   * editors browse it — a background import shifts rows between requests, and
   * offset would then repeat or skip them. The cursor carries the sort value
   * plus the id so the traversal stays stable no matter what is inserted.
   *
   * Search runs on `name_normalized`, the column the trigram index is built
   * on. Querying `name` instead both missed the index and gave different
   * results from the consumer-facing search on identical data.
   */
  async listPlaces(query: PlaceListQuery): Promise<PlaceListPage> {
    const { column, nullable, cast } = SORTABLE[query.sort];
    if (nullable) throw new Error(`sort column ${query.sort} must be NOT NULL for keyset paging`);
    const descending = query.direction === 'desc';

    const where: SQL[] = [];
    if (query.status) where.push(sql`p.status = ${query.status}`);
    if (query.areaKey) where.push(sql`p.area_key = ${query.areaKey}`);

    if (query.q) {
      // Already lower/unaccented on both sides, so LIKE is enough — and it is
      // what `places_name_trgm_idx` (gin_trgm_ops) can actually serve.
      const needle = `%${normalizeVietnamese(query.q)}%`;
      where.push(sql`p.name_normalized like ${needle}`);
    }

    if (query.category) {
      where.push(sql`exists (
        select 1 from place_taxonomies pt
        join taxonomies t on t.id = pt.taxonomy_id
        where pt.place_id = p.id and t.kind = 'category' and t.key = ${query.category}
      )`);
    }

    if (query.source) where.push(sourcePredicate(query.source));

    if (query.staleBefore) {
      // Never checked counts as stale — that is the case an editor most wants.
      where.push(
        sql`(p.freshness_checked_at is null or p.freshness_checked_at < ${query.staleBefore})`,
      );
    }

    if (query.cursor) {
      const { value, id } = decodePlaceCursor(query.cursor);
      const bound = sql`${value}${cast}`;
      where.push(
        descending
          ? sql`(${column}, p.id) < (${bound}, ${id}::uuid)`
          : sql`(${column}, p.id) > (${bound}, ${id}::uuid)`,
      );
    }

    const condition = where.length > 0 ? sql.join(where, sql` and `) : sql`true`;
    const order = descending ? sql`${column} desc, p.id desc` : sql`${column} asc, p.id asc`;

    // limit + 1 so `nextCursor` means "there is more", not "maybe more".
    const rows = await this.db.execute(sql`
      select p.id, p.name, p.status, p.area_key, p.rating, p.confidence,
             p.freshness_checked_at, p.created_at, p.updated_at,
             ${column} as sort_value
      from places p
      where ${condition}
      order by ${order}
      limit ${query.limit + 1}
    `);

    const page = rows.rows as PlaceListRow[];
    const items = page.slice(0, query.limit);
    const last = items[items.length - 1];

    return {
      items: items.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        areaKey: p.area_key ?? undefined,
        rating: p.rating !== null ? Number(p.rating) : undefined,
        confidence: Number(p.confidence),
        freshnessCheckedAt: toIso(p.freshness_checked_at),
        createdAt: toIso(p.created_at)!,
        updatedAt: toIso(p.updated_at)!,
      })),
      nextCursor:
        page.length > query.limit && last ? encodePlaceCursor(last.sort_value, last.id) : null,
    };
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
