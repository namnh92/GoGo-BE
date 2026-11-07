-- Additive attribution: preserve one moderation proposal and its first submitter.
CREATE TABLE place_submission_contributors (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES place_submissions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, submission_id)
);
--> statement-breakpoint
CREATE INDEX place_submission_contributors_submission_idx
  ON place_submission_contributors(submission_id);
--> statement-breakpoint
-- Earlier deduped users were never recorded and cannot be reconstructed.
INSERT INTO place_submission_contributors (user_id, submission_id, created_at)
SELECT s.submitted_by_user_id, s.id, s.created_at
FROM place_submissions s JOIN users u ON u.id = s.submitted_by_user_id
WHERE u.status = 'active'
ON CONFLICT DO NOTHING;
