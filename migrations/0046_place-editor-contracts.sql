-- BE-CMS-PE-001 (#425) — the contract the CMS place editor was missing.
--
-- Four things, all additive:
--
--   1. `service_areas.city`     the existing area catalog gains the one column
--                               a grouped picker needs. **No new area table**:
--                               `service_areas.key` is already the vocabulary
--                               every `area_key` column in this schema holds
--                               (`hcm_q1`, `hcm_thuduc`), and it is already
--                               what community import checks coverage against.
--                               A second catalog would have been two lists that
--                               drift.
--   2. `places.city/district`   administrative address, kept apart from
--                               `area_key` because they answer different
--                               questions: one is where the post goes, the
--                               other is which bucket the place is discovered
--                               in.
--   3. `place_hours.entry_kind` closed / open-around-the-clock as first-class
--                               values instead of a minute range pretending.
--                               00:00–23:59 shuts a 24h place for a minute
--                               every night, and 1440 is outside the existing
--                               check constraint.
--   4. `place_field_provenance` who wrote *this field*, so a provider refresh
--                               can tell an editor's phone number from its own.
--
-- Numbered 0046, not 0044: the unpushed OneSignal/Tenjin stacks already claim
-- 0044 (`notification-push-delivery`) and 0045 (`share-links`) in that order.
--
-- Nothing is dropped, nothing is rewritten, no column changes type, and every
-- new column is nullable or defaulted — deploying this in front of the old
-- code is a no-op for the old code, which is what lets BE ship before CMS.
--
-- Down:
--   DROP TABLE place_field_provenance;
--   DROP TYPE field_source_type;
--   ALTER TABLE place_hours DROP CONSTRAINT place_hours_kind_minutes;
--   ALTER TABLE place_hours DROP COLUMN entry_kind;
--   DROP TYPE hours_entry_kind;
--   ALTER TABLE places DROP COLUMN city, DROP COLUMN district;
--   ALTER TABLE service_areas DROP COLUMN city;
-- Every step drops something added here; no pre-existing value is touched, so
-- rolling back loses only what was written through the new contract.

-- ------------------------------------------------------- area catalog

ALTER TABLE "service_areas" ADD COLUMN "city" text;

-- Backfill from the names the seed already writes ("Quận 1, TP.HCM"): the city
-- is the part after the last comma. Rows without a comma keep NULL rather than
-- being guessed at.
UPDATE "service_areas"
SET "city" = btrim(split_part("name", ',', 2))
WHERE "name" LIKE '%,%' AND btrim(split_part("name", ',', 2)) <> '';

-- ------------------------------------------------ administrative address

ALTER TABLE "places" ADD COLUMN "city" text;
ALTER TABLE "places" ADD COLUMN "district" text;

-- ---------------------------------------------------------- hours states

CREATE TYPE "hours_entry_kind" AS ENUM('interval', 'closed', 'open_24h');

-- Every existing row is a span, which is exactly what `interval` means, so the
-- default backfills correctly and no existing data is reinterpreted.
ALTER TABLE "place_hours"
  ADD COLUMN "entry_kind" "hours_entry_kind" DEFAULT 'interval' NOT NULL;

ALTER TABLE "place_hours" ADD CONSTRAINT "place_hours_kind_minutes" CHECK (
  "entry_kind" = 'interval'
  OR ("open_minute" = 0 AND "close_minute" = 0 AND "is_overnight" = false)
);

-- ------------------------------------------------------ field provenance

CREATE TYPE "field_source_type" AS ENUM('editorial', 'provider', 'community', 'google_derived');

CREATE TABLE "place_field_provenance" (
  "place_id" uuid NOT NULL REFERENCES "places"("id") ON DELETE CASCADE,
  "field" text NOT NULL,
  "source_type" "field_source_type" NOT NULL,
  "source_reference" text,
  "actor_id" uuid,
  "verified_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "place_field_provenance_pk" PRIMARY KEY ("place_id", "field")
);

CREATE INDEX "place_field_provenance_place_idx" ON "place_field_provenance" ("place_id");

-- Not backfilled. Every place predating this table has fields whose origin
-- nothing recorded, and writing `editorial` over them would manufacture the
-- provenance this table exists to keep honest. Absent means unclaimed.
