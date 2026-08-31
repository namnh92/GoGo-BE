-- Persist the column diagnostics an import job produces while parsing.
--
-- `unmappedHeaders` already existed, but only on the 201 body of
-- `POST /cms/place-imports`. The wizard navigates straight to the job detail
-- after creating, which refetches `GET /cms/place-imports/{jobId}` — a payload
-- that never carried the field. So the CMS chips that render it were wired to
-- an array that was always empty, and an editor never learned that `tags` or
-- `notes` had been dropped from their sheet.
--
-- `missing_required_columns` is the same class of fact from the other side:
-- which required column the file has no header for at all. With the
-- `source_row_id` fallback in place a file now imports without that column,
-- and this is what says so out loud instead of silently deriving identities.
--
-- Both are `tabName:value` strings, so a multi-tab sheet stays legible.
-- Backfill is deliberately absent: the headers of a job parsed before this
-- migration are not recoverable, and an empty array is the honest answer.
--
-- Down:
--   ALTER TABLE place_ingest_jobs DROP COLUMN IF EXISTS missing_required_columns;
--   ALTER TABLE place_ingest_jobs DROP COLUMN IF EXISTS unmapped_headers;
ALTER TABLE place_ingest_jobs
  ADD COLUMN IF NOT EXISTS unmapped_headers jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE place_ingest_jobs
  ADD COLUMN IF NOT EXISTS missing_required_columns jsonb NOT NULL DEFAULT '[]'::jsonb;
