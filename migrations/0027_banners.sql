-- BE-CMS-G4c (#224) — banners.
--
-- `expired` is not stored. It is a fact about the clock — a banner whose window
-- has passed — and a stored value would be wrong for as long as it took a job
-- to notice, or forever if none ran. The lifecycle a person controls is stored;
-- expiry is computed on read, by the server, so no client has to derive it.
CREATE TYPE banner_placement AS ENUM ('home_hero', 'home_secondary');--> statement-breakpoint

CREATE TYPE banner_status AS ENUM ('draft', 'scheduled', 'published', 'archived');--> statement-breakpoint

CREATE TYPE banner_destination AS ENUM (
  'none',
  'place',
  'recommendation',
  'plan_template',
  'campaign',
  'external_url'
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The editorial name; `title` is what a user reads on the banner.
  name text NOT NULL,
  -- Mandatory: a banner is an image. The key comes from POST /cms/uploads with
  -- purpose `banner_image` and is bound to this banner on save.
  image_key text NOT NULL,
  title text,
  subtitle text,
  cta_label text,
  destination_type banner_destination NOT NULL DEFAULT 'none',
  destination_value text,
  audience content_audience,
  placement banner_placement NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  -- Higher first, between banners competing for one placement.
  priority integer NOT NULL DEFAULT 0,
  status banner_status NOT NULL DEFAULT 'draft',
  created_by_admin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT banners_name_unique UNIQUE (name),
  CONSTRAINT banners_window_order CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
  ),
  -- A destination that points somewhere carries where; `none` carries nothing.
  CONSTRAINT banners_destination_value CHECK (
    (destination_type = 'none' AND destination_value IS NULL)
    OR (destination_type <> 'none' AND destination_value IS NOT NULL)
  ),
  CONSTRAINT banners_priority_range CHECK (priority BETWEEN 0 AND 1000)
);--> statement-breakpoint

-- What the consumer surface will ask for: live banners in one placement, in
-- the order they should appear.
CREATE INDEX IF NOT EXISTS banners_live_idx
  ON banners (placement, priority DESC, id)
  WHERE status = 'published';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS banners_list_idx ON banners (created_at DESC, id DESC);

-- Rollback:
--   DROP TABLE IF EXISTS banners;
--   DROP TYPE banner_destination;
--   DROP TYPE banner_status;
--   DROP TYPE banner_placement;
