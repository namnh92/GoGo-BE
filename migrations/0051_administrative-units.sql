-- ADM-001 (#454) / ADR-0019 — versioned Vietnamese administrative units.
--
-- Vietnam moved to a two-level hierarchy on 2025-07-01: province/municipality,
-- then ward/commune/special zone. District-level units were dissolved. Every
-- address stored before that date names a unit that no longer exists, and
-- every address stored after it names one whose code GoGo did not hold.
--
-- This migration is additive only. `places.city`, `places.district`,
-- `places.address_text` and `places.area_key` are untouched in both
-- directions: ADR-0016 decided those are free-text evidence of what a provider
-- or an editor actually wrote, and ADR-0019 supersedes only its conclusion
-- that official codes may not be stored *beside* them. Nothing here rewrites a
-- stored address, and nothing backfills.
--
-- ---------------------------------------------------------------------------
-- Why the business key is (code, effective_from) and not code
-- ---------------------------------------------------------------------------
--
-- Because the codes are reused, and measurably so. Comparing the two pinned
-- snapshots (v5.0.0 current, v2.4.1 historical), 3,316 of the 3,321 current
-- commune codes also exist in the historical set — and 2,212 of those name a
-- different place entirely:
--
--     00004   Phường Trúc Bạch    ->  Phường Ba Đình
--     00008   Phường Liễu Giai    ->  Phường Ngọc Hà
--     00025   Phường Ngọc Khánh   ->  Phường Giảng Võ
--
-- A UNIQUE(code) would refuse 10,035 historical rows at import. The worse
-- failure is quieter: a stored `commune_code` read without knowing which
-- dataset produced it is ambiguous across the 2025-07-01 boundary, and would
-- resolve to a confidently wrong commune. That is why every place carrying a
-- code also carries `administrative_dataset_version`, and why it is not
-- decoration.
--
-- ---------------------------------------------------------------------------
-- Down:
--   ALTER TABLE places
--     DROP COLUMN administrative_mapped_by,
--     DROP COLUMN administrative_mapped_at,
--     DROP COLUMN administrative_dataset_version,
--     DROP COLUMN administrative_mapping_confidence,
--     DROP COLUMN administrative_mapping_source,
--     DROP COLUMN administrative_mapping_status,
--     DROP COLUMN legacy_district_code,
--     DROP COLUMN commune_code,
--     DROP COLUMN province_code;
--   DROP TABLE administrative_unit_change_overrides;
--   DROP TABLE administrative_mapping_quarantine;
--   DROP TABLE administrative_unit_changes;
--   DROP TABLE administrative_units;
--   DROP TABLE administrative_dataset_versions;
--   DROP TYPE administrative_quarantine_class;
--   DROP TYPE administrative_mapping_source;
--   DROP TYPE administrative_mapping_status;
--   DROP TYPE administrative_change_resolution;
--   DROP TYPE administrative_change_type;
--   DROP TYPE administrative_dataset_status;
--   DROP TYPE administrative_unit_status;
--   DROP TYPE administrative_level;
--   DROP TYPE administrative_unit_type;
-- Every step removes something this migration added. Backing out loses only
-- what was written through the new contract; no pre-existing value is
-- restored, because none was changed.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_unit_type') THEN
    CREATE TYPE administrative_unit_type AS ENUM (
      'PROVINCE', 'MUNICIPALITY', 'WARD', 'COMMUNE', 'SPECIAL_ZONE', 'LEGACY_DISTRICT'
    );
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_level') THEN
    CREATE TYPE administrative_level AS ENUM ('PROVINCE', 'COMMUNE', 'LEGACY_DISTRICT');
  END IF;
END $$;--> statement-breakpoint

-- FUTURE is carried because a decree is published before it takes effect. It
-- is never returned by a current-data read; `effective_from` is what decides.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_unit_status') THEN
    CREATE TYPE administrative_unit_status AS ENUM ('ACTIVE', 'INACTIVE', 'FUTURE');
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_dataset_status') THEN
    CREATE TYPE administrative_dataset_status AS ENUM (
      'STAGED', 'VALIDATED', 'REJECTED', 'PUBLISHED', 'ROLLED_BACK'
    );
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_change_type') THEN
    CREATE TYPE administrative_change_type AS ENUM (
      'CREATED', 'RENAMED', 'MERGED', 'SPLIT', 'REASSIGNED', 'DISSOLVED'
    );
  END IF;
END $$;--> statement-breakpoint

-- A change row is canonical only once someone or something has decided it is.
-- `ambiguous` is the honest default for a SPLIT with no coordinate evidence.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_change_resolution') THEN
    CREATE TYPE administrative_change_resolution AS ENUM ('resolved', 'ambiguous');
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_mapping_status') THEN
    CREATE TYPE administrative_mapping_status AS ENUM (
      'UNMAPPED', 'AUTO_MATCHED', 'NEEDS_REVIEW', 'VERIFIED', 'REJECTED', 'STALE'
    );
  END IF;
END $$;--> statement-breakpoint

-- How the claim was arrived at, not who typed it. `editor` is a person's own
-- assertion; the rest name the evidence the resolver used.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_mapping_source') THEN
    CREATE TYPE administrative_mapping_source AS ENUM (
      'editor', 'trusted_code', 'structured_components', 'components_with_coordinates',
      'boundary_point_in_polygon', 'exact_name', 'change_mapping', 'fuzzy_suggestion'
    );
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'administrative_quarantine_class') THEN
    CREATE TYPE administrative_quarantine_class AS ENUM (
      'VALID_UNIQUE', 'VALID_MERGE', 'VALID_DISTRICT_TO_SPECIAL_ZONE',
      'DIVIDED_REQUIRES_REVIEW', 'TARGET_NOT_FOUND', 'SOURCE_NOT_FOUND',
      'MULTIPLE_TARGETS', 'HIERARCHY_CONFLICT', 'DUPLICATE', 'INVALID'
    );
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Dataset versions. Everything else references one.
-- ---------------------------------------------------------------------------
--
-- A GoGo dataset is a combination of three independently pinned upstreams plus
-- GoGo's own reviewer overrides, so the identity of a published set is the
-- tuple, not any one source version. Changing any component produces a new
-- combined version that must be validated and published like any other.
CREATE TABLE IF NOT EXISTS administrative_dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combined_dataset_version text NOT NULL,
  combined_checksum text NOT NULL,
  current_source_version text NOT NULL,
  historical_source_version text,
  mapping_source_commit text,
  -- Bumped by a reviewer decision, not by an upstream release.
  override_revision integer NOT NULL DEFAULT 0,
  source text NOT NULL,
  source_url text,
  effective_date date NOT NULL,
  status administrative_dataset_status NOT NULL DEFAULT 'STAGED',
  validation_report jsonb,
  diff_summary jsonb,
  imported_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS administrative_dataset_versions_version_unique
  ON administrative_dataset_versions (combined_dataset_version);--> statement-breakpoint

