-- Rehearsal/pre-activation only: stop ALL readers/writers first.
-- Keep initialization audit and migration journal. Activated environments roll forward.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
LOCK TABLE room_invite_settings IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF (SELECT count(*) FROM room_invite_settings) <> 1 OR NOT EXISTS (
    SELECT 1 FROM room_invite_settings WHERE id = 1 AND ttl_seconds = 86400
      AND version = 1 AND updated_by_admin_id IS NULL
  ) OR EXISTS (SELECT 1 FROM audit_logs WHERE resource_type = 'room_invite_ttl'
    AND action <> 'room_invite_ttl.initialized') THEN
    RAISE EXCEPTION 'room invite setting has changed; roll forward';
  END IF;
END $$;
DROP TABLE room_invite_settings;
COMMIT;
