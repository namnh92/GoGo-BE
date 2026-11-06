-- Deploy d097b37's uncached query BEFORE this rollback (never restore TTL caching).
-- No source check-in, stop, plan or room data is removed. Drizzle journal history
-- stays intact: after rollback, reapply 0082 explicitly before deploying its reader.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
LOCK TABLE plans, plan_stops, stop_checkins IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER plan_move_checkin_visits ON plans;
DROP TRIGGER stop_move_checkin_visits ON plan_stops;
DROP TRIGGER checkin_associate_place ON stop_checkins;
DROP FUNCTION move_plan_checkin_visits();
DROP FUNCTION move_stop_checkin_visits();
DROP FUNCTION associate_place_checkin_visit();
DROP TABLE place_checkin_visits;
DROP FUNCTION apply_place_checkin_visit();
DROP FUNCTION reset_place_checkin_counts();
DROP TABLE place_checkin_rooms;
DROP TABLE place_checkin_counts;
COMMIT;
