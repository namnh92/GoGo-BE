-- #879 expansion only. Transfer remains fenced until concurrent ops + batch
-- backfill + full preflight and deployment attestations have completed.
SET LOCAL lock_timeout = '3s';
ALTER TABLE rooms ADD COLUMN host_version integer NOT NULL DEFAULT 1;
ALTER TABLE rooms ADD CONSTRAINT rooms_host_version_positive CHECK (host_version > 0) NOT VALID;
ALTER TABLE rooms ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION preserve_room_creator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Mixed-version create: old binaries only supply host_user_id.
    NEW.created_by_user_id := NEW.host_user_id;
  ELSIF OLD.created_by_user_id IS NOT NULL AND NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'room creator is immutable' USING ERRCODE = '23514';
  ELSIF OLD.created_by_user_id IS NULL AND NEW.created_by_user_id IS DISTINCT FROM OLD.host_user_id THEN
    RAISE EXCEPTION 'creator backfill must use pre-activation host' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_preserve_creator BEFORE INSERT OR UPDATE OF created_by_user_id ON rooms
FOR EACH ROW EXECUTE FUNCTION preserve_room_creator();
--> statement-breakpoint
-- No full-table scan under expansion's ACCESS EXCLUSIVE locks. Preflight and
-- validation run as bounded post-migration ops while transfer stays fenced.
ALTER TABLE room_members ADD CONSTRAINT room_members_host_user CHECK (role <> 'host' OR (user_id IS NOT NULL AND guest_session_id IS NULL)) NOT VALID;
--> statement-breakpoint
CREATE FUNCTION validate_room_host_id(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pointer uuid; total integer; matching integer;
BEGIN
  SELECT host_user_id INTO pointer FROM rooms WHERE id = target;
  IF NOT FOUND THEN RETURN; END IF; -- cascading room deletion
  SELECT count(*), count(*) FILTER (WHERE user_id = pointer AND guest_session_id IS NULL)
    INTO total, matching FROM room_members WHERE room_id = target AND role = 'host' AND removed_at IS NULL;
  IF total <> 1 OR matching <> 1 THEN
    RAISE EXCEPTION 'room % must have one active user host matching its pointer', target USING ERRCODE = '23514', CONSTRAINT = 'room_single_host';
  END IF;
END $$;
CREATE FUNCTION validate_room_host() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rooms' THEN
    PERFORM validate_room_host_id(NEW.id);
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM validate_room_host_id(OLD.room_id); END IF;
    IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.room_id IS DISTINCT FROM OLD.room_id) THEN
      PERFORM validate_room_host_id(NEW.room_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rooms_single_host AFTER INSERT OR UPDATE OF host_user_id ON rooms
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_room_host();
CREATE CONSTRAINT TRIGGER members_single_host_insert AFTER INSERT ON room_members
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.role = 'host') EXECUTE FUNCTION validate_room_host();
CREATE CONSTRAINT TRIGGER members_single_host_delete AFTER DELETE ON room_members
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.role = 'host') EXECUTE FUNCTION validate_room_host();
CREATE CONSTRAINT TRIGGER members_single_host_update AFTER UPDATE OF role, user_id, guest_session_id, room_id, removed_at ON room_members
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
  (OLD.role = 'host' OR NEW.role = 'host') AND
  (OLD.role, OLD.user_id, OLD.guest_session_id, OLD.room_id, OLD.removed_at) IS DISTINCT FROM
  (NEW.role, NEW.user_id, NEW.guest_session_id, NEW.room_id, NEW.removed_at)
) EXECUTE FUNCTION validate_room_host();
--> statement-breakpoint
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'host_transferred';
--> statement-breakpoint
CREATE TABLE room_host_transfer_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  api_guards_ready boolean NOT NULL DEFAULT false,
  workers_ready boolean NOT NULL DEFAULT false,
  clients_ready boolean NOT NULL DEFAULT false,
  preflight_passed boolean NOT NULL DEFAULT false
);
INSERT INTO room_host_transfer_rollout(singleton) VALUES (true);
-- Catalog checks cover definition AND validity, never just an index name.
CREATE FUNCTION room_host_transfer_ready() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM room_host_transfer_rollout
    WHERE singleton AND enabled AND api_guards_ready AND workers_ready AND clients_ready AND preflight_passed)
  AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.oid = to_regclass('public.room_members_active_host_unique') AND i.indrelid = 'room_members'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts = 1 AND i.indnatts = 1
      AND i.indexprs IS NULL AND i.indkey::text = (SELECT attnum::text FROM pg_attribute WHERE attrelid = 'room_members'::regclass AND attname = 'room_id')
      AND pg_get_expr(i.indpred, i.indrelid) = '((role = ''host''::member_role) AND (removed_at IS NULL))')
  AND (SELECT count(*) = 4 FROM pg_trigger WHERE tgname IN
    ('rooms_single_host', 'members_single_host_insert', 'members_single_host_delete', 'members_single_host_update')
    AND tgdeferrable AND tginitdeferred AND tgenabled = 'O' AND tgconstraint <> 0
    AND tgfoid = 'validate_room_host()'::regprocedure
    AND tgrelid = CASE WHEN tgname = 'rooms_single_host' THEN 'rooms'::regclass ELSE 'room_members'::regclass END)
  AND (SELECT count(*) = 2 FROM pg_constraint WHERE convalidated AND
    ((conrelid = 'rooms'::regclass AND conname = 'rooms_host_version_positive') OR
     (conrelid = 'room_members'::regclass AND conname = 'room_members_host_user')))
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'rooms'::regclass AND tgname = 'rooms_preserve_creator'
    AND tgenabled = 'O' AND tgfoid = 'preserve_room_creator()'::regprocedure);
$$;