-- Re-importing byte-identical inputs must not create a second version, and a
-- checksum that has already been published must never be published again.
CREATE UNIQUE INDEX IF NOT EXISTS administrative_dataset_versions_checksum_unique
  ON administrative_dataset_versions (combined_checksum);--> statement-breakpoint

-- At most one PUBLISHED version. The API is not the only writer — the seed,
-- an import command and a psql session all reach this table — so the
-- invariant lives in an index, exactly as migration 0050 argued for the CMS
-- super-admin singleton. At most one is all an index can say; "exactly one"
-- is held by publish/rollback never leaving zero once one exists.
CREATE UNIQUE INDEX IF NOT EXISTS administrative_dataset_versions_one_published
  ON administrative_dataset_versions (status)
  WHERE status = 'PUBLISHED';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_dataset_versions_status_idx
  ON administrative_dataset_versions (status, imported_at DESC);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The units themselves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS administrative_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id uuid NOT NULL
    REFERENCES administrative_dataset_versions(id) ON DELETE CASCADE,
  -- Official GSO code. Not unique on its own; see the header.
  code text NOT NULL,
  name text NOT NULL,
  full_name text NOT NULL,
  name_en text,
  -- Lowercased, unaccented `name`, maintained by the importer. Mirrors the
  -- `places.name_normalized` convention so search compares in one space.
  name_normalized text NOT NULL,
  full_name_normalized text NOT NULL,
  code_name text,
  unit_type administrative_unit_type NOT NULL,
  level administrative_level NOT NULL,
  -- Province code for a commune, province code for a legacy district. NULL for
  -- a province. Not a foreign key: a parent may sit in a different effective
  -- period, and (code, effective_from) is not referenceable as a single column.
  parent_code text,
  status administrative_unit_status NOT NULL DEFAULT 'ACTIVE',
  effective_from date NOT NULL,
  effective_to date,
  source text NOT NULL,
  source_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT administrative_units_effective_range
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A unit cannot be its own parent. Deeper cycles are a validation gate
  -- (#457): a check constraint cannot walk the graph.
  CONSTRAINT administrative_units_not_own_parent
    CHECK (parent_code IS NULL OR parent_code <> code),
  -- A province has no parent; everything below one must name it.
  CONSTRAINT administrative_units_parent_by_level CHECK (
    (level = 'PROVINCE' AND parent_code IS NULL)
    OR (level <> 'PROVINCE' AND parent_code IS NOT NULL)
  )
);--> statement-breakpoint

