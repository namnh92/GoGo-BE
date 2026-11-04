-- NTF-BE-016 (#746), ADR-0037 — who owns a push subscription, and how a write
-- proves it read the current owner.
--
-- Preparatory: nothing writes `owner_kind = 'device'` until NTF-BE-017, and
-- `device_id` gets its foreign key there, with the table it points at. Shipping
-- this first is what makes the feature safe to roll back: the binary this lands
-- with already writes a valid owner, so rolling the device-identity release back
-- returns to code that can take a device-owned row over. The binary before this
-- one cannot — its upsert sets `user_id` and leaves `device_id`, which the check
-- below refuses.
--
-- Every new column has a default or allows null, so the previous binary's plain
-- insert and upsert stay valid while no device-owned row exists. That binary does
-- not advance `revision`: a compare-and-set racing it during the deploy can
-- overwrite one of its writes, and the device reports again.
--
-- `push_subscription_fences` is what an absent row cannot be: something a delayed
-- registration can find changed. A confirmed logout that found no row to revoke
-- leaves its mark here, so a registration verified before that logout cannot
-- recreate the row afterwards. The id is the provider's subscription id; the table
-- names no user.
--
-- No backfill and no rewrite: the column defaults are constants and the table is
-- small, so the check's validation scan holds its lock briefly.
--
-- Down (one transaction; refuses while a device-owned row exists, leaving everything as it was):
--   BEGIN;
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM push_subscriptions WHERE owner_kind = 'device') THEN
--       RAISE EXCEPTION 'push_subscriptions holds device-owned rows';
--     END IF;
--   END $$;
--   DROP TABLE IF EXISTS push_subscription_fences;
--   ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_one_owner;
--   ALTER TABLE push_subscriptions ALTER COLUMN user_id SET NOT NULL;
--   ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS revision;
--   ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS device_id;
--   ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS owner_kind;
--   DROP TYPE IF EXISTS push_subscription_owner_kind;
--   COMMIT;
CREATE TYPE "push_subscription_owner_kind" AS ENUM ('user', 'device');
--> statement-breakpoint
ALTER TABLE "push_subscriptions"
  ADD COLUMN "owner_kind" "push_subscription_owner_kind" DEFAULT 'user' NOT NULL,
  ADD COLUMN "device_id" uuid,
  ADD COLUMN "revision" integer DEFAULT 0 NOT NULL,
  ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_one_owner" CHECK (
    ("owner_kind" = 'user' AND "user_id" IS NOT NULL AND "device_id" IS NULL)
    OR ("owner_kind" = 'device' AND "user_id" IS NULL AND "device_id" IS NOT NULL)
  );
--> statement-breakpoint
CREATE TABLE "push_subscription_fences" (
  "subscription_id" text PRIMARY KEY NOT NULL,
  "generation" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
