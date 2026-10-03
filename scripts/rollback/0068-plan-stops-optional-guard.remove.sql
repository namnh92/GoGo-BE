-- GoGo-BE#228, ADR-0029 §Rollback, final step. Run after the current build is
-- back (roll forward). Restores the migration's state exactly.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE plan_stops ALTER COLUMN is_optional SET DEFAULT false;
DROP TRIGGER IF EXISTS plan_stops_optional_rollback_guard ON plan_stops;
DROP FUNCTION IF EXISTS plan_stops_optional_rollback_guard();
COMMIT;
