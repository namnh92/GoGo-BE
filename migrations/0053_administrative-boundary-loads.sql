-- ADM-007 (#460) / ADR-0019 — the ledger of loaded boundary releases.
--
-- Migration 0052 created `administrative_unit_boundaries` empty and said the
-- load was this task's. The polygons alone cannot answer three operational
-- questions, so they get a row of their own:
--
--   1. Which archive produced this version, and did its bytes match the pin?
--      Every polygon row carries `source_checksum`, but 3,355 copies of one
--      answer is not a record — and a half-loaded version would have some rows
--      saying one thing and none saying anything about the ones that are absent.
--   2. May this version be loaded again? Re-running the loader on the same
--      archive is a no-op; re-running it on a *different* archive under the same
--      version name is a mistake that must be refused rather than silently
--      producing a version whose name no longer identifies its contents.
--   3. What did validation find? A load is only trustworthy alongside what was
--      checked, and a topology report that lives in a terminal scrollback is
--      not evidence anyone can consult six months later.
--
-- There are no legacy district boundaries here either: the CHECK on
-- `administrative_unit_boundaries` refuses them, and the counts below have no
-- column for them, because the units were dissolved before any of these
-- releases were drawn.
--
-- ---------------------------------------------------------------------------
-- Down:
--   DROP TABLE administrative_boundary_loads;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS administrative_boundary_loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One row per released boundary set. The unique index below is what makes
  -- "same version, different checksum" a detectable conflict rather than a
  -- second opinion.
  boundary_version text NOT NULL,
  source text NOT NULL,
  source_url text,
  source_commit text NOT NULL,
  -- SHA-256 of the archive as fetched, verified before anything was read.
  source_checksum text NOT NULL,
  license text NOT NULL,
  province_count integer NOT NULL,
  commune_count integer NOT NULL,
  validation_report jsonb NOT NULL,
  topology_report jsonb NOT NULL,
  load_duration_ms integer NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT administrative_boundary_loads_counts_positive
    CHECK (province_count >= 0 AND commune_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS administrative_boundary_loads_version_unique
  ON administrative_boundary_loads (boundary_version);

CREATE INDEX IF NOT EXISTS administrative_boundary_loads_loaded_idx
  ON administrative_boundary_loads (loaded_at DESC);
