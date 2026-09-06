import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { type Db } from '@gogo/database';
import { APP_CONFIG, type ProvenanceConfig } from '../../shared/config';
import { googleProvenanceRows } from '../../shared/google-provenance';
import { DB } from '../../shared/tokens';
import { toSearchQuery } from '../domain/normalize';

export type SearchWeights = {
  text: number;
  distance: number;
  quality: number;
  freshness: number;
  curated: number;
};

export const DEFAULT_WEIGHTS: SearchWeights = {
  text: 0.4,
  distance: 0.2,
  quality: 0.2,
  freshness: 0.1,
  curated: 0.1,
};

export type SearchSort = 'relevance' | 'distance' | 'rating' | 'price' | 'curated';

export type SearchFilters = {
  q?: string | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  radiusM?: number | undefined;
  /** UTC instant to evaluate opening hours at (converted to VN local inside). */
  openAt?: Date | undefined;
  categories?: string[] | undefined;
  suitedFor?: 'couple' | 'group' | 'family' | undefined;
  priceMinPerPerson?: number | undefined;
  priceMaxPerPerson?: number | undefined;
  minRating?: number | undefined;
  dietary?: string[] | undefined;
  accessibility?: string[] | undefined;
  includeLodging?: boolean | undefined;
  sort: SearchSort;
  limit: number;
  cursor?: { v: number; id: string } | undefined;
  /** Score reference time — frozen across pages so cursors stay stable. */
  scoredAt: Date;
  /** Category keys resolved from synonym expansion of the query (SE-001). */
  synonymCategoryKeys?: string[] | undefined;
};

export type SearchRow = {
  id: string;
  photo_id: string | null;
  photo_key: string | null;
  photo_width: number | null;
  photo_height: number | null;
  photo_from_community: boolean | null;
  name: string;
  address_text: string | null;
  area_key: string | null;
  lat: number;
  lng: number;
  rating: string | null;
  rating_count: number;
  avg_visit_minutes: number | null;
  suitability: Record<string, number> | null;
  is_lodging: boolean;
  confidence: string;
  // drizzle db.execute bypasses column mapping; timestamptz arrives as string.
  freshness_checked_at: string | null;
  curated_rank: number | null;
  price_min: string | null;
  price_max: string | null;
  price_currency: string | null;
  price_confidence: string | null;
  distance_m: number | null;
  text_score: number | null;
  sort_value: number;
  score: number;
};

/** Hours row used for open-now display facts. */
export type HoursRow = {
  place_id: string;
  day_of_week: number;
  /** #425 — `closed` and `open_24h` rows carry 0/0 minutes and are not spans. */
  entry_kind: 'interval' | 'closed' | 'open_24h';
  open_minute: number;
  close_minute: number;
  is_overnight: boolean;
};

const VN_UTC_OFFSET_MINUTES = 7 * 60; // places are VN-local (launch market)

/**
 * drizzle's sql template flattens JS arrays instead of binding them as PG
 * arrays — serialize the array literal ourselves and bind it as one text
 * param (cast server-side). Quotes/backslashes escaped per PG array syntax.
 */
export function pgArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

