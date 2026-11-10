-- Run with psql -v ON_ERROR_STOP=1 -f outside db:migrate/BEGIN, after 0096.
-- On an interrupted build: inspect pg_index.indisvalid, DROP INDEX CONCURRENTLY
-- the affected index if invalid, then rerun this file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_campaign_deferred_idx
  ON notifications(push_deferred_until, id)
  WHERE kind = 'campaign' AND push_deferred_until IS NOT NULL
    AND push_sent_at IS NULL AND push_suppressed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS notification_push_deliveries_deferred
  ON notification_push_deliveries(deferred_until, event_id) WHERE status = 'deferred';
CREATE INDEX CONCURRENTLY IF NOT EXISTS notification_push_deliveries_attempting
  ON notification_push_deliveries(lease_until, event_id) WHERE status = 'attempting';
