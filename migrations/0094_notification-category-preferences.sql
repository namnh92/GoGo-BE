SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #815 / 0093 must be rebased first. Additive DDL only; absent categories mean true.
-- A constant default is metadata-only (no rewrite). The CHECK is NOT VALID so no
-- row of this hot table is scanned under ACCESS EXCLUSIVE; new writes are checked
-- at once. Drizzle commits every pending file in one transaction, so validate
-- only AFTER db:migrate returns: scripts/ops/validate-notification-settings-version.sql.
ALTER TABLE notification_settings ADD COLUMN version bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE notification_settings ADD CONSTRAINT notification_settings_version_check CHECK (version >= 0) NOT VALID;
--> statement-breakpoint
CREATE TABLE notification_category_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('invite', 'preference_reminder', 'plan_ready', 'plan_changed', 'date_reminder')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);
--> statement-breakpoint
CREATE TABLE notification_category_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  writes_frozen boolean NOT NULL DEFAULT false,
  producers_frozen boolean NOT NULL DEFAULT false,
  recipient_keys_enabled boolean NOT NULL DEFAULT false,
  cutover_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_category_rollout(singleton) VALUES (true);
--> statement-breakpoint
-- SHARE makes the fence wait for in-flight producer transactions to commit.
-- Applies to old binaries too; workers may still drain existing outbox rows.
CREATE FUNCTION guard_notification_outbox_producers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM notification_category_rollout WHERE singleton AND NOT producers_frozen FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outbox producers frozen for notification worker transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_outbox_producer_freeze BEFORE INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION guard_notification_outbox_producers();
--> statement-breakpoint
CREATE TABLE notification_push_deliveries (
  event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'attempting', 'sent', 'suppressed', 'failed', 'no_target')),
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id, user_id)
);
--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN push_suppressed_at timestamptz;
--> statement-breakpoint
-- Old binaries must also respect the rollback write freeze. Erasure remains allowed.
CREATE FUNCTION guard_notification_preference_writes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM notification_category_rollout WHERE singleton AND NOT writes_frozen FOR SHARE;
  IF NOT FOUND AND current_setting('gogo.notification_rollback', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Notification preference writes frozen' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_settings_freeze BEFORE INSERT OR UPDATE ON notification_settings
  FOR EACH ROW EXECUTE FUNCTION guard_notification_preference_writes();
CREATE TRIGGER notification_preferences_freeze BEFORE INSERT OR UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION guard_notification_preference_writes();
CREATE TRIGGER notification_categories_freeze BEFORE INSERT OR UPDATE ON notification_category_preferences
  FOR EACH ROW EXECUTE FUNCTION guard_notification_preference_writes();

--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
