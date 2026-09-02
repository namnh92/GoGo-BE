import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { normalizeVietnamese } from '../../search/domain/normalize';
import { AppError } from '../../shared/app-error';
import { invalidateTravelOnMove } from '../../shared/place-relocation';
import { APP_CONFIG, type ProvenanceConfig } from '../../shared/config';
import { GOOGLE_PROVIDER, googleProvenanceRows } from '../../shared/google-provenance';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { writeOutbox } from '../../shared/outbox';

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

/**
 * Driver rows for the detail read. `db.execute` returns whatever the parser
 * hands back, so numerics arrive as strings and timestamps as Date or string —
 * normalized on the way out rather than assumed.
 */
type PlaceDetailRow = {
  id: string;
  name: string;
  description: string | null;
  status: PlaceStatus;
  address_text: string | null;
  area_key: string | null;
  lat: number | string | null;
  lng: number | string | null;
  phone: string | null;
  website: string | null;
  rating: string | null;
  rating_count: number;
  price_level: number | null;
  avg_visit_minutes: number | null;
  suitability: Record<string, number> | null;
  is_lodging: boolean;
  confidence: string;
  curated_rank: number | null;
  freshness_checked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PlaceHoursRow = {
  day_of_week: number;
  open_minute: number;
  close_minute: number;
  is_overnight: boolean;
  source: string;
  verified_at: Date | string | null;
};

type PlacePriceRow = {
  id: string;
  price_min: string | number;
  price_max: string | number;
  currency: string;
  unit: string;
  source: string;
  confidence: string;
  verified_at: Date | string | null;
  created_at: Date | string;
};

type PlaceSourceRow = {
  id: string;
  provider: string;
  external_id: string;
  url: string | null;
  attribution: string | null;
  fetched_at: Date | string | null;
  // #341 — refresh bookkeeping, canonical rows only (null on a legacy row).
  source_status: string | null;
  refresh_after: Date | string | null;
  last_refresh_error_code: string | null;
  moved_to_external_id: string | null;
  fetch_tier: string | null;
};

type PlaceMediaRow = {
  id: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  sort_order: number;
  moderation: string;
};

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
    exists (
      select 1 from place_provider_sources ps
      where ps.place_id = p.id and ps.provider = ${GOOGLE_PROVIDER}
    )
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
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(APP_CONFIG) private readonly config?: ProvenanceConfig,
  ) {}

  /** Default on: off is the state that serves ingestion places unattributed. */
  private get unifiedProvenance(): boolean {
    return this.config?.PROVENANCE_UNIFIED_READS ?? true;
  }

  private async audit(adminId: string, action: string, resourceId: string, diff?: unknown) {
    await writeAudit(this.db, {
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

  /**
   * BE-IMP-009 — the record the CMS place editor loads.
   *
   * Everything `updatePlace` accepts, plus the facts rendered around the form.
   * The list endpoint is not a substitute: it is a keyset-paged index and
   * carries none of this on purpose.
   *
   * Ratings stay apart. `places.rating` is the provider's figure and GoGo's is
   * derived from published reviews; averaging them would produce a number that
   * describes neither, and FR-INGEST-006 requires them stored and shown
   * separately. The composite/Bayesian score that spec also describes is not
   * computed anywhere yet, so it is absent rather than faked.
   */
  async getPlace(placeId: string) {
    const [row] = (
      await this.db.execute(sql`
        select p.id, p.name, p.description, p.status, p.address_text, p.area_key,
               ST_Y(p.geom) as lat, ST_X(p.geom) as lng,
               p.phone, p.website, p.rating, p.rating_count, p.price_level,
               p.avg_visit_minutes, p.suitability, p.is_lodging, p.confidence,
               p.curated_rank, p.freshness_checked_at, p.created_at, p.updated_at
        from places p
        where p.id = ${placeId}::uuid
      `)
    ).rows as PlaceDetailRow[];
    if (!row) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    const [taxonomies, hours, prices, sources, media, gogo] = await Promise.all([
      this.db.execute(sql`
        select t.id, t.kind, t.key
        from place_taxonomies pt
        join taxonomies t on t.id = pt.taxonomy_id
        where pt.place_id = ${placeId}::uuid
        order by t.kind, t.key
      `),
      this.db.execute(sql`
        select day_of_week, open_minute, close_minute, is_overnight, source, verified_at
        from place_hours where place_id = ${placeId}::uuid
        order by day_of_week, open_minute
      `),
      this.db.execute(sql`
        select id, price_min, price_max, currency, unit, source, confidence, verified_at, created_at
        from place_prices where place_id = ${placeId}::uuid
        order by created_at desc
      `),
      // #334: both provenance tables, deduped — see `googleProvenanceRows`.
      this.db.execute(sql`
        select * from (${googleProvenanceRows(sql`${placeId}::uuid`, this.unifiedProvenance)}) src
        order by src.fetched_at desc nulls last
      `),
      this.db.execute(sql`
        select id, storage_key, width, height, sort_order, moderation
        from place_media where place_id = ${placeId}::uuid
        order by sort_order, created_at
      `),
      this.db.execute(sql`
        select round(avg(rating)::numeric, 2) as rating, count(*)::int as count
        from reviews where place_id = ${placeId}::uuid and status = 'published'
      `),
    ]);

    const gogoRow = gogo.rows[0] as { rating: string | null; count: number } | undefined;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      addressText: row.address_text,
      areaKey: row.area_key,
      lat: row.lat !== null ? Number(row.lat) : undefined,
      lng: row.lng !== null ? Number(row.lng) : undefined,
      phone: row.phone,
      website: row.website,
      avgVisitMinutes: row.avg_visit_minutes,
      suitability: row.suitability ?? {},
      isLodging: row.is_lodging,
      curatedRank: row.curated_rank,
      confidence: Number(row.confidence),
      priceLevel: row.price_level,
      ratings: {
        provider: {
          rating: row.rating !== null ? Number(row.rating) : undefined,
          count: row.rating_count,
        },
        gogo: {
          rating: gogoRow?.rating != null ? Number(gogoRow.rating) : undefined,
          count: gogoRow?.count ?? 0,
        },
      },
      taxonomyIds: taxonomies.rows.map((t) => (t as { id: string }).id),
      // Keys travel alongside the ids so a client can label a chip without a
      // second round trip, and still writes back ids.
      taxonomyKeys: taxonomies.rows.map((t) => (t as { key: string }).key),
      hours: hours.rows.map((h) => {
        const r = h as PlaceHoursRow;
        return {
          dayOfWeek: r.day_of_week,
          openMinute: r.open_minute,
          closeMinute: r.close_minute,
          isOvernight: r.is_overnight,
          source: r.source,
          verifiedAt: toIso(r.verified_at),
        };
      }),
      prices: prices.rows.map((pr) => {
        const r = pr as PlacePriceRow;
        return {
          id: r.id,
          priceMin: Number(r.price_min),
          priceMax: Number(r.price_max),
          currency: r.currency,
          unit: r.unit,
          source: r.source,
          confidence: Number(r.confidence),
          verifiedAt: toIso(r.verified_at),
          createdAt: toIso(r.created_at),
        };
      }),
      sources: sources.rows.map((sr) => {
        const r = sr as PlaceSourceRow;
        return {
          id: r.id,
          provider: r.provider,
          externalId: r.external_id,
          url: r.url,
          // Provider facts carry attribution and a fetch time (FR-INGEST-014).
          attribution: r.attribution,
          fetchedAt: toIso(r.fetched_at),
          // #341 (PR8) — what GoGo's own refresh recorded about this identity
          // (ADR-0006 §9.7.1): liveness state, the next scheduled check, the
          // last lookup failure, a successor id. GoGo metadata, not content.
          sourceStatus: r.source_status,
          refreshAfter: toIso(r.refresh_after),
          lastRefreshErrorCode: r.last_refresh_error_code,
          movedToExternalId: r.moved_to_external_id,
          fetchTier: r.fetch_tier,
        };
      }),
      media: media.rows.map((m) => {
        const r = m as PlaceMediaRow;
        return {
          id: r.id,
          storageKey: r.storage_key,
          width: r.width,
          height: r.height,
          sortOrder: r.sort_order,
          moderation: r.moderation,
        };
      }),
      freshnessCheckedAt: toIso(row.freshness_checked_at),
      createdAt: toIso(row.created_at)!,
      updatedAt: toIso(row.updated_at)!,
    };
  }

  async updatePlace(adminId: string, placeId: string, input: PlaceEditInput) {
    const [before] = await this.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!before) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    // #339 — an editor dragging a pin across town invalidates every cached
    // travel time to and from this place, and every live plan built on them.
    // Measured before the write, because afterwards there is nothing to
    // measure against.
    if (input.lat !== undefined && input.lng !== undefined) {
      await invalidateTravelOnMove(this.db, placeId, { lat: input.lat, lng: input.lng });
    }

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

  /**
   * #341 (PR8) / CMS#98 — ask PR7's liveness refresh to look at this place
   * sooner.
   *
   * Two columns move: `refresh_after` to now, `refresh_priority` to 1. Both
   * are GoGo's own scheduling metadata (ADR-0006 §9.7.1); no provider is
   * called here and nothing about the place changes until the worker's next
   * tick answers, inside the refresh scope's own ceiling. A moderator who has
   * just seen, in an ephemeral preview, that Google answers under another id
   * has exactly this lever: the *persisted* state changes only through the
   * sanctioned path, never by copying the preview.
   */
  async requestRefresh(adminId: string, placeId: string) {
    const updated = await this.db
      .update(schema.placeProviderSources)
      .set({ refreshAfter: sql`now()`, refreshPriority: 1 })
      .where(
        and(
          eq(schema.placeProviderSources.placeId, placeId),
          eq(schema.placeProviderSources.provider, GOOGLE_PROVIDER),
        ),
      )
      .returning({ refreshAfter: schema.placeProviderSources.refreshAfter });
    if (updated.length === 0) {
      const [place] = await this.db
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(eq(schema.places.id, placeId))
        .limit(1);
      if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
      throw AppError.conflict(
        'PLACE_NO_PROVIDER_SOURCE',
        'Place has no Google identity to refresh',
      );
    }
    await this.audit(adminId, 'place.refresh_requested', placeId, { refreshPriority: 1 });
    return { requested: true as const, refreshAfter: toIso(updated[0]!.refreshAfter)! };
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

  /**
   * CMS-004 — merge: the duplicate's references move to canonical, and the
   * duplicate is archived rather than deleted so the history survives.
   *
   * #334: the list used to stop at five tables, so a merge left the duplicate
   * holding its `place_provider_sources` row — the row dedup resolves a Google
   * Place ID through. The next import of that ID resolved to an archived
   * place, which no reader serves. Hours, taxonomies, plan stops, saved items
   * and travel legs were stranded the same way.
   *
   * Not every table moves the same way, and the differences are deliberate:
   *
   * - `place_provider_sources` moves outright. Its unique index is global on
   *   `(provider, external_id)`, so two places cannot hold the same identity
   *   and this update cannot collide.
   * - `place_taxonomies` and `saved_items` move where the canonical place does
   *   not already have the row, and the leftovers are dropped — a place cannot
   *   carry a category twice, and a user cannot save it twice.
   * - `place_hours` moves only into a canonical place that has none. Two
   *   opening-hour sets for one place is not more information, it is a
   *   contradiction, and the canonical place's own hours are the ones an
   *   editor has been looking at.
   * - `travel_legs` are deleted, not moved. A leg is a cached duration between
   *   two coordinates; carrying the duplicate's over would attribute a travel
   *   time measured from one point to a place that sits at another. They
   *   recompute on demand.
   */
  async mergePlaces(adminId: string, canonicalId: string, duplicateId: string) {
    if (canonicalId === duplicateId) {
      throw AppError.badRequest('INVALID_MERGE', 'Cannot merge a place into itself');
    }
    await this.db.transaction(async (tx) => {
      for (const table of [
        schema.placeSources,
        schema.placeProviderSources,
        schema.placeMedia,
        schema.placePrices,
        schema.reviews,
        schema.roomSeedPlaces,
        schema.planStops,
      ] as const) {
        await tx
          .update(table)
          .set({ placeId: canonicalId } as never)
          .where(eq((table as typeof schema.placeSources).placeId, duplicateId));
      }

      await tx.execute(sql`
        update place_taxonomies pt set place_id = ${canonicalId}::uuid
        where pt.place_id = ${duplicateId}::uuid
          and not exists (
            select 1 from place_taxonomies keep
            where keep.place_id = ${canonicalId}::uuid and keep.taxonomy_id = pt.taxonomy_id
          )
      `);
      await tx.execute(sql`
        delete from place_taxonomies where place_id = ${duplicateId}::uuid
      `);

      await tx.execute(sql`
        update saved_items si set target_id = ${canonicalId}::uuid
        where si.target_type = 'place' and si.target_id = ${duplicateId}::uuid
          and not exists (
            select 1 from saved_items keep
            where keep.user_id = si.user_id and keep.target_type = 'place'
              and keep.target_id = ${canonicalId}::uuid
          )
      `);
      await tx.execute(sql`
        delete from saved_items where target_type = 'place' and target_id = ${duplicateId}::uuid
      `);

      await tx.execute(sql`
        update place_hours set place_id = ${canonicalId}::uuid
        where place_id = ${duplicateId}::uuid
          and not exists (select 1 from place_hours keep where keep.place_id = ${canonicalId}::uuid)
      `);
      await tx.execute(sql`delete from place_hours where place_id = ${duplicateId}::uuid`);

      await tx.execute(sql`
        delete from travel_legs
        where from_place_id = ${duplicateId}::uuid or to_place_id = ${duplicateId}::uuid
      `);

      // A merge is the editorial answer the backfill could not give itself.
      await tx.execute(sql`
        update place_identity_conflicts
        set resolved_at = now(), resolution = 'merged'
        where resolved_at is null
          and ((canonical_place_id = ${canonicalId}::uuid and legacy_place_id = ${duplicateId}::uuid)
            or (canonical_place_id = ${duplicateId}::uuid and legacy_place_id = ${canonicalId}::uuid))
      `);

      await tx
        .update(schema.places)
        .set({ status: 'archived', updatedAt: sql`now()` })
        .where(eq(schema.places.id, duplicateId));
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'place.merged',
        resourceType: 'place',
        resourceId: canonicalId,
        diff: { duplicateId },
      });
      // Both sides changed: one gained the references, the other left the
      // catalogue. Consumers are idempotent (PI-BE-010).
      for (const placeId of [canonicalId, duplicateId]) {
        await writeOutbox(tx, {
          eventType: 'place.updated',
          resourceType: 'place',
          resourceId: placeId,
          payload: { reason: 'merged' },
        });
      }
    });
    return { merged: true, canonicalId };
  }
}
