-- S5 #887: empty GoGo-owned editorial table; no provider/model/chat backfill.
-- Forward: migrate before deploying readers. New-table indexes do not scan places.
-- Rollback: stop alias writes; deploy pre-S5 resolver/CMS; export editorial evidence
-- if it must be retained, then DROP TABLE place_aliases. Destructive to aliases only.
CREATE TABLE place_aliases (
  place_id uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  alias text NOT NULL,
  alias_normalized text NOT NULL,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_type text NOT NULL,
  source_reference text NOT NULL,
  collected_at timestamptz NOT NULL,
  CONSTRAINT place_aliases_place_normalized_unique PRIMARY KEY (place_id, alias_normalized),
  CONSTRAINT place_aliases_alias_valid CHECK (
    char_length(alias) BETWEEN 1 AND 120 AND btrim(alias) <> ''
    AND alias !~ '[[:cntrl:]]' AND alias_normalized <> ''
  ),
  CONSTRAINT place_aliases_source_valid CHECK (
    source_type = 'editorial'
    AND char_length(btrim(source_reference)) BETWEEN 1 AND 500
  )
);
--> statement-breakpoint
CREATE INDEX place_aliases_normalized_trgm_idx ON place_aliases USING gin (alias_normalized gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX place_aliases_normalized_idx ON place_aliases (alias_normalized);
