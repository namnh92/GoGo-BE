-- GoGo-BE#679, ADR-0032. Which door opened a CMS session: password or
-- Cloudflare Access. Refresh slides `expires_at` forward on every rotation, so
-- without this a session opened by password before the password door closed
-- would live as long as it keeps being used. With it, refresh refuses a
-- password-born family once CMS_PASSWORD_LOGIN_ENABLED is false.
--
-- NULL = opened before this column existed, and is treated as `password`
-- (fails closed). A rotated session inherits its predecessor's value.
--
-- Additive and nullable: a catalogue-only change, no table rewrite. Lock wait
-- is bounded so a long transaction on admin_sessions makes the run give up
-- (SQLSTATE 55P03, whole run rolls back) instead of queueing every refresh.
--
-- Rollback: an older API ignores the column; keep it. Rehearsal-only down:
-- ALTER TABLE admin_sessions DROP COLUMN auth_method;
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS auth_method text;
--> statement-breakpoint
ALTER TABLE admin_sessions DROP CONSTRAINT IF EXISTS admin_sessions_auth_method_check;
--> statement-breakpoint
ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_auth_method_check
  CHECK (auth_method IS NULL OR auth_method IN ('password', 'access_sso'));
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
