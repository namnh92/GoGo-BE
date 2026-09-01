import { sql, type SQL } from 'drizzle-orm';

/**
 * The one provider label Google identity is stored under.
 *
 * Before PR1 (#334) there were two — `place_sources.provider = 'google'`,
 * written by `/v1/places/imports`, and this one, written by bulk import and
 * mobile submission. Which of them a path happened to consult decided whether
 * it found an existing place or created a second one for the same Google Place
 * ID. Everything that reads or writes Google identity now names this constant.
 */
export const GOOGLE_PROVIDER = 'google_places';

/**
 * What the public contract calls Google provenance.
 *
 * `/v1` and the CMS have always seen `provider: 'google'` on a source row.
 * PR1 moves where the row is stored, not what a client is told, so the storage
 * label stays inside the backend and this one goes out.
 */
export const GOOGLE_PROVIDER_PUBLIC = 'google';

/**
 * Every provenance row for one place, from both tables, without doubles.
 *
 * Two things have to hold at once while the backfill rolls out. A place that
 * arrived through ingestion must finally show its attribution — it had none,
 * because the reader only ever looked at `place_sources`. And a place that
 * arrived through the legacy import must keep showing exactly what it showed
 * before, whether or not migration 0033 has run against this database yet.
 * Reading both tables and suppressing the legacy row once the canonical table
 * holds the same identity *for the same place* satisfies both.
 *
 * The `place_id` match in that suppression matters: where an external ID is
 * held by a different place the two rows are a genuine disagreement, parked in
 * `place_identity_conflicts` for a human. Hiding the legacy one would strip
 * attribution from a place that is still serving it.
 *
 * Columns: `id, provider, external_id, url, attribution, fetched_at`. Callers
 * select the subset their DTO exposes.
 *
 * @param placeId the place to read, as a SQL fragment (parameter or column).
 * @param unified `false` restores the pre-PR1 reader — `place_sources` alone.
 *   That is the rollback path, not a mode anything should stay in.
 */
export function googleProvenanceRows(placeId: SQL, unified: boolean): SQL {
  const legacy = sql`
    select s.id, s.provider::text as provider, s.external_id, s.url,
           s.attribution,
           coalesce(s.raw_updated_at, s.imported_at) as fetched_at
    from place_sources s
    where s.place_id = ${placeId}`;
  if (!unified) return legacy;
  return sql`
    select ps.id, ${GOOGLE_PROVIDER_PUBLIC}::text as provider, ps.external_id,
           ps.provider_uri as url,
           nullif(ps.attribution ->> 'text', '') as attribution,
           ps.fetched_at
    from place_provider_sources ps
    where ps.place_id = ${placeId} and ps.provider = ${GOOGLE_PROVIDER}
    union all
    ${legacy}
      and (
        s.provider <> 'google'
        or not exists (
          select 1 from place_provider_sources ps2
          where ps2.provider = ${GOOGLE_PROVIDER}
            and ps2.external_id = s.external_id
            and ps2.place_id = s.place_id
        )
      )`;
}
