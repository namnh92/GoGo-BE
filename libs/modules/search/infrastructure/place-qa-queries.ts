import { sql, type SQL } from 'drizzle-orm';
import { schema } from '@gogo/database';
import type { PlaceNameArea } from '../../assistant/domain/place-qa/resolution';
import { publicAreaSummarySql, notProviderClosed } from './search.repository';

const textArray = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/**
 * `normalizeVietnamese` collapses every whitespace run and trims; the
 * `places_normalize_name` trigger only lowercases and unaccents. Whole-name
 * equality is therefore decided on this column-side key, so `Mây Lam` and
 * `Mây  Lam` are ONE exact family for either input instead of one exact row
 * plus a fuzzy twin. Mandatory post-0102 ops indexes exactly this expression
 * (`places_name_key_idx`); the resolver requires it before querying.
 */
export const placeNameKeySql = schema.placeNameKey;

/**
 * EXPLAIN this function, not a separately maintained SQL copy. Alias channels deduplicate by place id before cutoff.
 * `readings` are the longer whole-name readings of the same message
 * (`PlaceNameAlternate`): exact-equality probes only, never fuzzy. `scoped`
 * ones share the stated area; `unscoped` ones swallowed the area text itself.
 */
export function resolvePlaceNameQuery(
  variants: readonly string[],
  limit: number,
  area?: Extract<PlaceNameArea, { kind: 'current' }>,
  readings: { scoped: readonly string[]; unscoped: readonly string[] } = {
    scoped: [],
    unscoped: [],
  },
): SQL {
  const published = sql`p.status = 'published' and ${notProviderClosed()}`;
  const eligible = sql`${published} ${area ? sql`and p.administrative_mapping_status = 'VERIFIED' and p.administrative_dataset_version = ${area.datasetVersion} and p.province_code = ${area.provinceCode} ${area.communeCode ? sql`and p.commune_code = ${area.communeCode}` : sql``}` : sql``}`;
  const key = placeNameKeySql(sql`p.name_normalized`);
  const fuzzy = variants.map(
    (span) => sql`(
    select p.id, false as exact,
      greatest(word_similarity(${span}, p.name_normalized), similarity(p.name_normalized, ${span}))::float8 as score
    from places p where ${eligible}
      and (${span} <% p.name_normalized or p.name_normalized % ${span}
        or p.search_tsv @@ websearch_to_tsquery('simple', ${span}))
    order by score desc, p.id limit ${limit + 1}
  )`,
  );
  // Separate indexed scans keep alias support from turning name equality into
  // a correlated OR over the whole catalog. Both exact channels are complete.
  const exactChannel = (names: readonly string[], policy: SQL) => sql`
    select p.id, true as exact, 1::float8 as score from places p
    where ${policy} and ${key} = any(${textArray(names)})
    union all
    select p.id, true as exact, 1::float8 as score
    from place_aliases a join places p on p.id=a.place_id
    where ${policy} and a.alias_normalized = any(${textArray(names)})
    group by p.id`;
  const aliasFuzzy = variants.map(
    (span) => sql`(
    select p.id, false as exact,
      max(greatest(word_similarity(${span}, a.alias_normalized), similarity(a.alias_normalized, ${span})))::float8 as score
    from place_aliases a join places p on p.id=a.place_id
    where ${eligible} and (${span} <% a.alias_normalized or a.alias_normalized % ${span})
    group by p.id order by score desc, p.id limit ${limit + 1}
  )`,
  );
  return sql`with exact_matches as (
    ${exactChannel([...new Set([...variants, ...readings.scoped])], eligible)}
    ${readings.unscoped.length ? sql`union all ${exactChannel([...new Set(readings.unscoped)], published)}` : sql``}
  ), merged as (
    select id, bool_or(exact) as exact, max(score) as score from (
      select * from exact_matches union all ${sql.join([...fuzzy, ...aliasFuzzy], sql` union all `)}
    ) channels group by id
  ) select id, exact, score, count(*) over()::int as distinct_count
    from merged order by exact desc, score desc, id limit ${Math.max(limit + 1, 4)}`;
}

/**
 * One statement: publication, closure, identity and each source share the snapshot.
 * The review aggregate is one pass over exactly the rows behind count/mean and
 * returns the oldest AND newest evidence instants: the projection rejects the
 * rating when any published review lacks moderation evidence or is future-dated.
 */
