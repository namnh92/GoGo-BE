-- ADM-006 (#459) / ADR-0019 §10 — the table the point-in-polygon evidence reads.
--
-- Empty on purpose. Pinning the GIS release, verifying its checksum and loading
-- ~50 MB of GeoJSON is ADM-007 (#460); what is here is the shape that load
-- writes into and the index the resolver's containment query needs. The
-- alternative — writing the resolver against a table that does not exist —
-- would leave its one geometric evidence path untested until the data landed,
-- which is the path most likely to be wrong.
--
-- Why the boundary set is versioned on its own, not per dataset version: the
-- GIS add-on is a separate upstream on its own cadence (v4.0.0 of 2026-06-20
-- against v5.0.0 units), so a released boundary set is shared by every dataset
-- version that cites it. `places.administrative_boundary_version` records which
-- one produced a claim, because "which polygons said so" is the question a
-- reviewer asks when a match looks wrong.
--
-- There are no legacy district boundaries, anywhere, at any version: the units
-- were dissolved before any of these releases were drawn. The CHECK below says
-- so in the schema rather than in a comment a future loader could miss, because
-- a fabricated district polygon would produce a legacy code that looks derived
-- and is invented.
--
-- ---------------------------------------------------------------------------
-- Down:
--   DROP TABLE administrative_unit_boundaries;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS administrative_unit_boundaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The pinned GIS release, e.g. 'v4.0.0'. Not a foreign key to a dataset
  -- version: one boundary release serves many of them.
  boundary_version text NOT NULL,
  code text NOT NULL,
  level administrative_level NOT NULL,
  -- Province code for a commune, NULL for a province. Checked against the unit
  -- table at resolution time rather than by a foreign key: the boundary release
  -- and the unit release are pinned separately and may disagree, and that
  -- disagreement is a fact the resolver must be able to see rather than one the
  -- database refuses to store.
  parent_code text,
  name text NOT NULL,
  name_normalized text NOT NULL,
  -- MultiPolygon, SRID 4326 — the same frame as places.geom, so containment is
  -- a comparison and never a reprojection.
  geom geometry(MultiPolygon, 4326) NOT NULL,
  source text NOT NULL,
  source_checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT administrative_boundaries_level_has_polygons
    CHECK (level <> 'LEGACY_DISTRICT'),
  CONSTRAINT administrative_boundaries_parent_present
    CHECK ((level = 'PROVINCE' AND parent_code IS NULL)
        OR (level = 'COMMUNE' AND parent_code IS NOT NULL))
);

-- One polygon set per unit per release. A second row for the same code would
-- make containment ambiguous for reasons that have nothing to do with geography.
CREATE UNIQUE INDEX IF NOT EXISTS administrative_boundaries_version_code_unique
  ON administrative_unit_boundaries (boundary_version, level, code);

-- The containment index. Without it every resolution is a sequential scan over
-- 3,355 multipolygons.
CREATE INDEX IF NOT EXISTS administrative_boundaries_geom_gist
  ON administrative_unit_boundaries USING gist (geom);

-- Reading one release's communes, which is what the resolver does first.
CREATE INDEX IF NOT EXISTS administrative_boundaries_version_level_idx
  ON administrative_unit_boundaries (boundary_version, level);
