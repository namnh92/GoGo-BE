-- Refs #793. 0086 follows upstream migration 0085 (place-submission-contributors).
CREATE TABLE place_submission_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES place_submissions(id) ON DELETE CASCADE,
  media_upload_id uuid NOT NULL REFERENCES media_uploads(id),
  storage_key text NOT NULL UNIQUE,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX place_submission_photos_submission_idx ON place_submission_photos(submission_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX place_submission_photos_upload_unique ON place_submission_photos(media_upload_id);
