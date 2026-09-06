-- BE-CMS-M1 (#191) — the columns place media needs to be editable at all.
--
-- `place_media` has been readable since DB-005 and writable by nobody: no CMS
-- route uploads, attaches, reorders, moderates or removes a photo, so a place
-- imported with an unusable image had no fix inside the console and moderating
-- one meant going to the database. GoGo-CMS therefore listed media read-only
-- and said so, rather than offering a button that could only fail
-- (GoGo-CMS#21).
--
-- What the console needs that the table could not hold:
--
--   caption           editorial text under the image.
--   attribution       provider terms travel with a provider photo
--                     (FR-INGEST-014). Losing it the moment an editor
--                     reorders the list is exactly the failure this prevents.
--   is_cover          which photo represents the place. One per place,
--                     enforced by a partial unique index rather than by
--                     convention, because "two covers" has no meaning.
--   source_type       who the image came from. Same vocabulary as
--                     `place_field_provenance` (#425): an editor's upload is
--                     `editorial`, an imported one is `provider`.
--   moderation_reason why a photo was rejected, and by whom, and when
--   moderated_by      — a moderation decision with no recorded reason is not
--   moderated_at         auditable (FR-CMS-008).
--   media_upload_id   the `media_uploads` row this key came from, so a detach
--                     can tell "still referenced elsewhere" from "orphaned".
--
-- Numbered 0047 to sit behind 0046 (place editor contracts), which itself
-- steps over the unpushed 0044/0045 the OneSignal and share-link stacks claim.
-- `field_source_type` is created by 0046, so that migration must run first.
--
-- Down:
--   DROP INDEX place_media_cover_unique;
--   ALTER TABLE place_media
--     DROP COLUMN caption, DROP COLUMN attribution, DROP COLUMN is_cover,
--     DROP COLUMN source_type, DROP COLUMN moderation_reason,
--     DROP COLUMN moderated_by, DROP COLUMN moderated_at,
--     DROP COLUMN media_upload_id;
-- Additive only; rolling back loses only what the new routes wrote.

ALTER TABLE "place_media" ADD COLUMN "caption" text;
ALTER TABLE "place_media" ADD COLUMN "attribution" text;
ALTER TABLE "place_media" ADD COLUMN "is_cover" boolean DEFAULT false NOT NULL;
ALTER TABLE "place_media"
  ADD COLUMN "source_type" "field_source_type" DEFAULT 'editorial' NOT NULL;
ALTER TABLE "place_media" ADD COLUMN "moderation_reason" text;
ALTER TABLE "place_media" ADD COLUMN "moderated_by" uuid;
ALTER TABLE "place_media" ADD COLUMN "moderated_at" timestamp with time zone;
ALTER TABLE "place_media" ADD COLUMN "media_upload_id" uuid;

-- One cover per place. A partial index rather than a check constraint because
-- the rule is about the set of rows for a place, not about any single row.
CREATE UNIQUE INDEX "place_media_cover_unique"
  ON "place_media" ("place_id") WHERE "is_cover";

-- Existing rows arrived through import, so `editorial` is wrong for them. They
-- are not guessed at either: only rows on a place with a provider source are
-- marked `provider`, and the rest keep the default because nothing recorded
-- where they came from.
UPDATE "place_media" pm
SET "source_type" = 'provider'
WHERE EXISTS (
  SELECT 1 FROM "place_provider_sources" ps WHERE ps."place_id" = pm."place_id"
) OR EXISTS (
  SELECT 1 FROM "place_sources" s
  WHERE s."place_id" = pm."place_id" AND s."provider" = 'google'
);
