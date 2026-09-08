-- ADM-017 (#497) — what an import row is going to be mapped to, before it is.
--
-- The operator reviewing an import needs to know which commune each row lands
-- in, and whether a person will have to look at it, *while the job is still
-- reviewable*. Until now nothing in the row said anything about it: the
-- administrative mapping was decided at publish time and only visible on the
-- place afterwards, so the one screen where an operator could still act on it
-- was the one screen that could not see it.
--
-- Stored rather than computed on read. The preview is a point-in-polygon query
-- against a pinned boundary release, and the job detail screen paginates
-- hundreds of rows; running it per row per render would turn a table refresh
-- into a boundary scan. Storing it also makes the preview *comparable* to what
-- the commit does — the two run the same resolver over the same geometry, and
-- a stored answer is what lets an operator see that they agreed.
--
-- Nullable throughout, and null is the ordinary state: a row that has not been
-- resolved against a provider yet has no geometry to classify.
--
-- ---------------------------------------------------------------------------
-- Down:
--   ALTER TABLE place_ingest_rows
--     DROP COLUMN administrative_province_code,
--     DROP COLUMN administrative_commune_code,
--     DROP COLUMN administrative_mapping_status,
--     DROP COLUMN administrative_dataset_version;
-- ---------------------------------------------------------------------------

ALTER TABLE place_ingest_rows
  ADD COLUMN IF NOT EXISTS administrative_province_code text,
  ADD COLUMN IF NOT EXISTS administrative_commune_code text,
  -- The same enum `places` uses. A second vocabulary for the same six states
  -- would need a mapping table between them within a release.
  ADD COLUMN IF NOT EXISTS administrative_mapping_status administrative_mapping_status,
  -- A code is not an identity: 2,212 of the 3,321 current commune codes named a
  -- different unit before 2025-07-01, so a preview without the release it was
  -- computed against cannot be compared with anything later.
  ADD COLUMN IF NOT EXISTS administrative_dataset_version text;

-- The count an operator asks for first: how many rows in this job need a human.
CREATE INDEX IF NOT EXISTS place_ingest_rows_administrative_status_idx
  ON place_ingest_rows (job_id, administrative_mapping_status)
  WHERE administrative_mapping_status IS NOT NULL;
