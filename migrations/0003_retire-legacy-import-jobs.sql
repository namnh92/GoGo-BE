-- Retire the legacy JSON place importer (CMS-009).
-- /cms/place-imports is now the only import path: it resolves through the
-- provider, runs dedup and writes a provider snapshot, none of which the old
-- endpoint did. The table is dropped rather than left orphaned; it never
-- carried data outside dev (verified empty before this migration).
DROP TABLE "import_jobs" CASCADE;--> statement-breakpoint
DROP TYPE "public"."import_job_status";