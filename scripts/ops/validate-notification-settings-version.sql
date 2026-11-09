-- GoGo-BE#811 (PR #817 F-05): run only AFTER db:migrate has successfully returned
-- (0094 committed). Keep outside migrations/: Drizzle wraps all pending files in one
-- transaction, and VALIDATE takes only SHARE UPDATE EXCLUSIVE, so writers keep going.
-- Safe to retry after failure or after successful validation.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE notification_settings VALIDATE CONSTRAINT notification_settings_version_check;
COMMIT;
