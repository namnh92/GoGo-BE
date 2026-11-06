-- Nullable, with no backfill: internal notes must never become public keys.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE place_submissions ADD COLUMN rejection_reason text;
--> statement-breakpoint
ALTER TABLE place_submissions ADD CONSTRAINT place_submissions_rejection_reason_check
  CHECK (rejection_reason IS NULL OR (status = 'rejected' AND rejection_reason IN
    ('duplicate_place', 'incorrect_location', 'permanently_closed', 'not_public_place', 'inappropriate_content', 'other'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE place_submissions VALIDATE CONSTRAINT place_submissions_rejection_reason_check;
--> statement-breakpoint
RESET lock_timeout;