export function placeFactsQuery(ids: readonly string[], detailQuery?: SQL): SQL {
  return sql`select p.id, p.status, not (${notProviderClosed()}) as provider_closed,
    ${detailQuery ? sql`(select row_to_json(detail) from (${detailQuery}) detail where detail.id=p.id)` : sql`null`} as card_detail,
    exists(select 1 from places peer where peer.id <> p.id and peer.status='published'
      and ${placeNameKeySql(sql`peer.name_normalized`)} = ${placeNameKeySql(sql`p.name_normalized`)}
      and peer.administrative_dataset_version is not distinct from p.administrative_dataset_version
      and peer.province_code is not distinct from p.province_code
      and peer.commune_code is not distinct from p.commune_code) as identity_collision,
    p.name, ST_Y(p.geom) as lat, ST_X(p.geom) as lng,
    ${publicAreaSummarySql('vi')} as area_summary,
    (select u.name from administrative_units u join administrative_dataset_versions d on d.id=u.dataset_version_id
      where d.status='PUBLISHED' and d.combined_dataset_version=p.administrative_dataset_version
        and p.administrative_mapping_status='VERIFIED' and u.level='PROVINCE' and u.code=p.province_code
        and u.status='ACTIVE' and u.effective_from<=current_date and (u.effective_to is null or u.effective_to>=current_date)
      order by u.effective_from desc limit 1) as province_name, p.address_text, p.phone, p.suitability,
    coalesce((select json_agg(json_build_object('kind',t.kind,'key',t.key,'active',t.is_active))
      from place_taxonomies pt join taxonomies t on t.id=pt.taxonomy_id where pt.place_id=p.id), '[]'::json) as taxonomies,
    coalesce((select json_agg(json_build_object('provider',ps.provider,'rating',ps.rating::text,
      'rating_count',ps.rating_count,'fetched_at',ps.fetched_at,'refresh_after',ps.refresh_after,'attribution',ps.attribution))
      from place_provider_sources ps where ps.place_id=p.id), '[]'::json) as provider_sources,
    coalesce((select json_agg(json_build_object('field', fp.field, 'source_type', fp.source_type,
      'source_reference', fp.source_reference, 'collected_at', fp.collected_at, 'verified_at', fp.verified_at))
      from place_field_provenance fp where fp.place_id=p.id and fp.field in ('address_text','phone')), '[]'::json) as provenance,
    coalesce((select json_agg(json_build_object('day_of_week', h.day_of_week, 'entry_kind', h.entry_kind,
      'open_minute', h.open_minute, 'close_minute', h.close_minute, 'is_overnight', h.is_overnight,
      'source', h.source, 'verified_at', h.verified_at) order by h.day_of_week, h.open_minute, h.id)
      from place_hours h where h.place_id=p.id), '[]'::json) as hours,
    coalesce((select json_agg(json_build_object('price_min', pp.price_min::text, 'price_max', pp.price_max::text,
      'currency', pp.currency, 'unit', pp.unit, 'confidence', pp.confidence::text,
      'source', pp.source, 'verified_at', pp.verified_at) order by pp.verified_at desc nulls last, pp.id)
      from place_prices pp where pp.place_id=p.id), '[]'::json) as prices,
    gr.gogo_rating_count, gr.gogo_rating_mean, gr.gogo_rating_verified_at, gr.gogo_rating_collected_at,
    gr.gogo_rating_latest_verified_at, gr.gogo_rating_latest_collected_at
    from places p
    left join lateral (
      select count(*)::int as gogo_rating_count,
        round(avg(r.rating)::numeric,1)::text as gogo_rating_mean,
        case when count(*) = count(r.first_published_at) then min(r.first_published_at)::text end as gogo_rating_verified_at,
        min(r.created_at)::text as gogo_rating_collected_at,
        case when count(*) = count(r.first_published_at) then max(r.first_published_at)::text end as gogo_rating_latest_verified_at,
        max(r.created_at)::text as gogo_rating_latest_collected_at
      from reviews r where r.place_id=p.id and r.status='published'
    ) gr on true
    where p.id = any((${textArray(ids)})::uuid[])`;
}
