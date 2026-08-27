-- BE-IMP-001: indexes for the CMS place table.
-- The list is keyset-paginated on (sort column, id), so the index has to carry
-- the tie-breaker too — otherwise Postgres sorts the whole filtered set to
-- resolve ties and the pagination stops being cheap.
CREATE INDEX IF NOT EXISTS places_status_updated_idx
  ON places (status, updated_at DESC, id DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS places_updated_idx
  ON places (updated_at DESC, id DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS places_area_status_updated_idx
  ON places (area_key, status, updated_at DESC, id DESC)
  WHERE area_key IS NOT NULL;--> statement-breakpoint

-- Freshness queue: "never checked" is the case editors care about most, and a
-- plain index would push those NULLs to the wrong end.
CREATE INDEX IF NOT EXISTS places_freshness_idx
  ON places (freshness_checked_at NULLS FIRST, id);--> statement-breakpoint

-- Reverse lookup for the community-source filter.
CREATE INDEX IF NOT EXISTS place_submissions_result_idx
  ON place_submissions (result_place_id)
  WHERE result_place_id IS NOT NULL;