-- The business identity, per ADR-0019 §4, scoped to its dataset so a staged
-- import can hold its own copy of a code the published set also holds.
CREATE UNIQUE INDEX IF NOT EXISTS administrative_units_code_effective_unique
  ON administrative_units (dataset_version_id, code, effective_from);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_units_dataset_level_idx
  ON administrative_units (dataset_version_id, level, status);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_units_parent_idx
  ON administrative_units (dataset_version_id, parent_code)
  WHERE parent_code IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_units_code_idx
  ON administrative_units (code);--> statement-breakpoint

-- Accent-insensitive prefix and substring search. `f_unaccent` and the trigram
-- extension are already installed by migration 0001.
CREATE INDEX IF NOT EXISTS administrative_units_name_trgm_idx
  ON administrative_units USING gin (name_normalized gin_trgm_ops);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_units_full_name_trgm_idx
  ON administrative_units USING gin (full_name_normalized gin_trgm_ops);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Changes. Many-to-many by construction.
-- ---------------------------------------------------------------------------
--
-- One legacy unit may appear with several new codes (SPLIT) and several legacy
-- units may share one new code (MERGED); the pinned data holds 9,328 rows of
-- the second kind collapsing into 3,041 targets, and 1,033 rows of the first
-- across 471 sources. So the row is the edge, and neither side is unique.
CREATE TABLE IF NOT EXISTS administrative_unit_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id uuid NOT NULL
    REFERENCES administrative_dataset_versions(id) ON DELETE CASCADE,
  -- NULL for CREATED: a unit that came from nothing has no predecessor.
  old_code text,
  -- NULL for DISSOLVED: a unit that went nowhere has no successor.
  new_code text,
  change_type administrative_change_type NOT NULL,
  effective_date date NOT NULL,
  legal_reference text,
  source_version text NOT NULL,
  resolution administrative_change_resolution NOT NULL DEFAULT 'resolved',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT administrative_unit_changes_endpoints
    CHECK (old_code IS NOT NULL OR new_code IS NOT NULL)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS administrative_unit_changes_edge_unique
  ON administrative_unit_changes
     (dataset_version_id, COALESCE(old_code, ''), COALESCE(new_code, ''), change_type);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_unit_changes_old_idx
  ON administrative_unit_changes (dataset_version_id, old_code)
  WHERE old_code IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_unit_changes_new_idx
  ON administrative_unit_changes (dataset_version_id, new_code)
  WHERE new_code IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_unit_changes_unresolved_idx
  ON administrative_unit_changes (dataset_version_id)
  WHERE resolution = 'ambiguous';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Quarantine for advisory mapping rows.