export function vnDayMinute(at: Date): { dow: number; minute: number } {
  const shifted = new Date(at.getTime() + VN_UTC_OFFSET_MINUTES * 60_000);
  return { dow: shifted.getUTCDay(), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

/**
 * COST-BE-006 (#339) — a place the provider reports shut never reaches a user.
 *
 * `places.status` is what GoGo decided about a place; `source_status` is what
 * Google last reported about the business. The two are deliberately separate,
 * and a shut business stays `published` because nobody moderated it — so
 * without this, search happily returned a permanently closed restaurant as a
 * live result. Suggestions has excluded these since BE-IMP-004; search did not,
 * which meant the same place was unrecommendable and findable at the same time.
 *
 * `temporarily_closed` goes with `closed`. A door that is shut this month is
 * shut whichever word explains it, and core rule 8 does not distinguish: an
 * unavailable place is excluded or warned, never presented as certain. GoGo has
 * no warning surface on a search result today, so it is excluded.
 */
function notProviderClosed(): SQL {
  return sql`not exists (
    select 1 from place_provider_sources ps
    where ps.place_id = p.id and ps.source_status in ('closed', 'temporarily_closed')
  )`;
}

/**
 * SE-002/003/004 — single parameterized retrieval query: FTS + trigram over
 * normalized Vietnamese, PostGIS radius, hard filters, weighted relevance,
 * stable keyset pagination. Raw SQL per ADR-0002 (hot path).
 */
@Injectable()
export class SearchRepository {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(APP_CONFIG) private readonly config?: ProvenanceConfig,
  ) {}

  /** Default on: off is the state that serves ingestion places unattributed. */
  private get unifiedProvenance(): boolean {
    return this.config?.PROVENANCE_UNIFIED_READS ?? true;
  }

  async search(f: SearchFilters, w: SearchWeights): Promise<SearchRow[]> {
    const conditions: SQL[] = [sql`p.status = 'published'`, notProviderClosed()];

    const q = f.q ? toSearchQuery(f.q) : '';
    if (q) {
      const synKeys = f.synonymCategoryKeys ?? [];
      const synonymArm =
        synKeys.length > 0
          ? sql` or exists (
              select 1 from place_taxonomies pt
              join taxonomies t on t.id = pt.taxonomy_id
              where pt.place_id = p.id and t.kind = 'category'
                and t.key = any((${pgArray(synKeys)})::text[]))`
          : sql``;
      conditions.push(
        sql`(p.search_tsv @@ websearch_to_tsquery('simple', ${q})
             or similarity(p.name_normalized, ${q}) > 0.2${synonymArm})`,
      );
    }

    const hasGeo = f.lat !== undefined && f.lng !== undefined;
    if (hasGeo && f.radiusM) {
      conditions.push(
        sql`ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint(${f.lng}, ${f.lat}), 4326)::geography, ${f.radiusM})`,
      );
    }

    if (f.categories && f.categories.length > 0) {
      conditions.push(sql`exists (
        select 1 from place_taxonomies pt
        join taxonomies t on t.id = pt.taxonomy_id
        where pt.place_id = p.id and t.kind = 'category'
          and t.key = any((${pgArray(f.categories)})::text[])
      )`);
    }

    // Lodging excluded by default unless explicitly requested (SE-010).
    const lodgingRequested = f.includeLodging || (f.categories ?? []).includes('lodging');
    if (!lodgingRequested) {
      conditions.push(sql`p.is_lodging = false`);
    }

    if (f.suitedFor) {
      conditions.push(sql`coalesce((p.suitability ->> ${f.suitedFor})::numeric, 0) >= 0.5`);
    }

    if (f.minRating !== undefined) {
      conditions.push(sql`p.rating >= ${f.minRating}`);
    }

    for (const [kind, keys] of [
      ['dietary', f.dietary],
      ['accessibility', f.accessibility],
    ] as const) {
      if (keys && keys.length > 0) {
        conditions.push(sql`(
          select count(distinct t.key) from place_taxonomies pt
          join taxonomies t on t.id = pt.taxonomy_id
          where pt.place_id = p.id and t.kind = ${kind} and t.key = any((${pgArray(keys)})::text[])
        ) = ${keys.length}`);
      }
    }

    if (f.openAt) {
      const { dow, minute } = vnDayMinute(f.openAt);
      const prevDow = (dow + 6) % 7;
      // #425 — `entry_kind` splits three claims that used to share one shape.
      // A `closed` row carries 0/0 minutes and would otherwise have matched
      // midnight; an `open_24h` row carries 0/0 too and means the opposite.
      conditions.push(sql`exists (
        select 1 from place_hours h where h.place_id = p.id and (
          (h.entry_kind = 'open_24h' and h.day_of_week = ${dow})
          or (h.entry_kind = 'interval' and (
            (h.day_of_week = ${dow} and (
              (not h.is_overnight and ${minute} between h.open_minute and h.close_minute)
              or (h.is_overnight and ${minute} >= h.open_minute)
            ))
            or (h.day_of_week = ${prevDow} and h.is_overnight and ${minute} <= h.close_minute)
          ))
        )
      )`);
    }

    if (f.priceMinPerPerson !== undefined) {
      conditions.push(sql`lp.price_max >= ${f.priceMinPerPerson}`);
    }
    if (f.priceMaxPerPerson !== undefined) {
      // FR-SEARCH-002: price ceiling applies to the place's lower bound so
      // "up to X per person" never hides places with a range starting below X.
      conditions.push(sql`lp.price_min <= ${f.priceMaxPerPerson}`);
    }

    const textScore = q
      ? sql`(ts_rank(p.search_tsv, websearch_to_tsquery('simple', ${q})) + similarity(p.name_normalized, ${q}))`
      : sql`0`;
    const distanceM = hasGeo
      ? sql`ST_Distance(p.geom::geography, ST_SetSRID(ST_MakePoint(${f.lng}, ${f.lat}), 4326)::geography)`
      : sql`null::float8`;

    const score = sql`(
      ${w.text}::float8 * least(coalesce(${textScore}, 0), 1)
      + ${w.distance}::float8 * (case when ${hasGeo ? sql`true` : sql`false`}
          then 1.0 / (1.0 + coalesce(${distanceM}, 0) / 1000.0) else 0 end)
      + ${w.quality}::float8 * (coalesce(p.rating, 3)::float8 / 5.0
          * least(ln(1 + p.rating_count) / ln(1000), 1))
      + ${w.freshness}::float8 * (case when p.freshness_checked_at is null then 0
          else exp(-greatest(extract(epoch from (${f.scoredAt.toISOString()}::timestamptz - p.freshness_checked_at)), 0) / 86400.0 / 60.0) end)
      + ${w.curated}::float8 * (case when p.curated_rank is not null
          then 1.0 / (1.0 + p.curated_rank) else 0 end)
    )`;

    // Sort value: single float the keyset cursor rides on. Higher-is-better
    // for every mode so pagination logic stays uniform (negate ascending).
    const sortValue: SQL =
      f.sort === 'distance'
        ? sql`-coalesce(${distanceM}, 1e12)`
        : f.sort === 'rating'
          ? sql`coalesce(p.rating, 0)::float8 + least(p.rating_count, 999999) * 1e-7`
          : f.sort === 'price'
            ? sql`-coalesce(lp.price_min, 1e15)::float8`
            : f.sort === 'curated'
              ? sql`-coalesce(p.curated_rank, 1e9)::float8`
              : score;

    if (f.cursor) {
      conditions.push(sql`(sv.sort_value, p.id) < (${f.cursor.v}::float8, ${f.cursor.id}::uuid)`);
    }

    const where = sql.join(conditions, sql` and `);

    const rows = await this.db.execute(sql`
      select
        p.id, p.name, p.address_text, p.area_key,
        ST_Y(p.geom) as lat, ST_X(p.geom) as lng,
        p.rating, p.rating_count, p.avg_visit_minutes, p.suitability,
        p.is_lodging, p.confidence, p.freshness_checked_at, p.curated_rank,
        lp.price_min, lp.price_max, lp.currency as price_currency,
        lp.confidence as price_confidence,
        -- #151: one image is enough for a list row; the gallery is detail-only.
        pm.id as photo_id, pm.storage_key as photo_key,
        pm.width as photo_width, pm.height as photo_height,
        pm.uploaded_by_user_id is not null as photo_from_community,
        ${distanceM} as distance_m,
        ${textScore} as text_score,
        sv.sort_value,
        ${score} as score
      from places p
      left join lateral (
        select pp.price_min, pp.price_max, pp.currency, pp.confidence
        from place_prices pp
        where pp.place_id = p.id and pp.unit = 'per_person'
        order by pp.verified_at desc nulls last, pp.created_at desc
        limit 1
      ) lp on true
      left join lateral (
        select m.id, m.storage_key, m.width, m.height, m.uploaded_by_user_id
        from place_media m
        where m.place_id = p.id and m.moderation = 'approved'
        order by m.sort_order, m.created_at
        limit 1
      ) pm on true
      cross join lateral (select ${sortValue} as sort_value) sv
      where ${where}
      order by sv.sort_value desc, p.id desc
      limit ${f.limit + 1}
    `);
    return rows.rows as unknown as SearchRow[];
  }

  async hoursFor(placeIds: string[]): Promise<HoursRow[]> {
    if (placeIds.length === 0) return [];
    const rows = await this.db.execute(sql`
      select place_id, day_of_week, entry_kind, open_minute, close_minute, is_overnight
      from place_hours where place_id = any((${pgArray(placeIds)})::uuid[])
    `);
    return rows.rows as unknown as HoursRow[];
  }

  async placeDetail(placeId: string) {
    const rows = await this.db.execute(sql`
      select
        p.id, p.name, p.description, p.status, p.address_text, p.area_key,
        ST_Y(p.geom) as lat, ST_X(p.geom) as lng,
        p.phone, p.website, p.rating, p.rating_count, p.price_level,
        p.avg_visit_minutes, p.suitability, p.is_lodging, p.confidence,
        p.freshness_checked_at, p.curated_rank,
        (select json_agg(json_build_object(
            'kind', t.kind, 'key', t.key) order by t.kind, t.key)
          from place_taxonomies pt join taxonomies t on t.id = pt.taxonomy_id
          where pt.place_id = p.id) as taxonomies,
        (select json_agg(json_build_object(
            'dayOfWeek', h.day_of_week, 'kind', h.entry_kind,
            'openMinute', h.open_minute,
            'closeMinute', h.close_minute, 'isOvernight', h.is_overnight)
            order by h.day_of_week)
          from place_hours h where h.place_id = p.id) as hours,
        (select json_agg(json_build_object(
            'priceMin', pp.price_min, 'priceMax', pp.price_max,
            'currency', pp.currency, 'unit', pp.unit,
            'confidence', pp.confidence, 'verifiedAt', pp.verified_at)
            order by pp.verified_at desc nulls last)
          from place_prices pp where pp.place_id = p.id) as prices,
        -- #334: both provenance tables, deduped. Before PR1 this read
        -- place_sources alone, so a place that arrived through bulk import
        -- or a mobile submission was served with no attribution -- which is
        -- the obligation, not a nicety.
        (select json_agg(json_build_object('provider', src.provider, 'url', src.url,
            'attribution', src.attribution))
          from (${googleProvenanceRows(sql`p.id`, this.unifiedProvenance)}) src) as sources,
        -- #151: photos travel with their attribution and moderation state.
        -- Community imagery that has not been approved never leaves the CMS.
        (select json_agg(json_build_object(
            'id', m.id, 'storageKey', m.storage_key,
            'width', m.width, 'height', m.height,
            'source', case when m.uploaded_by_user_id is null then 'manual' else 'community' end,
            'moderation', m.moderation)
            order by m.sort_order, m.created_at)
          from place_media m
          where m.place_id = p.id and m.moderation = 'approved') as media
      from places p
      where p.id = ${placeId} and p.status in ('published', 'community_submitted')
      limit 1
    `);
    return (rows.rows[0] as Record<string, unknown> | undefined) ?? undefined;
  }

  /** Synonym expansion: exact normalized-term match → category keys (SE-001). */
  async synonymCategoryKeys(normalizedQuery: string): Promise<string[]> {
    if (!normalizedQuery) return [];
    const rows = await this.db.execute(sql`
      select distinct t.key from taxonomy_synonyms s
      join taxonomies t on t.id = s.taxonomy_id
      where t.kind = 'category' and t.is_active
        and lower(f_unaccent(s.term)) = ${normalizedQuery}
    `);
    return (rows.rows as { key: string }[]).map((r) => r.key);
  }

  /** Active versioned weights (SE-004); falls back to defaults. */
  async activeWeights(): Promise<{ weights: SearchWeights; version: string }> {
    const rows = await this.db.execute(sql`
      select version, weights from ranking_configs
      where key = 'search.ranking' and status = 'active'
      order by version desc limit 1
    `);
    const row = rows.rows[0] as { version: number; weights: SearchWeights } | undefined;
    if (!row) return { weights: DEFAULT_WEIGHTS, version: 'default' };
    return { weights: { ...DEFAULT_WEIGHTS, ...row.weights }, version: String(row.version) };
  }
}
