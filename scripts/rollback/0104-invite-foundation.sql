-- PRE-ACTIVATION ONLY. Stop every foundation caller first; backup/retention approval required.
-- Normally roll back by disabling CODE6/automatic jobs and retaining all schema/keys/fences.
-- This script deliberately refuses to destroy any issued generation, alias or durable fence.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
LOCK TABLE rooms, room_invites, share_links, users, room_invite_codes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM room_invite_codes)
    OR EXISTS (SELECT 1 FROM users WHERE host_share_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM rooms WHERE invitation_epoch<>0 OR automatic_invites_suppressed
      OR legacy_invites_revoked_at IS NOT NULL OR code6_backfill_completed_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM room_invites WHERE invitation_epoch<>0)
    OR EXISTS (SELECT 1 FROM share_links WHERE invitation_epoch<>0 OR path_version<>'LEGACY' OR host_share_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'invite foundation has durable state; retain schema and roll forward';
  END IF;
END;
$$;
DROP TABLE room_invite_codes;
DROP FUNCTION preserve_invite_code_generation();
DROP TRIGGER rooms_invitation_fence_monotonic ON rooms;
DROP FUNCTION preserve_room_invitation_fence();
ALTER TABLE rooms DROP COLUMN invitation_epoch, DROP COLUMN automatic_invites_suppressed,
  DROP COLUMN legacy_invites_revoked_at, DROP COLUMN code6_backfill_completed_at;
ALTER TABLE room_invites DROP COLUMN invitation_epoch;
ALTER TABLE share_links DROP CONSTRAINT share_links_path_metadata,
  DROP COLUMN path_version, DROP COLUMN host_share_id, DROP COLUMN invitation_epoch;
ALTER TABLE users DROP COLUMN host_share_id;
COMMIT;
