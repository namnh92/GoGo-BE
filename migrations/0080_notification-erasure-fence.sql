-- All producers, including old binaries/raw SQL, share the erasure fence.
-- Match deletion's user-first lock order, before the inbox counter lock.
-- Retain this additive guard on binary rollback.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Drain inserts already running the old function, including when 0079 was
-- applied in an earlier rollout. Readers continue; new inserts wait for commit.
LOCK TABLE notifications IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION allocate_notification_inbox_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_status text;
BEGIN
  -- SHARE conflicts with deletion's UPDATE/NO KEY UPDATE. If insertion wins,
  -- erasure subsequently removes its rows; if deletion wins, skip the insert
  -- before it can recreate either the inbox or its sequence state.
  SELECT status INTO account_status FROM users WHERE id = NEW.user_id FOR SHARE;
  IF account_status = 'deleted' THEN
    RETURN NULL;
  END IF;
  INSERT INTO notification_inbox_state(user_id, last_sequence)
    VALUES (NEW.user_id, 1)
    ON CONFLICT (user_id) DO UPDATE
      SET last_sequence = notification_inbox_state.last_sequence + 1
    RETURNING last_sequence INTO NEW.inbox_sequence;
  RETURN NEW;
END $$;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
