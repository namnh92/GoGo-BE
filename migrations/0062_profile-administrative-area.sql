-- ADM-019 (#566). Nullable snapshot preserves codes AND their dataset identity
-- and display labels. Old profiles remain valid; no guessed legacy mapping.
-- Application rollback keeps this additive column. Rehearsal-only down:
-- ALTER TABLE users DROP COLUMN home_administrative_area;
ALTER TABLE users ADD COLUMN home_administrative_area jsonb;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_home_administrative_area_object
CHECK (home_administrative_area IS NULL OR (
  jsonb_typeof(home_administrative_area) = 'object'
  AND home_administrative_area ?& ARRAY['datasetVersion', 'provinceCode', 'provinceName', 'communeCode', 'communeName']
  AND length(home_administrative_area->>'datasetVersion') > 0
  AND home_administrative_area->>'provinceCode' ~ '^[0-9]{2,5}$'
));
