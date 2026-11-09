-- ADR-0052. Additive schema; no provider content backfill. Columns are dropped LAST
-- in the phased rollback in docs/submission-provider-photo.md.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE place_submissions
  ADD COLUMN provider_photo jsonb,
  ADD COLUMN provider_photo_claim_id uuid,
  ADD COLUMN provider_photo_claimed_at timestamptz,
  ADD COLUMN provider_photo_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX place_submissions_provider_photo_key_idx
  ON place_submissions ((provider_photo->>'storageKey')) WHERE provider_photo IS NOT NULL;
--> statement-breakpoint
-- Photo purchases have their own UUID fence. A committed claim, completion or
-- compensation must not invalidate the review snapshot taken before provider I/O.
-- Compare every other column so concurrent contributor/moderator edits still fail.
CREATE OR REPLACE FUNCTION increment_submission_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['submission_revision', 'provider_photo', 'provider_photo_claim_id',
                          'provider_photo_claimed_at', 'provider_photo_attempts'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['submission_revision', 'provider_photo', 'provider_photo_claim_id',
                          'provider_photo_claimed_at', 'provider_photo_attempts']) THEN
    NEW.submission_revision := OLD.submission_revision + 1;
  ELSE
    NEW.submission_revision := OLD.submission_revision;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
