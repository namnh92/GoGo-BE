-- GoGo-BE#256, ADR-0031 — secure export delivery: encrypted artifact,
-- expiring single-use redemption, auto-delete.
--
-- Additive only:
--   * `users.export_epoch` — ADD COLUMN with a constant DEFAULT is a
--     catalogue-only change on Postgres 11+ (no table rewrite).
--   * a BEFORE UPDATE trigger that bumps the epoch when the password hash
--     changes or the account becomes `deleted`, and an AFTER UPDATE trigger
--     that revokes every live artifact of that account in the same
--     transaction. Enforced here rather than in application code so a future
--     password-change endpoint cannot forget it.
--   * a new enum, a new table, a new notification kind.
--
-- Lock wait is bounded: if a long transaction holds `users`, the ALTER gives
-- up after 5s (SQLSTATE 55P03) and the whole migrator run rolls back; retry
-- once the holder is gone.
--
-- Rollback (ADR-0031 §Rollback): disable issuance (unset
-- EXPORT_WRAPPING_KEY_* on the API so creation answers 503) and keep the
-- worker sweep running until every artifact is cleaned; the schema stays.
-- Rehearsal-only down, in this order (the enum value cannot be removed from
-- `notification_kind` without rebuilding the type, so it stays):
--   DROP TRIGGER users_export_epoch_revoke ON users;
--   DROP TRIGGER users_export_epoch_bump ON users;
--   DROP FUNCTION privacy_export_revoke_on_epoch();
--   DROP FUNCTION privacy_export_bump_epoch();
--   DROP TABLE privacy_export_attempt_objects;
--   DROP TABLE privacy_export_artifacts;
--   DROP TYPE privacy_export_state;
--   ALTER TABLE privacy_requests DROP COLUMN secure_delivery;
--   ALTER TABLE users DROP COLUMN export_epoch;
-- The idempotency purge below is a one-way data step (it removes stored raw
-- export payloads); it has nothing to undo.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS export_epoch integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- PR #677 A-F-06 — the ledger row itself records that its delivery belongs to
-- the server (a secure export was issued for it). Outlives artifact purges.
ALTER TABLE privacy_requests ADD COLUMN IF NOT EXISTS secure_delivery boolean NOT NULL DEFAULT false;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
--> statement-breakpoint
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'privacy_export_ready';
--> statement-breakpoint
CREATE TYPE privacy_export_state AS ENUM (
  'pending', 'generating', 'ready', 'consumed', 'expired', 'revoked', 'failed'
);
--> statement-breakpoint
CREATE TABLE privacy_export_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  privacy_request_id uuid REFERENCES privacy_requests(id) ON DELETE SET NULL,
  initiator_type text NOT NULL,
  initiator_id uuid NOT NULL,
  state privacy_export_state NOT NULL DEFAULT 'pending',
  subject_epoch integer NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  generation_failures integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  object_key text,
  format_version smallint,
  key_version integer,
  wrapped_key bytea,
  wrap_nonce bytea,
  wrap_tag bytea,
  plaintext_bytes integer,
  ciphertext_bytes integer,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  expires_at timestamptz,
  consumed_at timestamptz,
  consumed_session_id uuid,
  transfer_completed_at timestamptz,
  transfer_outcome text,
  revoked_at timestamptz,
  revoke_reason text,
  expired_at timestamptz,
  failed_at timestamptz,
  cleanup_due_at timestamptz,
  cleanup_attempts integer NOT NULL DEFAULT 0,
  cleanup_last_error text,
  cleanup_dead_at timestamptz,
  cleaned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT privacy_export_artifacts_initiator CHECK (initiator_type IN ('user', 'admin')),
  CONSTRAINT privacy_export_artifacts_ready_shape CHECK (
    state <> 'ready' OR (object_key IS NOT NULL AND wrapped_key IS NOT NULL
      AND expires_at IS NOT NULL AND ready_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX privacy_export_artifacts_one_active ON privacy_export_artifacts (subject_user_id)
  WHERE state IN ('pending', 'generating', 'ready');
--> statement-breakpoint
CREATE INDEX privacy_export_artifacts_subject_created_idx
  ON privacy_export_artifacts (subject_user_id, created_at);
--> statement-breakpoint
CREATE INDEX privacy_export_artifacts_work_idx ON privacy_export_artifacts (next_attempt_at)
  WHERE state IN ('pending', 'generating');
--> statement-breakpoint
CREATE INDEX privacy_export_artifacts_expiry_idx ON privacy_export_artifacts (expires_at)
  WHERE state = 'ready';
--> statement-breakpoint
CREATE INDEX privacy_export_artifacts_cleanup_idx ON privacy_export_artifacts (cleanup_due_at)
  WHERE cleanup_due_at IS NOT NULL AND cleaned_at IS NULL AND cleanup_dead_at IS NULL;
--> statement-breakpoint
-- PR #677 F-04 — one durable deletion record per upload attempt, written
-- before the upload starts and removed only when that attempt is published.
-- Anything else (fenced, revoked, crashed, retried) is deleted from storage
-- once `delete_after` has passed — after the attempt's upload can no longer
-- complete — so a late PUT cannot outlive its record.
CREATE TABLE privacy_export_attempt_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL,
  object_key text NOT NULL,
  delete_after timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  dead_at timestamptz,
  -- PR #677 A-F-10: set when the reaper takes deletion ownership; publication
  -- only removes an unclaimed record, so the two are mutually exclusive.
  reaping_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT privacy_export_attempt_objects_key_unique UNIQUE (object_key)
);
--> statement-breakpoint
CREATE INDEX privacy_export_attempt_objects_due_idx ON privacy_export_attempt_objects (delete_after)
  WHERE dead_at IS NULL;
--> statement-breakpoint
-- The epoch only ever moves forward, and only for the two events that must
-- revoke an export. A direct write to export_epoch is refused: nothing in the
-- application sets it, and a decrement would revive revoked artifacts.
CREATE FUNCTION privacy_export_bump_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.export_epoch IS DISTINCT FROM OLD.export_epoch THEN
    RAISE EXCEPTION 'users.export_epoch is maintained by trigger only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted') THEN
    NEW.export_epoch := OLD.export_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_export_epoch_bump
  BEFORE UPDATE OF password_hash, status, export_epoch ON users
  FOR EACH ROW EXECUTE FUNCTION privacy_export_bump_epoch();
