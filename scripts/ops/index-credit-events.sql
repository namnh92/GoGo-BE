-- psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f scripts/ops/index-credit-events.sql
-- Autocommit ONLY, never wrap in BEGIN or the migration runner.
SET lock_timeout = '5s';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS credit_entitlements_event_key_unique ON credit_entitlements(event_id,key);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS credit_evaluations_event_unique ON credit_evaluations(event_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS assistant_credit_event_user ON assistant_credit_ledger(credit_event_id,user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS assistant_credit_event_group ON assistant_credit_ledger(credit_event_id,group_source_key,group_grant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_entitlements_ledger ON credit_entitlements(ledger_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_outbox_candidates ON outbox_events(occurred_at,id)
 WHERE event_type IN ('place.submission_decided','place.submission_evidence_approved','review.published','room.completed');
-- IF NOT EXISTS does NOT repair an invalid index from an interrupted build.
-- Inspect pg_index; drop the invalid index CONCURRENTLY, then retry this file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS assistant_credit_legacy_pending ON assistant_credit_ledger(id) WHERE reason='submission_approved' AND credit_event_id IS NULL;
RESET lock_timeout;
