-- NTF-BE-017 (#747), ADR-0038 — a device with no session holds a BE-issued
-- `device:<id>` identity and can receive campaigns addressed to everyone.
--
-- Additive. The rollback baseline is the release that shipped 0077 (ADR-0037):
-- its register() writes a valid owner over a device-owned row, and neither the
-- foreign key nor the new tables get in its way. That binary cannot resolve the
-- `public` audience: a `public` campaign still scheduled fails rather than sends,
-- so cancel those before rolling back, and any `public` row stays readable but
-- cannot be estimated or rescheduled.
--
-- `promotions_enabled` is null until the device has stated a choice, and null is
-- not in the audience. `cleanup_state` tracks the provider half of a retirement,
-- which runs after the row is revoked and never inside its transaction.
--
-- `campaign_device_sends` is what `notifications` is to an account: the record a
-- retried dispatch reads. A device has no inbox, so it gets no notification row.
-- `device_id` goes null when the identity is deleted after retention; the dedupe
-- key keeps a random id that no longer points at anything.
--
-- `ADD VALUE` is fine inside the migrator's transaction because nothing here uses
-- the new value.
--
-- Down (one transaction; refuses while a device-owned row exists; the enum value
-- stays, since Postgres cannot drop one and an unused value is harmless):
--   BEGIN;
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM push_subscriptions WHERE owner_kind = 'device') THEN
--       RAISE EXCEPTION 'push_subscriptions holds device-owned rows';
--     END IF;
--   END $$;
--   ALTER TABLE notification_campaigns
--     DROP COLUMN IF EXISTS device_recipient_count,
--     DROP COLUMN IF EXISTS device_sent_count,
--     DROP COLUMN IF EXISTS device_failed_count;
--   DROP TABLE IF EXISTS campaign_device_sends;
--   DROP INDEX IF EXISTS push_subscriptions_device_live_idx;
--   ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_device_id_fk;
--   DROP TABLE IF EXISTS push_device_identities;
--   DROP TYPE IF EXISTS push_device_cleanup_state;
--   COMMIT;
ALTER TYPE "campaign_audience" ADD VALUE IF NOT EXISTS 'public';
--> statement-breakpoint
CREATE TYPE "push_device_cleanup_state" AS ENUM ('none', 'pending', 'done', 'failed');
--> statement-breakpoint
CREATE TABLE "push_device_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "secret_hash" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  "promotions_enabled" boolean,
  "preference_version" integer DEFAULT 0 NOT NULL,
  "cleanup_state" "push_device_cleanup_state" DEFAULT 'none' NOT NULL,
  "cleanup_attempts" integer DEFAULT 0 NOT NULL,
  "cleanup_next_at" timestamptz,
  "cleanup_done_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "push_device_identities_created_idx" ON "push_device_identities" ("created_at");
--> statement-breakpoint
CREATE INDEX "push_device_identities_live_seen_idx" ON "push_device_identities" ("last_seen_at") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "push_device_identities_cleanup_idx" ON "push_device_identities" ("cleanup_next_at") WHERE "cleanup_state" = 'pending';
--> statement-breakpoint
CREATE INDEX "push_device_identities_cleaned_idx" ON "push_device_identities" ("cleanup_done_at") WHERE "cleanup_state" = 'done';
--> statement-breakpoint
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "push_device_identities" ("id");
--> statement-breakpoint
CREATE INDEX "push_subscriptions_device_live_idx" ON "push_subscriptions" ("device_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "campaign_device_sends" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL REFERENCES "notification_campaigns" ("id") ON DELETE CASCADE,
  "device_id" uuid REFERENCES "push_device_identities" ("id") ON DELETE SET NULL,
  "dedupe_key" text NOT NULL,
  "push_sent_at" timestamptz,
  "push_message_id" text,
  "failed_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_device_sends_dedupe_unique" ON "campaign_device_sends" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "campaign_device_sends_campaign_idx" ON "campaign_device_sends" ("campaign_id");
--> statement-breakpoint
ALTER TABLE "notification_campaigns"
  ADD COLUMN "device_recipient_count" integer,
  ADD COLUMN "device_sent_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "device_failed_count" integer DEFAULT 0 NOT NULL;