--> statement-breakpoint
-- Same transaction as the credential change or erasure: every live artifact
-- is revoked, its wrapped key cleared and its cleanup made due. One audit row
-- per artifact, identifiers and a reason code only.
CREATE FUNCTION privacy_export_revoke_on_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reason text := CASE WHEN NEW.status = 'deleted' THEN 'account_deleted' ELSE 'password_changed' END;
BEGIN
  IF NEW.export_epoch IS DISTINCT FROM OLD.export_epoch THEN
    WITH revoked AS (
      UPDATE privacy_export_artifacts
      SET state = 'revoked',
          revoked_at = now(),
          revoke_reason = reason,
          wrapped_key = NULL,
          wrap_nonce = NULL,
          wrap_tag = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          cleanup_due_at = now(),
          updated_at = now()
      WHERE subject_user_id = NEW.id
        AND state IN ('pending', 'generating', 'ready')
      RETURNING id
    )
    INSERT INTO audit_logs (actor_type, action, resource_type, resource_id, diff)
    SELECT 'system', 'privacy_export.revoked', 'privacy_export', revoked.id::text,
           jsonb_build_object('reason', reason)
    FROM revoked;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_export_epoch_revoke
  AFTER UPDATE OF password_hash, status ON users
  FOR EACH ROW EXECUTE FUNCTION privacy_export_revoke_on_epoch();
--> statement-breakpoint
-- PR #677 A-F-09 — data step, run once by this migration before the new API
-- serves: the two CMS export routes used to return the raw export, and the
-- generic idempotency interceptor stored that response for replay (24 h).
-- Those stored payloads are purged here; the new routes also refuse to replay
-- any record that is not a versioned metadata-only record (rows an old
-- instance writes during a rolling deploy).
DELETE FROM idempotency_keys
WHERE endpoint IN (
  'POST /v1/cms/users/:id/export',
  'POST /v1/cms/privacy-requests/:id/execute'
);
