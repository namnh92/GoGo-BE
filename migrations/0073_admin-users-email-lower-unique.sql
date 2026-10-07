-- GoGo-BE#687 (review of PR #690, Sol F-04). Staff addresses are compared
-- case-insensitively everywhere in the API (ADMIN_EMAIL_TAKEN) and in the
-- deploy-time super admin sync, but the only unique index was on the raw
-- column, so `Boss@x` and `boss@x` could coexist when written outside the API
-- and make "who holds this address" ambiguous. This makes the database agree.
--
-- admin_users is a handful of rows; the build is instant. If two rows already
-- collide the CREATE fails, the whole migration run rolls back and the deploy
-- stops with the previous revision serving — resolve the duplicate first.
-- Checked on DEV 2026-10-07: no case-folded duplicates.
--
-- Rollback: keep it (an older API never writes a case-folded duplicate).
-- Rehearsal-only down: DROP INDEX IF EXISTS admin_users_email_lower_unique;
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_unique ON admin_users (lower(email));
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
