-- GoGo-BE#228, ADR-0028 §Rollback, step 1. Run BEFORE deploying an API build
-- older than optional stops. Not a migration: the migrator never reads this.
--
-- An older build inserts plan_stops without `is_optional`, so every plan
-- version it writes (edit, regenerate) would silently turn optional stops —
-- locked ones included — back into required ones. This guard makes that loss
-- loud instead:
--   * the column default is dropped, so an omitted value arrives as NULL;
--   * the trigger fills NULL with `false` only when the room's previous plan
--     version has no optional stop (nothing to lose — e.g. a first finalize);
--   * otherwise the insert fails (SQLSTATE GG228), the writer's transaction
--     rolls back, and the plan in place keeps its optional stops.
-- The current build always writes the column explicitly and is unaffected.
-- Remove with 0068-plan-stops-optional-guard.remove.sql after rolling forward.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION plan_stops_optional_rollback_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_optional IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM plan_stops ps
      WHERE ps.is_optional
        AND ps.plan_id = (
          SELECT prev.id
          FROM plans np
          JOIN plans prev ON prev.room_id = np.room_id AND prev.id <> np.id
          WHERE np.id = NEW.plan_id
          ORDER BY prev.version DESC
          LIMIT 1
        )
    ) THEN
      RAISE EXCEPTION 'plan_stops.is_optional omitted while the room has optional stops (ADR-0028 rollback guard)'
        USING ERRCODE = 'GG228';
    END IF;
    NEW.is_optional := false;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS plan_stops_optional_rollback_guard ON plan_stops;
CREATE TRIGGER plan_stops_optional_rollback_guard
  BEFORE INSERT ON plan_stops
  FOR EACH ROW EXECUTE FUNCTION plan_stops_optional_rollback_guard();

ALTER TABLE plan_stops ALTER COLUMN is_optional DROP DEFAULT;
COMMIT;
