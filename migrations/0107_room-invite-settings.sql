-- #906 BE-A. No credential backfill; 0106 is reserved for #891.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
CREATE TABLE room_invite_settings (
  id smallint PRIMARY KEY CONSTRAINT room_invite_settings_singleton CHECK (id = 1),
  ttl_seconds integer NOT NULL DEFAULT 86400 CONSTRAINT room_invite_settings_ttl_positive CHECK (ttl_seconds > 0),
  version bigint NOT NULL DEFAULT 1 CONSTRAINT room_invite_settings_version_positive CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_admin_id uuid
);
--> statement-breakpoint
WITH seeded AS (
  INSERT INTO room_invite_settings(id) VALUES (1)
  ON CONFLICT (id) DO NOTHING
  RETURNING ttl_seconds, version, updated_at
)
INSERT INTO audit_logs(actor_type, action, resource_type, resource_id, diff, created_at)
SELECT 'system', 'room_invite_ttl.initialized', 'room_invite_ttl', 'global',
  jsonb_build_object('after', jsonb_build_object('ttlSeconds', ttl_seconds, 'version', version::text)), updated_at
FROM seeded;
