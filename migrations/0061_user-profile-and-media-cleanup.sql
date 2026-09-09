-- PROF-BE-001 (#531) — profile fields on the account, and a durable queue for
-- media that must disappear. ADR-0022.
--
-- Everything here is additive and nullable or defaulted, so the previous
-- image runs unchanged against it. Down (rehearsal only; production is
-- forward-only):
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_usual_budget_nonnegative;
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_home_area_key_service_areas_key_fk;
--   ALTER TABLE users DROP COLUMN IF EXISTS avatar_key,
--     DROP COLUMN IF EXISTS home_area_key,
--     DROP COLUMN IF EXISTS usual_budget_per_person,
--     DROP COLUMN IF EXISTS usual_budget_currency;
--   DROP TABLE IF EXISTS user_profile_preferences;
--   DROP TABLE IF EXISTS media_cleanup_queue;

-- `avatar_key` is the processed object in the public bucket, never the
-- original upload. The URL is composed on the server from
-- MEDIA_PUBLIC_BASE_URL; while that base is empty the API answers null even
-- when a key is stored, so no client is handed a URL that will not load.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_key" text;
--> statement-breakpoint
-- The curated area only (service_areas.key), never a Google prediction key:
-- a profile default has to be stable, readable offline and free to resolve.
-- SET NULL rather than RESTRICT, because retiring an area must not be blocked
-- by the accounts that chose it; they simply have no default again.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "home_area_key" text;
--> statement-breakpoint
-- One per-person upper bound in integer minor units (RULE-CORE-004). It is a
-- default for the create-room wizard, never a room constraint, and it only
-- prefills a room whose budget mode is per_person.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "usual_budget_per_person" bigint;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "usual_budget_currency" char(3) DEFAULT 'VND' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_home_area_key_service_areas_key_fk"
  FOREIGN KEY ("home_area_key") REFERENCES "public"."service_areas"("key") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_usual_budget_nonnegative"
  CHECK ("usual_budget_per_person" IS NULL OR "usual_budget_per_person" >= 0);
--> statement-breakpoint
-- Private interests, keyed by taxonomy kind exactly like a room member's
-- preference_selections ({"mood": ["chill"]}), validated by the same check.
-- One row per user, so PATCH is an upsert and DELETE /me cascades it away.
CREATE TABLE IF NOT EXISTS "user_profile_preferences" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "selections" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profile_preferences"
  ADD CONSTRAINT "user_profile_preferences_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- An object that must disappear, recorded in the same transaction as the
-- change that made it unreferenced: a replaced avatar, a removed one, a
-- failed attachment's original, an erased account's picture. The worker
-- retries the delete with the outbox backoff and dead-letters after six
-- attempts (failed_at set); a row is deleted once the object is gone.
--
-- A best-effort delete that forgets its failures leaves orphans nobody can
-- count. This table is what makes "every avatar object is either referenced
-- or scheduled for deletion" a true sentence.
CREATE TABLE IF NOT EXISTS "media_cleanup_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "reason" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "failed_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The worker's due query: open rows, oldest due first.
CREATE INDEX IF NOT EXISTS "media_cleanup_queue_due_idx"
  ON "media_cleanup_queue" USING btree ("next_attempt_at")
  WHERE "failed_at" IS NULL;
--> statement-breakpoint
-- The same object enqueued twice (a replace racing a delete) is one job, not
-- two: the second insert is `on conflict do nothing`. Partial so a
-- dead-lettered row never blocks a fresh attempt from being scheduled.
CREATE UNIQUE INDEX IF NOT EXISTS "media_cleanup_queue_object_unique"
  ON "media_cleanup_queue" USING btree ("bucket", "object_key")
  WHERE "failed_at" IS NULL;
