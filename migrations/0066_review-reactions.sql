-- BE-BFF-019 (#571), ADR-0026 (PROPOSAL). One `helpful` reaction per person per
-- review. Additive: a new table only; `reviews` is not rewritten or locked.
-- Application rollback leaves the table unused. Rehearsal-only down:
-- DROP TABLE review_reactions;
CREATE TABLE review_reactions (
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_reactions_review_id_user_id_type_pk PRIMARY KEY (review_id, user_id, type),
  CONSTRAINT review_reactions_type CHECK (type IN ('helpful'))
);
--> statement-breakpoint
CREATE INDEX review_reactions_user_idx ON review_reactions (user_id);
