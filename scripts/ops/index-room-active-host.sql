-- AUTOCOMMIT, never run inside the migration transaction.
SET lock_timeout = '3s';
SET statement_timeout = '15min';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS room_members_active_host_unique
  ON public.room_members (room_id) WHERE role = 'host' AND removed_at IS NULL;
-- Verify exact definition/validity with room_host_transfer_ready; IF NOT EXISTS
-- does not validate a pre-existing index. On failure: disable transfer, DROP
-- INDEX CONCURRENTLY public.room_members_active_host_unique, rebuild, preflight.

-- Preserve indexed CMS historical creator counts throughout backfill/activation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rooms_creator_idx
  ON public.rooms ((coalesce(created_by_user_id, host_user_id)));
