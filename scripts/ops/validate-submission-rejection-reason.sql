-- GoGo-BE#787: run only AFTER db:migrate has successfully returned (DDL committed).
-- Keep outside migrations/: Drizzle wraps all pending files in one transaction.
-- Safe to retry after failure or after successful validation.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE place_submissions VALIDATE CONSTRAINT place_submissions_rejection_reason_check;
COMMIT;
