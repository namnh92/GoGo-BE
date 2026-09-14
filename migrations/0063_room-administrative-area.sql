-- ADM-020 (#567). Nullable snapshot of a room constraint's canonical area:
-- codes, the dataset version that produced them, and the labels shown when it was
-- chosen. Existing rooms keep area_key and get NULL — no mapping is guessed from
-- the legacy key. Application rollback keeps this additive column (older code
-- never reads it). Rehearsal-only down:
-- ALTER TABLE room_constraints DROP CONSTRAINT room_constraints_administrative_area_object;
-- ALTER TABLE room_constraints DROP COLUMN administrative_area;
ALTER TABLE room_constraints ADD COLUMN administrative_area jsonb;
--> statement-breakpoint
ALTER TABLE room_constraints ADD CONSTRAINT room_constraints_administrative_area_object
CHECK (administrative_area IS NULL OR (
  jsonb_typeof(administrative_area) = 'object'
  AND administrative_area ?& ARRAY['datasetVersion', 'provinceCode', 'provinceName', 'communeCode', 'communeName']
  AND length(administrative_area->>'datasetVersion') > 0
  AND administrative_area->>'provinceCode' ~ '^[0-9]{2,5}$'
));
