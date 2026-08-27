-- SEC-003: one row per admin login.
-- Before this, the access token's `sid` was the admin id itself: nothing to log
-- out of, nothing to revoke per device, and no answer to "where is this account
-- signed in" — the question a compromised staff account makes urgent.
CREATE TABLE IF NOT EXISTS "admin_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_id" uuid NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "refresh_token_hash" text NOT NULL,
  "family_id" uuid NOT NULL,
  "rotated_from_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "superseded_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoke_reason" text,
  "ip_hash" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "admin_sessions_refresh_unique"
  ON "admin_sessions" ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_admin_idx"
  ON "admin_sessions" ("admin_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_family_idx" ON "admin_sessions" ("family_id");
