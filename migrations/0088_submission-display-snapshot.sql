-- #801 / ADR-0048: follows 0087_taxonomy-version after rebase.
-- Additive, nullable; no Google backfill/provider calls during migration.
ALTER TABLE place_submissions ADD COLUMN display_snapshot jsonb;
--> statement-breakpoint
ALTER TABLE place_submissions ADD COLUMN display_refresh_started_at timestamptz;
