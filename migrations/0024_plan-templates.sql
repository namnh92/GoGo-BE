-- BE-CMS-G4b (#223) — CMS-managed plan templates.
--
-- Source material for future plans, not live ones: nothing here references
-- `plans`, `plan_stops` or a room, and editing a template must never reach a
-- plan somebody already has. That separation is the whole point of the
-- resource, so it is a property of the schema rather than a rule in a service.
--
-- Money is integer minor units, and every amount carries what it is *per*:
-- `per_person` and `per_group` are different numbers, and a column that stores
-- one without saying which invites the client to guess.
CREATE TYPE plan_template_status AS ENUM ('draft', 'published', 'archived');--> statement-breakpoint

CREATE TYPE budget_scope AS ENUM ('per_person', 'per_group');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS plan_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  locale text NOT NULL DEFAULT 'vi',
  -- The editorial name; `title` is what a user would read.
  internal_name text NOT NULL,
  title text NOT NULL,
  description text,
  audience content_audience,
  -- Same vocabulary as `places.area_key`, so "city" is one concept.
  area_key text,
  budget_min bigint,
  budget_max bigint,
  budget_currency text,
  budget_scope budget_scope,
  expected_duration_minutes integer,
  status plan_template_status NOT NULL DEFAULT 'draft',
  created_by_admin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_templates_slug_locale_unique UNIQUE (slug, locale),
  -- A range is present or absent as a whole, and never inverted.
  CONSTRAINT plan_templates_budget_pair CHECK (
    (budget_min IS NULL) = (budget_max IS NULL)
  ),
  CONSTRAINT plan_templates_budget_order CHECK (
    budget_min IS NULL OR budget_min <= budget_max
  ),
  -- An amount with no currency and no scope is an unreadable number. If there
  -- is a budget, it says what it is in and what it is per.
  CONSTRAINT plan_templates_budget_unit CHECK (
    budget_min IS NULL OR (budget_currency IS NOT NULL AND budget_scope IS NOT NULL)
  ),
  CONSTRAINT plan_templates_budget_non_negative CHECK (budget_min IS NULL OR budget_min >= 0),
  CONSTRAINT plan_templates_duration_positive CHECK (
    expected_duration_minutes IS NULL OR expected_duration_minutes > 0
  )
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS plan_templates_list_idx
  ON plan_templates (status, created_at DESC, id DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS plan_template_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES plan_templates (id) ON DELETE CASCADE,
  -- Order is meaning: a template is a sequence, not a set.
  position integer NOT NULL,
  -- What kind of stop this is, as a stable taxonomy key.
  category_taxonomy_id uuid NOT NULL REFERENCES taxonomies (id) ON DELETE RESTRICT,
  -- Optional: a template may name a specific place or leave it to matching.
  preferred_place_id uuid REFERENCES places (id) ON DELETE SET NULL,
  -- A property of the stop, not a convention the reader has to infer.
  is_optional boolean NOT NULL DEFAULT false,
  expected_duration_minutes integer NOT NULL,
  budget_min bigint,
  budget_max bigint,
  budget_currency text,
  budget_scope budget_scope,
  note text,
  CONSTRAINT plan_template_stops_position_unique UNIQUE (template_id, position),
  CONSTRAINT plan_template_stops_position_non_negative CHECK (position >= 0),
  CONSTRAINT plan_template_stops_duration_positive CHECK (expected_duration_minutes > 0),
  CONSTRAINT plan_template_stops_budget_pair CHECK ((budget_min IS NULL) = (budget_max IS NULL)),
  CONSTRAINT plan_template_stops_budget_order CHECK (budget_min IS NULL OR budget_min <= budget_max),
  CONSTRAINT plan_template_stops_budget_unit CHECK (
    budget_min IS NULL OR (budget_currency IS NOT NULL AND budget_scope IS NOT NULL)
  ),
  CONSTRAINT plan_template_stops_budget_non_negative CHECK (budget_min IS NULL OR budget_min >= 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS plan_template_stops_template_idx
  ON plan_template_stops (template_id, position);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS plan_template_taxonomies (
  template_id uuid NOT NULL REFERENCES plan_templates (id) ON DELETE CASCADE,
  taxonomy_id uuid NOT NULL REFERENCES taxonomies (id) ON DELETE RESTRICT,
  PRIMARY KEY (template_id, taxonomy_id)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS plan_template_taxonomies_taxonomy_idx
  ON plan_template_taxonomies (taxonomy_id);

-- Rollback:
--   DROP TABLE IF EXISTS plan_template_taxonomies;
--   DROP TABLE IF EXISTS plan_template_stops;
--   DROP TABLE IF EXISTS plan_templates;
--   DROP TYPE budget_scope;
--   DROP TYPE plan_template_status;
