-- PR7 (COST-BE-007, #340) — the columns a liveness refresh needs, and the
-- index that makes "what is due" a bounded read.
--
-- Plan §0.1 D2 is explicit that there is **no new refresh table**: everything
-- below extends `place_provider_sources`, which already carries `fetched_at`
-- (last successful fetch) and `refresh_after` (due). Those two have been
-- written since the first ingestion migration and read by nobody — PR7 is what
-- reads them.
--
-- What each column is for:
--
--   refresh_priority         a person asked for this row sooner (CMS action,
--                            PR8). Ordering only; the job never sets it.
--   refresh_attempts         consecutive rejections of this Place ID. Reset by
--                            any successful answer.
--   last_refresh_attempt_at  when the job last asked, successful or not. The
--                            difference from `fetched_at` is the whole point:
--                            `fetched_at` moves only on success, so a row that
--                            is being asked about and refusing to resolve is
--                            visible as the gap between the two.
--   transient_failures       consecutive failures that were **ours or Google's**,
--                            not the row's: quota, outage, a disabled API. Kept
--                            apart from `refresh_attempts` because they mean
--                            opposite things — one is evidence about a Place ID,
--                            the other is evidence about a bad afternoon. Reset
--                            by any definitive answer.
--   last_refresh_error_code  why the last attempt failed: Google's canonical
--                            status (`NOT_FOUND`, `INVALID_ARGUMENT`),
--                            `EMPTY_ANSWER`, or a transport code
--                            (`QUOTA_EXCEEDED`, `PROVIDER_UNAVAILABLE`,
--                            `MISSING_CREDENTIAL`). A status code, not a
--                            message, and never a payload.
--   moved_to_external_id     the successor Place ID when Google names one.
--
-- `moved_to_external_id` is the only Google-derived value PR7 stores, and it is
-- a Place ID: Service Specific Terms §3 permits storing those indefinitely, and
-- ADR-0006 §9.3 lists it as allowed. Nothing else from a liveness answer is
-- persisted, because a liveness answer carries nothing else — no name, no
-- coordinates, no rating, no business status (plan §7, ADR-0006 §9.5).
--
-- The index is replaced rather than added to. `place_provider_sources_refresh_idx`
-- was `(refresh_after)` across every row, including the ones with `refresh_after
-- IS NULL` — dormant and moved rows, which the due query never wants. The
-- partial index on `(refresh_priority DESC, refresh_after ASC)` matches the due
-- query's ORDER BY exactly and excludes rows that are deliberately not due, so
-- a growing dormant set does not grow the index the job reads.
--
-- Down:
--   DROP INDEX place_provider_sources_refresh_due_idx;
--   CREATE INDEX place_provider_sources_refresh_idx ON place_provider_sources (refresh_after);
--   ALTER TABLE place_provider_sources
--     DROP COLUMN refresh_priority, DROP COLUMN refresh_attempts,
--     DROP COLUMN transient_failures,
--     DROP COLUMN last_refresh_attempt_at, DROP COLUMN last_refresh_error_code,
--     DROP COLUMN moved_to_external_id;
--   Additive columns with defaults, so the previous deployment runs unchanged
--   against this schema and a rollback needs no data movement.
ALTER TABLE place_provider_sources
  ADD COLUMN IF NOT EXISTS refresh_priority smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refresh_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transient_failures smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_refresh_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_refresh_error_code text,
  ADD COLUMN IF NOT EXISTS moved_to_external_id text;
--> statement-breakpoint
DROP INDEX IF EXISTS place_provider_sources_refresh_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS place_provider_sources_refresh_due_idx
  ON place_provider_sources (refresh_priority DESC, refresh_after ASC)
  WHERE refresh_after IS NOT NULL;
