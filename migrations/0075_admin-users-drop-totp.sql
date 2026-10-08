-- GoGo-BE#687 D-4 step 2 (BE-c2). TOTP left the CMS in BE-c (alpha.72): the
-- second factor is the Cloudflare Access assertion on the login request. BE-c
-- stopped mapping these columns, so no running release reads them; this drops
-- what is left, including every encrypted TOTP secret.
--
-- Ships after BE-c is accepted on DEV. No rollback below BE-c is intended
-- (shape rev 5 D-4): an API older than BE-c selects these columns and fails.
-- Rehearsal-only down (columns come back empty — the secrets are gone):
--   ALTER TABLE admin_users ADD COLUMN mfa_totp_secret_enc text,
--     ADD COLUMN mfa_totp_pending_enc text, ADD COLUMN mfa_totp_last_step bigint,
--     ADD COLUMN mfa_enrolled_at timestamptz;
--
-- DROP COLUMN is a catalogue change (no rewrite); lock wait is bounded so a
-- long transaction on admin_users makes the run give up instead of queueing
-- every admin request behind it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE admin_users
  DROP COLUMN IF EXISTS mfa_totp_secret_enc,
  DROP COLUMN IF EXISTS mfa_totp_pending_enc,
  DROP COLUMN IF EXISTS mfa_totp_last_step,
  DROP COLUMN IF EXISTS mfa_enrolled_at;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
