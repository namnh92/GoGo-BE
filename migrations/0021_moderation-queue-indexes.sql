-- BE-CMS-G1 (#219) — indexes for the filtered, keyset-paged moderation queues.
--
-- Each queue reads as `where <status> = ? order by created_at desc, id desc`
-- with a `(created_at, id) < (?, ?)` cursor. The existing indexes cover the
-- status predicate but not the sort, so a page had to sort the whole status
-- partition; carrying the tie-breaker makes the page a range scan and the count
-- beside it an index-only scan.
--
-- Additive only — no column, type or row is touched.
CREATE INDEX IF NOT EXISTS reviews_moderation_queue_idx
  ON reviews (status, created_at DESC, id DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS reports_moderation_queue_idx
  ON reports (status, created_at DESC, id DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stop_checkins_moderation_queue_idx
  ON stop_checkins (moderation, created_at DESC, id DESC);--> statement-breakpoint

-- Partial: the community queue is the only reader, so the predicate keeps the
-- index the size of the backlog rather than the size of the catalog.
CREATE INDEX IF NOT EXISTS places_community_queue_idx
  ON places (created_at DESC, id DESC)
  WHERE status = 'community_submitted';--> statement-breakpoint

-- The `reported` filter and the per-review open-report count both ask "are
-- there undecided reports pointing at this row". Without this each page is a
-- sequential scan of `reports`.
CREATE INDEX IF NOT EXISTS reports_target_open_idx
  ON reports (target_type, target_id)
  WHERE status = 'open';

-- Rollback:
--   DROP INDEX IF EXISTS reviews_moderation_queue_idx;
--   DROP INDEX IF EXISTS reports_moderation_queue_idx;
--   DROP INDEX IF EXISTS stop_checkins_moderation_queue_idx;
--   DROP INDEX IF EXISTS places_community_queue_idx;
--   DROP INDEX IF EXISTS reports_target_open_idx;
