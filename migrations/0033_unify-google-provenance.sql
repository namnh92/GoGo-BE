-- PR1 (#334) — one Google identity, one provenance table.
--
-- Two tables have been recording the same fact. `place_sources(provider =
-- 'google')` is written only by `/v1/places/imports`; `place_provider_sources
-- (provider = 'google_places')` is written by bulk import and by mobile
-- submission. The blindness between them is asymmetric: ingestion's dedup
-- reads both, the legacy import reads only its own, and `/v1/places/:id`
-- attribution reads only `place_sources`. So the same Google Place ID can
-- become two GoGo places depending on which door it came through, and a place
-- that arrived through ingestion is served with no attribution at all.
--
-- `place_provider_sources` wins because it is the one the newer paths already
-- key on and the one that carries freshness (`fetched_at`, `refresh_after`,
-- `fetch_tier`) — which everything after this PR needs. `place_sources` keeps
-- `manual | community` provenance; its `google` rows are copied here and its
-- writer is removed in the same change.
--
-- ADR-0006 §9.4 R1 applies: `raw` holds a whole Details payload, nothing has
-- ever read it, and it is "stop writing" independently of the counsel answer.
-- The column itself is dropped a release later, once no deployed code names it.
--
-- Forward-only and idempotent: every statement is a copy or a guarded update,
-- nothing is dropped, and a second run changes nothing.
--
-- Down:
--   DELETE FROM place_provider_sources ps
--     USING place_sources s
--     WHERE ps.provider = 'google_places' AND s.provider = 'google'
--       AND ps.external_id = s.external_id AND ps.place_id = s.place_id
--       AND ps.fetch_tier = 'quality' AND ps.source_status = 'unknown';
--   DROP TABLE IF EXISTS place_identity_conflicts;
--   -- `raw` is not restorable and deliberately so.

-- An external ID that already points at a different GoGo place is a real
-- disagreement about identity, not a row to overwrite. Both sides are kept and
-- the pair is queued for a human merge decision — the same rule the ingestion
-- dedup follows when it returns MERGE_CANDIDATE instead of merging.
CREATE TABLE IF NOT EXISTS place_identity_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_id text NOT NULL,
  -- The place the canonical table already links this external ID to.
  canonical_place_id uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  -- The place the legacy row links it to. Never silently discarded.
  legacy_place_id uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS place_identity_conflicts_unique
  ON place_identity_conflicts (provider, external_id, legacy_place_id);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS place_identity_conflicts_open_idx
  ON place_identity_conflicts (detected_at) WHERE resolved_at IS NULL;--> statement-breakpoint

INSERT INTO place_identity_conflicts (provider, external_id, canonical_place_id, legacy_place_id)
SELECT 'google_places', s.external_id, ps.place_id, s.place_id
FROM place_sources s
JOIN place_provider_sources ps
  ON ps.provider = 'google_places' AND ps.external_id = s.external_id
WHERE s.provider = 'google' AND ps.place_id <> s.place_id
ON CONFLICT (provider, external_id, legacy_place_id) DO NOTHING;--> statement-breakpoint

-- The copy. Identity, attribution and fetch metadata only — ADR-0006 §9.3
-- classes "allowed". No rating, no price level, no primary type, no `raw`:
-- unifying an identity is not a licence to move provider content into a
-- second table, and §9.5 is in force.
--
-- `fetched_at` is the truest time available for the row: when the payload was
-- last written, else when the import landed. `refresh_after` follows the same
-- +30d cadence `upsertProviderSource` applies. `fetch_tier = 'quality'` is
-- what `/v1/places/imports` actually requested (`details()` defaults to it).
-- `source_status = 'unknown'` because these rows carry no observation of the
-- business's current state — 'active' would be an assertion nobody made.
INSERT INTO place_provider_sources (
  place_id, provider, external_id, provider_uri,
  fetched_at, refresh_after, attribution, source_status, fetch_tier
)
SELECT
  s.place_id,
  'google_places',
  s.external_id,
  s.url,
  COALESCE(s.raw_updated_at, s.imported_at),
  COALESCE(s.raw_updated_at, s.imported_at) + interval '30 days',
  CASE WHEN s.attribution IS NULL THEN '{}'::jsonb
       ELSE jsonb_build_object('text', s.attribution) END,
  'unknown',
  'quality'
FROM place_sources s
WHERE s.provider = 'google'
ON CONFLICT (provider, external_id) DO NOTHING;--> statement-breakpoint

-- R1 — the payload nothing reads. Purged after the copy, because the copy
-- reads `raw_updated_at`.
UPDATE place_sources
SET raw = NULL, raw_updated_at = NULL
WHERE raw IS NOT NULL OR raw_updated_at IS NOT NULL;
