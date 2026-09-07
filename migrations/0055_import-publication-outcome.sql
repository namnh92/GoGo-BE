-- ADM-009 (#462) — why an imported row was, or was not, published.
--
-- The approval policy applies to every path that makes a place `published`,
-- and bulk import is one of them. A new imported place has never been verified
-- by anybody, so its publication is deferred — and a bulk result that reported
-- those rows as "published" would be lying to the operator who ran it.
--
-- One nullable column rather than a jsonb warning: the counts are read as a
-- group-by, an operator asks "how many are waiting on verification" months
-- later, and a reason encoded inside a warnings array is not something anyone
-- can query.
--
-- NULL means the row never asked to be published, which is most of them.
--
-- ---------------------------------------------------------------------------
-- Down:
--   ALTER TABLE place_ingest_rows DROP COLUMN publication_outcome;
--   DROP TYPE ingest_publication_outcome;
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE ingest_publication_outcome AS ENUM (
    'published',
    'deferred_mapping_unverified',
    'deferred_mapping_invalid',
    'deferred_no_active_dataset'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE place_ingest_rows
  ADD COLUMN IF NOT EXISTS publication_outcome ingest_publication_outcome;

CREATE INDEX IF NOT EXISTS place_ingest_rows_publication_idx
  ON place_ingest_rows (job_id, publication_outcome)
  WHERE publication_outcome IS NOT NULL;
