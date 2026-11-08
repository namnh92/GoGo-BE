-- GoGo-BE#811 PR1 / ADR-0050. Short DDL only; no fleet-wide UPDATE or index build.
-- Run `pnpm inbox:backfill` after this migration (bounded commits + concurrent
-- indexes). The trigger covers ALL producers, including binaries predating this
-- migration: no late old-writer commit can insert below an issued cutoff.
-- Rollback: disable cutoff APIs, stop read-all ticks, retain additive tables,
-- trigger, indexes and read markers. Do not roll back read_at. Physical down is
-- a later maintenance migration after draining clients/operations, not deploy.
ALTER TABLE notifications ADD COLUMN inbox_sequence bigint;
--> statement-breakpoint
CREATE TABLE notification_inbox_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);
--> statement-breakpoint
CREATE TABLE notification_inbox_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ready boolean NOT NULL DEFAULT false
);
INSERT INTO notification_inbox_rollout VALUES (true, false);
--> statement-breakpoint
CREATE TABLE notification_read_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cutoff bigint NOT NULL CHECK (cutoff >= 0),
  action_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  changed_count bigint NOT NULL DEFAULT 0 CHECK (changed_count >= 0)
);
CREATE INDEX notification_read_operations_running_idx
  ON notification_read_operations (action_at, id) WHERE status = 'running';
--> statement-breakpoint
CREATE FUNCTION allocate_notification_inbox_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- This row lock survives until the outer insert transaction commits. Never
  -- trust a producer-supplied sequence; duplicate inserts may leave safe gaps.
  INSERT INTO notification_inbox_state(user_id, last_sequence)
    VALUES (NEW.user_id, 1)
    ON CONFLICT (user_id) DO UPDATE
      SET last_sequence = notification_inbox_state.last_sequence + 1
    RETURNING last_sequence INTO NEW.inbox_sequence;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_allocate_sequence
  BEFORE INSERT ON notifications FOR EACH ROW
  EXECUTE FUNCTION allocate_notification_inbox_sequence();
