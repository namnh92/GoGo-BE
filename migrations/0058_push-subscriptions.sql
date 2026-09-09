-- NTF-BE-011 (#515) — who a push campaign can actually reach.
--
-- The campaign audience gated on `device_tokens`: "this user has a registered
-- device". Nothing in the product writes that table. `PUT /me/device-tokens`
-- shipped, the mobile client has an API wrapper and a hook for it, and no
-- screen ever calls either — the only writer on DEV was the mobile contract
-- test, which signs up a throwaway `@gogo.test` account per run and registers
-- a `contract-<timestamp>` token. So the audience was, exactly, three accounts
-- that had never opened the app, and every real user was excluded.
--
-- The registry that replaces it holds no APNs or FCM token (OneSignal spec §26,
-- WBS APP-008, ADR-0016). It is not a routing table: a push is still addressed
-- to `external_id = users.id` and OneSignal still owns the device list. This
-- answers one question the provider cannot be asked once per campaign — "which
-- of our users can receive a push, and on what platform" — and every row in it
-- was verified against the provider before it was written.
--
-- `subscription_id` is OneSignal's own id for a device's push subscription. It
-- is not a device token: it addresses nothing at APNs or FCM, GoGo never sends
-- to it, and the client already hands it to `POST /notifications/identity/logout`.
-- Unique, because one device is one subscription no matter who signs in on it;
-- an upsert therefore moves the row to the new user rather than leaving the
-- previous account holding a device it no longer has.
--
-- Down:
--   DROP TABLE IF EXISTS push_subscriptions;
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "platform" "device_platform" NOT NULL,
  "subscription_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_confirmed_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_subscription_unique"
  ON "push_subscriptions" USING btree ("subscription_id");
--> statement-breakpoint
-- The audience predicate's only question: does this user hold a live
-- subscription, and on what platform. Partial, because a revoked row is never
-- part of an audience and carrying it in the index would only make the
-- membership test read rows it must then discard.
CREATE INDEX IF NOT EXISTS "push_subscriptions_live_idx"
  ON "push_subscriptions" USING btree ("user_id", "platform")
  WHERE "revoked_at" IS NULL;
