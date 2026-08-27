-- BE-IMP-004 (b): re-syncing an edited sheet onto places that already exist.
-- Without it, correcting a price in the sheet and re-importing did nothing at
-- all: the row matched by provider id, was marked `duplicate`, and stopped.
ALTER TYPE ingest_job_mode ADD VALUE IF NOT EXISTS 'update_existing';
