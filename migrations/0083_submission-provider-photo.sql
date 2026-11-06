-- Nullable, no backfill: existing media retain their provenance.
ALTER TABLE place_media ADD COLUMN provider_photo jsonb;
-- Rollback: remove approved #786 objects using their cleanup queue before
-- ALTER TABLE place_media DROP COLUMN provider_photo; see ADR-0035.
