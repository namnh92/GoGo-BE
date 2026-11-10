SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Constant defaults are metadata-only. No fleet-wide backfill under the DDL lock.
ALTER TABLE notification_settings
  ADD COLUMN quiet_hours_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN timezone text;
ALTER TABLE notification_settings ADD CONSTRAINT notification_quiet_timezone
  CHECK (NOT quiet_hours_enabled OR timezone IS NOT NULL) NOT VALID;
--> statement-breakpoint
CREATE TABLE notification_reminder_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT notification_reminder_jobs_status CHECK (status IN ('pending', 'cancelled', 'emitted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_reminder_jobs_room_start UNIQUE(room_id, starts_at)
);
CREATE INDEX notification_reminder_jobs_due ON notification_reminder_jobs(scheduled_for, id) WHERE status = 'pending';
--> statement-breakpoint
-- 0094's inline CHECK receives this PostgreSQL-generated name.
ALTER TABLE notification_push_deliveries DROP CONSTRAINT notification_push_deliveries_status_check;
ALTER TABLE notification_push_deliveries ADD CONSTRAINT notification_push_deliveries_status_check
  CHECK (status IN ('pending', 'attempting', 'deferred', 'sent', 'suppressed', 'failed', 'no_target')) NOT VALID;
ALTER TABLE notification_push_deliveries ADD COLUMN deferred_until timestamptz,
  ADD COLUMN deferred_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN push_deferred_until timestamptz,
  ADD COLUMN push_deferred_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE notification_campaigns ADD COLUMN quiet_pending boolean NOT NULL DEFAULT false;
-- Build indexes on the existing delivery ledger and inbox CONCURRENTLY via
-- scripts/ops/index-notification-deferred.sql before starting policy-aware workers.
SET LOCAL lock_timeout TO DEFAULT;
