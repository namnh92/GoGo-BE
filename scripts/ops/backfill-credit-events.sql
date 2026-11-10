-- #829 S1: psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f scripts/ops/backfill-credit-events.sql
-- One bounded transaction per invocation. Repeat until updated=0; interruption
-- rolls this batch back, and committed rows are skipped on restart.
-- ONLY historical publication stamps with positive audit evidence are filled.
-- Never update credit_epoch, infer publication from creation time, or invent
-- stamps for missing audits. Every old review remains ineligible (epoch NULL).
-- S2 adds legacy ledger attribution AFTER catalogue DDL + stable seeds exist.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
WITH batch AS (
  SELECT r.id,
    (SELECT min(a.created_at) FROM audit_logs a
     WHERE a.resource_type = 'review' AND a.resource_id = r.id::text
       AND a.action = 'review.moderated' AND a.diff->>'decision' = 'published') AS published_at
  FROM reviews r
  WHERE r.credit_epoch IS NULL AND r.first_published_at IS NULL
    AND EXISTS (SELECT 1 FROM audit_logs a
      WHERE a.resource_type = 'review' AND a.resource_id = r.id::text
        AND a.action = 'review.moderated' AND a.diff->>'decision' = 'published')
  ORDER BY r.id LIMIT 1000 FOR UPDATE OF r SKIP LOCKED
), updated AS (
  UPDATE reviews r SET first_published_at = b.published_at
  FROM batch b WHERE r.id = b.id AND r.first_published_at IS NULL
  RETURNING r.id
)
SELECT count(*)::int AS updated FROM updated;
COMMIT;
-- updated=0 with concurrent operators is not a fleet readiness declaration;
-- reconcile once more after draining old writers in S4.
