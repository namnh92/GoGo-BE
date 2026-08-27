-- BE-BFF-010 (#59) — retry that gives up, and fan-out that can be repeated.
--
-- Two defects the dispatcher had:
--
-- 1. A failing event was retried forever with no backoff. The batch is ordered
--    by occurred_at and capped, so a poison event sits at the head and is
--    re-picked every 5 seconds; fifty of them starve every newer event behind
--    them. Retry without a give-up is not resilience, it is a stall.
--
-- 2. Delivery is at-least-once and the fan-out was not idempotent: a push
--    failure after the notification rows were inserted meant the retry
--    inserted them again, so a user saw the same notification twice.

alter table outbox_events
  -- When this event may next be attempted. Null means "now".
  add column if not exists next_attempt_at timestamptz,
  -- Set when the event has exhausted its attempts: it stops being selected,
  -- and stops blocking the queue, while staying inspectable. Not deleted —
  -- the failure is the thing worth keeping.
  add column if not exists failed_at timestamptz;

-- The dispatcher's actual selection: due, unpublished, not dead-lettered.
create index if not exists outbox_events_due_idx
  on outbox_events (occurred_at)
  where published_at is null and failed_at is null;

alter table notifications
  -- The event that produced this row. Makes redelivery a no-op instead of a
  -- duplicate in someone's inbox.
  add column if not exists dedupe_key text;

create unique index if not exists notifications_dedupe_idx
  on notifications (user_id, dedupe_key)
  where dedupe_key is not null;

-- Rollback:
--   drop index if exists notifications_dedupe_idx;
--   alter table notifications drop column if exists dedupe_key;
--   drop index if exists outbox_events_due_idx;
--   alter table outbox_events drop column if exists next_attempt_at, drop column if exists failed_at;
