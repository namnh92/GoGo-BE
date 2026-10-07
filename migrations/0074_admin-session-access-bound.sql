-- GoGo-BE#687 D-4 (F-08, O-12). Whether a CMS session family was opened with a
-- verified Cloudflare Access assertion for the account's own mailbox. From this
-- release the password door requires that assertion, so a password family opened
-- before it (or on a workstation without Access) had one factor; refresh refuses
-- such a family (reason `access_unbound`) wherever the assertion is required.
-- `access-exchange` families are bound by construction. Rotation inherits it.
--
-- NOT NULL DEFAULT false with a constant default is metadata-only on PG 11+: no
-- table rewrite, no scan. Every existing row reads false, which is the intended
-- outcome — each pre-release family signs in once more, with the assertion.
--
-- Rollback: an older API ignores the column; keep it. Rehearsal-only down:
-- ALTER TABLE admin_sessions DROP COLUMN access_bound;
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS access_bound boolean NOT NULL DEFAULT false;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
