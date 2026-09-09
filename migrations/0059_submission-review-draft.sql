-- PI-BE-031 (#528) — what a reviewer decided before they decided.
--
-- Moderation had one text box and three buttons. A reviewer could approve a
-- submission or reject it, and could change nothing about the place that
-- approval was going to create — so a contribution arrived as a Google Place
-- ID and left as a catalogue row nobody had been able to improve.
--
-- Three columns, and the split between them is the point:
--
--   * The contributor's own input stays exactly where it is
--     (`category_key`, `price_min`/`price_max`/`price_unit`, `vibe_keys`,
--     `note`). Nothing here overwrites it. What the person proposed and what
--     staff made of it are different facts and both are worth keeping — a
--     reviewer who replaces a suggested price should not erase the suggestion.
--   * `review_draft` holds the reviewer's edits to the GoGo-owned fields the
--     Place editor already writes, in that editor's own vocabulary. It is a
--     draft: saving it decides nothing and creates no place.
--   * `reviewed_by_admin_id` / `reviewed_at` say who last touched the draft.
--     The decision has its own columns and its own audit entry; this is the
--     supplementing, which happens before and separately.
--
-- `updated_at` exists so a review save can be refused when somebody else has
-- written since (`expectedUpdatedAt`, the same optimistic-concurrency rule the
-- place editor uses). Backfilled from `created_at` rather than `now()`: a row
-- that has never been edited was last written when it was made, and stamping
-- every existing submission with the migration's clock would say otherwise.
--
-- No provider content is stored here. Google's name, address, rating and hours
-- are fetched when a reviewer asks to see them and are not kept
-- (ADR-0006 §9.5).
--
-- ---------------------------------------------------------------------------
-- Down:
--   ALTER TABLE place_submissions
--     DROP COLUMN review_draft,
--     DROP COLUMN reviewed_by_admin_id,
--     DROP COLUMN reviewed_at,
--     DROP COLUMN updated_at;
-- ---------------------------------------------------------------------------

ALTER TABLE place_submissions
  ADD COLUMN IF NOT EXISTS review_draft jsonb,
  ADD COLUMN IF NOT EXISTS reviewed_by_admin_id uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;--> statement-breakpoint

UPDATE place_submissions SET updated_at = created_at WHERE updated_at IS NULL;--> statement-breakpoint

ALTER TABLE place_submissions
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;
