-- Repeat in AUTOCOMMIT until UPDATE 0. Transfer must stay disabled throughout.
SET lock_timeout = '3s';
WITH batch AS (
  SELECT id FROM rooms WHERE created_by_user_id IS NULL ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED
)
UPDATE rooms r SET created_by_user_id = r.host_user_id FROM batch WHERE r.id = batch.id;
