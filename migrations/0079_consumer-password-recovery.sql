-- Additive. Rollback disables recovery and retains tables; never restore credentials.
CREATE TABLE "password_recovery_challenges" (
  "email_digest" text PRIMARY KEY NOT NULL,
  "id" uuid NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "code_digest" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "resend_available_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "password_recovery_attempts_bounded" CHECK ("attempts" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE INDEX "password_recovery_expiry_idx" ON "password_recovery_challenges" ("expires_at");
--> statement-breakpoint
CREATE TABLE "password_recovery_replays" (
  "key" text PRIMARY KEY NOT NULL,
  "fingerprint" text NOT NULL,
  "body" jsonb,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "password_recovery_replay_expiry_idx" ON "password_recovery_replays" ("expires_at");
