-- Stop photo submission traffic and the API processes writing this table first.
-- Prefer application rollback with the additive table left in place.
BEGIN;
-- Pending/rejected derivatives have no public place_media reference. Preserve
-- already approved contributions and their uploader credits in place_media.
INSERT INTO media_cleanup_queue (bucket, object_key, reason, next_attempt_at)
SELECT 'private', p.storage_key, 'submission_photos_schema_rollback', now() + interval '7 days'
FROM place_submission_photos p
WHERE NOT EXISTS (SELECT 1 FROM place_media m WHERE m.storage_key = p.storage_key)
ON CONFLICT DO NOTHING;
DROP TABLE place_submission_photos;
COMMIT;
