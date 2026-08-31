-- BE-CMS-G4a (#222) — recommendations, as targeted collections (ADR-0009).
--
-- A recommendation is a named, ordered list of places with a schedule and a
-- status — which is what a collection already is — plus who it is for. Storing
-- it separately would fork editorial content across two tables that every later
-- feature would have to keep in agreement, so the targeting lives here and
-- `kind` says which screen owns the row.
--
-- Additive: `kind` defaults to 'collection', so every existing row keeps
-- exactly the meaning it had, and the targeting columns are null for them.
CREATE TYPE collection_kind AS ENUM ('collection', 'recommendation');--> statement-breakpoint

-- One audience vocabulary for every kind of editorial content: a
-- recommendation for 'family' and a plan template for 'family' mean the same
-- thing, and two enums with identical values eventually disagree.
CREATE TYPE content_audience AS ENUM ('couple', 'group', 'family', 'solo');--> statement-breakpoint

ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS kind collection_kind NOT NULL DEFAULT 'collection',
  -- The editorial name, which is not the public title: "Tết 2027 — đợt 2" is
  -- what a person searches the console for, and never what a user reads.
  ADD COLUMN IF NOT EXISTS internal_name text,
  ADD COLUMN IF NOT EXISTS subtitle text,
  ADD COLUMN IF NOT EXISTS audience content_audience,
  -- Same vocabulary as `places.area_key`, so "city" is one concept across the
  -- catalog rather than a second free-text field that almost matches.
  ADD COLUMN IF NOT EXISTS area_key text,
  -- Ordering between recommendations competing for the same surface. Higher
  -- first; ties broken by a stable key so a list never reshuffles itself.
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- Only recommendations are targeted. A plain collection carrying an audience
-- would be a row no screen can edit, so the constraint refuses it at the
-- database rather than leaving it to whichever writer forgets.
ALTER TABLE content_collections
  ADD CONSTRAINT content_collections_targeting_kind CHECK (
    kind = 'recommendation'
    OR (audience IS NULL AND subtitle IS NULL AND internal_name IS NULL AND priority = 0)
  );--> statement-breakpoint

-- The console lists one kind at a time, newest first, and the recommendation
-- list also sorts by priority.
CREATE INDEX IF NOT EXISTS content_collections_kind_idx
  ON content_collections (kind, priority DESC, created_at DESC, id DESC);--> statement-breakpoint

-- Categories and vibes as stable taxonomy keys, never display labels. Cascades
-- with the collection; a taxonomy row is deactivated rather than deleted, so
-- the reference cannot dangle.
CREATE TABLE IF NOT EXISTS content_collection_taxonomies (
  collection_id uuid NOT NULL REFERENCES content_collections (id) ON DELETE CASCADE,
  taxonomy_id uuid NOT NULL REFERENCES taxonomies (id) ON DELETE RESTRICT,
  PRIMARY KEY (collection_id, taxonomy_id)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS content_collection_taxonomies_taxonomy_idx
  ON content_collection_taxonomies (taxonomy_id);

-- Rollback:
--   DROP TABLE IF EXISTS content_collection_taxonomies;
--   DROP INDEX IF EXISTS content_collections_kind_idx;
--   DELETE FROM content_collections WHERE kind = 'recommendation';
--   ALTER TABLE content_collections DROP CONSTRAINT content_collections_targeting_kind;
--   ALTER TABLE content_collections
--     DROP COLUMN priority, DROP COLUMN area_key, DROP COLUMN audience,
--     DROP COLUMN subtitle, DROP COLUMN internal_name, DROP COLUMN kind;
--   DROP TYPE content_audience;
--   DROP TYPE collection_kind;
