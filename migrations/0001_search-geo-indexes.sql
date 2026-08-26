-- DB-009: geo/FTS/trigram indexes + normalization support.
-- unaccent() is STABLE, not IMMUTABLE — wrap it so it can back generated
-- columns and expression indexes.
CREATE OR REPLACE FUNCTION f_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE STRICT
  RETURN public.unaccent('public.unaccent', $1);--> statement-breakpoint

-- Keep name_normalized consistent no matter which writer inserts the row.
CREATE OR REPLACE FUNCTION places_normalize_name()
  RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.name_normalized := lower(f_unaccent(NEW.name));
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER places_normalize_name_trg
  BEFORE INSERT OR UPDATE OF name ON places
  FOR EACH ROW EXECUTE FUNCTION places_normalize_name();--> statement-breakpoint

-- Full-text search document: accented + unaccented name, description, area.
ALTER TABLE places ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(f_unaccent(name), '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(f_unaccent(description), '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(area_key, '')), 'B')
  ) STORED;--> statement-breakpoint

CREATE INDEX places_search_tsv_idx ON places USING gin (search_tsv);--> statement-breakpoint
CREATE INDEX places_name_trgm_idx ON places USING gin (name_normalized gin_trgm_ops);--> statement-breakpoint
CREATE INDEX places_geom_gist_idx ON places USING gist (geom);--> statement-breakpoint
-- Search hot path filters on status + geo together.
CREATE INDEX places_published_geom_idx ON places USING gist (geom) WHERE status = 'published';
