-- Run ONLY after deployment attestations: workers_ready, api_guards_ready and
-- clients_ready mean verified fleet/consumer evidence, never merely CI green.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '3s';
-- Deferred ownership constraints + mixed-version creator trigger protect all new
-- writes. Validate the legacy population in one snapshot without table locks
-- that would block room writers for the duration of a full preflight scan.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM rooms WHERE created_by_user_id IS NULL) THEN
    RAISE EXCEPTION 'creator backfill incomplete';
  END IF;
  IF EXISTS (SELECT r.id FROM rooms r LEFT JOIN room_members m ON m.room_id=r.id AND m.role='host' AND m.removed_at IS NULL
    GROUP BY r.id HAVING count(m.id)<>1 OR count(m.id) FILTER (WHERE m.user_id=r.host_user_id AND m.guest_session_id IS NULL)<>1) THEN
    RAISE EXCEPTION 'ownership preflight failed; run preflight-room-host-transfer.sql';
  END IF;
  UPDATE room_host_transfer_rollout SET preflight_passed=true,enabled=true WHERE singleton;
  IF NOT room_host_transfer_ready() THEN RAISE EXCEPTION 'host transfer deployment/schema readiness incomplete'; END IF;
END $$;
COMMIT;
