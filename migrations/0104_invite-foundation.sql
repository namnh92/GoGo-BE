-- GoGo-BE#889 / I03. Expand only, CODE6 remains unreachable/off.
-- Populated-table validation/index scans run AFTER COMMIT via scripts/ops/prepare-invite-foundation.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
--> statement-breakpoint
ALTER TABLE rooms
  ADD COLUMN invitation_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN automatic_invites_suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN legacy_invites_revoked_at timestamptz,
  ADD COLUMN code6_backfill_completed_at timestamptz;
ALTER TABLE rooms ADD CONSTRAINT rooms_invitation_epoch_nonnegative CHECK (invitation_epoch >= 0) NOT VALID;
ALTER TABLE room_invites ADD COLUMN invitation_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE room_invites ADD CONSTRAINT room_invites_epoch_nonnegative CHECK (invitation_epoch >= 0) NOT VALID;
ALTER TABLE users ADD COLUMN host_share_id text;
ALTER TABLE users ADD CONSTRAINT users_host_share_id_format CHECK (host_share_id ~ '^[A-Za-z0-9_-]{21}[AQgw]$') NOT VALID;
ALTER TABLE share_links ADD COLUMN path_version text NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN host_share_id text,
  ADD COLUMN invitation_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD CONSTRAINT share_links_epoch_nonnegative CHECK (invitation_epoch >= 0) NOT VALID;
ALTER TABLE share_links ADD CONSTRAINT share_links_path_metadata CHECK (
  (path_version = 'LEGACY' AND host_share_id IS NULL) OR
  (path_version = 'HOST_V1' AND type = 'ROOM_INVITE' AND invite_id IS NOT NULL
    AND host_share_id IS NOT NULL AND host_share_id ~ '^[A-Za-z0-9_-]{21}[AQgw]$')
) NOT VALID;
--> statement-breakpoint
CREATE TABLE room_invite_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  invitation_epoch bigint NOT NULL,
  code_lookup text NOT NULL,
  code_ciphertext text NOT NULL,
  encryption_key_version text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reservation_state text NOT NULL DEFAULT 'OPEN',
  released_at timestamptz,
  release_reason text,
  created_by_member_id uuid NOT NULL,
  CONSTRAINT room_invite_codes_epoch_nonnegative CHECK (invitation_epoch >= 0),
  CONSTRAINT room_invite_codes_lookup_format CHECK (code_lookup ~ '^[0-9a-f]{64}$'),
  CONSTRAINT room_invite_codes_ciphertext_format CHECK (code_ciphertext ~ '^[A-Za-z0-9_-]{46}$'),
  CONSTRAINT room_invite_codes_key_version_format CHECK (encryption_key_version ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT room_invite_codes_lifetime CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '48 hours'),
  CONSTRAINT room_invite_codes_reservation_state CHECK (
    (reservation_state = 'OPEN' AND revoked_at IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (reservation_state = 'CLOSED' AND released_at IS NOT NULL AND released_at >= issued_at
      AND release_reason IS NOT NULL AND release_reason IN ('EXPIRY','START','CLOSE','ROTATE','REVOKE')
      AND (revoked_at IS NULL OR (revoked_at >= issued_at AND revoked_at <= released_at)))
  )
);
-- New empty table only: no existing-table index build in the Drizzle transaction.
CREATE UNIQUE INDEX room_invite_codes_open_lookup_unique ON room_invite_codes(code_lookup) WHERE reservation_state = 'OPEN';
CREATE UNIQUE INDEX room_invite_codes_open_room_unique ON room_invite_codes(room_id) WHERE reservation_state = 'OPEN';
CREATE INDEX room_invite_codes_history_idx ON room_invite_codes(room_id, issued_at);
--> statement-breakpoint
CREATE FUNCTION preserve_room_invitation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invitation_epoch < OLD.invitation_epoch
    OR (OLD.automatic_invites_suppressed AND NOT NEW.automatic_invites_suppressed)
    OR (OLD.legacy_invites_revoked_at IS NOT NULL AND NEW.legacy_invites_revoked_at IS DISTINCT FROM OLD.legacy_invites_revoked_at)
    OR (OLD.code6_backfill_completed_at IS NOT NULL AND NEW.code6_backfill_completed_at IS DISTINCT FROM OLD.code6_backfill_completed_at)
  THEN
    RAISE EXCEPTION 'invitation fence cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rooms_invitation_fence_monotonic BEFORE UPDATE OF invitation_epoch, automatic_invites_suppressed, legacy_invites_revoked_at, code6_backfill_completed_at ON rooms
  FOR EACH ROW EXECUTE FUNCTION preserve_room_invitation_fence();
CREATE FUNCTION preserve_invite_code_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.room_id, NEW.invitation_epoch, NEW.code_lookup, NEW.issued_at, NEW.expires_at, NEW.created_by_member_id)
     IS DISTINCT FROM ROW(OLD.id, OLD.room_id, OLD.invitation_epoch, OLD.code_lookup, OLD.issued_at, OLD.expires_at, OLD.created_by_member_id)
    OR (OLD.reservation_state = 'CLOSED' AND NEW.reservation_state <> 'CLOSED')
    OR (OLD.released_at IS NOT NULL AND ROW(NEW.released_at, NEW.release_reason, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.released_at, OLD.release_reason, OLD.revoked_at))
  THEN
    RAISE EXCEPTION 'invite generation is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER room_invite_codes_generation_immutable BEFORE UPDATE ON room_invite_codes
  FOR EACH ROW EXECUTE FUNCTION preserve_invite_code_generation();
SET LOCAL lock_timeout TO DEFAULT;
SET LOCAL statement_timeout TO DEFAULT;
