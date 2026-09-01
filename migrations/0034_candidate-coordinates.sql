-- PR #347 — Google coordinates out of `place_ingest_rows.candidates`.
--
-- Google Maps Platform Service Specific Terms §14.3 caps Places latitude and
-- longitude at 30 consecutive calendar days, after which they must be deleted.
-- Nothing in GoGo expired these: the column has no TTL and no purge job.
--
-- The audit that preceded this change (issue #347) found the coordinates are
-- never read back. `confirmCandidate` uses `googlePlaceId` as an allow-list and
-- then re-resolves the place live; distance scoring runs against the provider
-- response still in memory, not against the stored row; the CMS candidate
-- drawer renders name, address, rating and photo but no coordinate; and
-- `lat`/`lng` were never in the OpenAPI candidate shape, so they have never
-- left the backend at all.
--
-- That turns a retention question into a deletion one. A 30-day expiry job
-- would be machinery whose only purpose is to eventually remove a value nobody
-- wanted; removing the writer instead means the value cannot come back, and
-- there is no job left to fail silently. This migration clears what the old
-- writer already stored.
--
-- Every other candidate field is preserved exactly. `name`, `address` and the
-- minimal-representation question are ADR-0006 §9.3 "needs decision", blocked
-- on the §9.6 signatures, and are issue #346's business — not this one's.
--
-- Idempotent: the predicate matches only rows that still carry a coordinate,
-- so a second run updates nothing. Forward-only; coordinates are not
-- recoverable, which is the point.
--
-- `updated_at` is left alone. It is written by the ingestion service to mark
-- editorial and resolver activity, and there is no trigger on this table, so a
-- compliance purge does not need to look like someone worked the row.
--
-- Down:
--   None. §14.3 requires the deletion; restoring the values would undo
--   compliance, and the source data is re-fetchable from Google on demand.
UPDATE place_ingest_rows r
SET candidates = coalesce(
      (
        SELECT jsonb_agg(elem - 'lat' - 'lng' ORDER BY ord)
        FROM jsonb_array_elements(r.candidates) WITH ORDINALITY AS t(elem, ord)
      ),
      '[]'::jsonb
    )
WHERE jsonb_path_exists(r.candidates, '$[*].lat')
   OR jsonb_path_exists(r.candidates, '$[*].lng');
