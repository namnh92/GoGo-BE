-- #785 / ADR-0043. Run in the migrator's transaction. Fail rather than wait
-- indefinitely for live writers; the one-time backfill needs a maintenance window.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
LOCK TABLE plans, plan_stops, stop_checkins IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Keep the association on a child of the check-in: cascade deletion can run
-- after its plan/stop has disappeared, so looking up OLD parents is unsafe.
CREATE TABLE place_checkin_visits (
  checkin_id uuid PRIMARY KEY REFERENCES stop_checkins(id) ON DELETE CASCADE ON UPDATE CASCADE,
  place_id uuid NOT NULL,
  room_id uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE place_checkin_rooms (
  place_id uuid NOT NULL,
  room_id uuid NOT NULL,
  checkin_count integer NOT NULL CHECK (checkin_count >= 0),
  PRIMARY KEY (place_id, room_id)
);
--> statement-breakpoint
CREATE TABLE place_checkin_counts (
  place_id uuid PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  group_count integer NOT NULL CHECK (group_count >= 0)
);
--> statement-breakpoint
INSERT INTO place_checkin_visits (checkin_id, place_id, room_id)
SELECT c.id, s.place_id, p.room_id
FROM stop_checkins c JOIN plan_stops s ON s.id = c.plan_stop_id
JOIN plans p ON p.id = s.plan_id;
--> statement-breakpoint
INSERT INTO place_checkin_rooms (place_id, room_id, checkin_count)
SELECT place_id, room_id, count(*)::int FROM place_checkin_visits GROUP BY place_id, room_id;
--> statement-breakpoint
INSERT INTO place_checkin_counts (place_id, group_count)
SELECT place_id, count(*)::int FROM place_checkin_rooms GROUP BY place_id;
--> statement-breakpoint
-- Row locks from the upsert/update serialize transitions for the same room.
-- Arithmetic updates on the place row serialize transitions for different rooms.
CREATE FUNCTION apply_place_checkin_visit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.place_id = OLD.place_id AND NEW.room_id = OLD.room_id THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE place_checkin_rooms SET checkin_count = checkin_count - 1
      WHERE place_id = OLD.place_id AND room_id = OLD.room_id
      RETURNING checkin_count INTO remaining;
    IF remaining IS NULL THEN RAISE EXCEPTION 'Missing place check-in room'; END IF;
    IF remaining = 0 THEN
      DELETE FROM place_checkin_rooms WHERE place_id = OLD.place_id AND room_id = OLD.room_id;
      UPDATE place_checkin_counts SET group_count = group_count - 1 WHERE place_id = OLD.place_id;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO place_checkin_rooms (place_id, room_id, checkin_count)
      VALUES (NEW.place_id, NEW.room_id, 1)
      ON CONFLICT (place_id, room_id) DO UPDATE
        SET checkin_count = place_checkin_rooms.checkin_count + 1
      RETURNING checkin_count INTO remaining;
    IF remaining = 1 THEN
      INSERT INTO place_checkin_counts (place_id, group_count) VALUES (NEW.place_id, 1)
        ON CONFLICT (place_id) DO UPDATE SET group_count = place_checkin_counts.group_count + 1;
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER place_checkin_visit_delta AFTER INSERT OR UPDATE OR DELETE ON place_checkin_visits
  FOR EACH ROW EXECUTE FUNCTION apply_place_checkin_visit();
--> statement-breakpoint
CREATE FUNCTION associate_place_checkin_visit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_place uuid; target_room uuid;
BEGIN
  -- SHARE (not KEY SHARE) excludes non-key parent moves until this write commits.
  SELECT s.place_id, p.room_id INTO STRICT target_place, target_room
    FROM plan_stops s JOIN plans p ON p.id = s.plan_id WHERE s.id = NEW.plan_stop_id
    FOR SHARE OF s, p;
  INSERT INTO place_checkin_visits (checkin_id, place_id, room_id)
    VALUES (NEW.id, target_place, target_room)
    ON CONFLICT (checkin_id) DO UPDATE SET place_id = EXCLUDED.place_id, room_id = EXCLUDED.room_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER checkin_associate_place AFTER INSERT OR UPDATE OF plan_stop_id ON stop_checkins
  FOR EACH ROW EXECUTE FUNCTION associate_place_checkin_visit();
--> statement-breakpoint
CREATE FUNCTION move_stop_checkin_visits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Lock/update the source row, not a shadow selected through an old snapshot.
  -- READ COMMITTED rechecks this predicate if a concurrent reparent/delete wins.
  UPDATE stop_checkins SET plan_stop_id = plan_stop_id WHERE plan_stop_id = NEW.id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER stop_move_checkin_visits AFTER UPDATE OF place_id, plan_id ON plan_stops
  FOR EACH ROW WHEN (OLD.place_id IS DISTINCT FROM NEW.place_id OR OLD.plan_id IS DISTINCT FROM NEW.plan_id)
  EXECUTE FUNCTION move_stop_checkin_visits();
--> statement-breakpoint
CREATE FUNCTION move_plan_checkin_visits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE stop_checkins c SET plan_stop_id = c.plan_stop_id FROM plan_stops s
    WHERE c.plan_stop_id = s.id AND s.plan_id = NEW.id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER plan_move_checkin_visits AFTER UPDATE OF room_id ON plans
  FOR EACH ROW WHEN (OLD.room_id IS DISTINCT FROM NEW.room_id)
  EXECUTE FUNCTION move_plan_checkin_visits();
--> statement-breakpoint
-- TRUNCATE ... CASCADE does not fire row-delete triggers.
CREATE FUNCTION reset_place_checkin_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- DELETE also works when an outer TRUNCATE ... CASCADE includes these tables.
  DELETE FROM place_checkin_rooms;
  DELETE FROM place_checkin_counts;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER checkin_visits_truncated AFTER TRUNCATE ON place_checkin_visits
  FOR EACH STATEMENT EXECUTE FUNCTION reset_place_checkin_counts();