-- ---------------------------------------------------------------------------
--
-- The change-mapping upstream is advisory, never authoritative current data.
-- Rows land here first and only structurally valid ones whose source and
-- target both resolve against the pinned snapshots are promoted. The raw
-- payload is kept verbatim so a reviewer sees what the source actually said,
-- not GoGo's reading of it.
CREATE TABLE IF NOT EXISTS administrative_mapping_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id uuid NOT NULL
    REFERENCES administrative_dataset_versions(id) ON DELETE CASCADE,
  raw_payload jsonb NOT NULL,
  source_provenance text NOT NULL,
  upstream_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  old_code text,
  new_code text,
  old_name text,
  new_name text,
  classification administrative_quarantine_class NOT NULL,
  validation_reason text NOT NULL,
  -- What GoGo could offer instead. Empty for a genuinely undecidable row —
  -- an empty list is a fact, and better than a fabricated suggestion.
  suggested_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_place_count integer NOT NULL DEFAULT 0,
  reviewer_decision text,
  reviewed_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  reviewer_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_mapping_quarantine_dataset_idx
  ON administrative_mapping_quarantine (dataset_version_id, classification);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_mapping_quarantine_pending_idx
  ON administrative_mapping_quarantine (dataset_version_id)
  WHERE reviewed_at IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Reviewer overrides — GoGo-owned, upstream never edited.
-- ---------------------------------------------------------------------------
--
-- A reviewer correcting a mapping does not touch the pinned snapshot: the
-- snapshot is evidence of what the source said, and editing it would destroy
-- the only way to tell an upstream fact from a GoGo decision. The override is
-- a separate row that wins over the upstream mapping at resolve time, per the
-- precedence in ADR-0019.
CREATE TABLE IF NOT EXISTS administrative_unit_change_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_code text NOT NULL,
  new_code text,
  change_type administrative_change_type NOT NULL,
  effective_date date NOT NULL,
  legal_reference text,
  reason text NOT NULL,
  -- Which combined version the reviewer was looking at when they decided.
  decided_against_version text NOT NULL,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES admin_users(id) ON DELETE SET NULL
);--> statement-breakpoint

-- One live override per (old, new, type). A revoked one stays for the record.
CREATE UNIQUE INDEX IF NOT EXISTS administrative_unit_change_overrides_live_unique
  ON administrative_unit_change_overrides (old_code, COALESCE(new_code, ''), change_type)
  WHERE revoked_at IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_unit_change_overrides_old_idx
  ON administrative_unit_change_overrides (old_code)
  WHERE revoked_at IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. The place columns.
-- ---------------------------------------------------------------------------
--
-- All nullable, all defaulted to the honest empty state, none backfilled.
-- `city`, `district`, `address_text` and `area_key` are deliberately absent
-- from this statement.
ALTER TABLE places
  ADD COLUMN IF NOT EXISTS province_code text,
  ADD COLUMN IF NOT EXISTS commune_code text,
  ADD COLUMN IF NOT EXISTS legacy_district_code text,
  ADD COLUMN IF NOT EXISTS administrative_mapping_status administrative_mapping_status
    NOT NULL DEFAULT 'UNMAPPED',
  ADD COLUMN IF NOT EXISTS administrative_mapping_source administrative_mapping_source,
  -- Only written where it is computed deterministically; a resolver path that
  -- cannot produce a number leaves it NULL rather than inventing 0.5.
  ADD COLUMN IF NOT EXISTS administrative_mapping_confidence numeric(3, 2),
  -- Which dataset produced the codes above. Without it a code is ambiguous
  -- across 2025-07-01 — see the header.
  ADD COLUMN IF NOT EXISTS administrative_dataset_version text,
  ADD COLUMN IF NOT EXISTS administrative_mapped_at timestamptz,
  ADD COLUMN IF NOT EXISTS administrative_mapped_by uuid
    REFERENCES admin_users(id) ON DELETE SET NULL;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'places_administrative_confidence_range'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_administrative_confidence_range
      CHECK (administrative_mapping_confidence IS NULL
             OR (administrative_mapping_confidence >= 0
                 AND administrative_mapping_confidence <= 1));
  END IF;
END $$;--> statement-breakpoint

-- A mapped place must say which dataset mapped it. UNMAPPED carries nothing,
-- which is why the constraint keys on the status rather than on the code.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'places_administrative_version_present'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_administrative_version_present
      CHECK (administrative_mapping_status = 'UNMAPPED'
             OR administrative_dataset_version IS NOT NULL);
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS places_administrative_status_idx
  ON places (administrative_mapping_status)
  WHERE administrative_mapping_status <> 'UNMAPPED';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS places_commune_code_idx
  ON places (commune_code) WHERE commune_code IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS places_province_code_idx
  ON places (province_code) WHERE province_code IS NOT NULL;
