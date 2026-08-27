-- ADR-0007: cached travel legs between two catalog places.
-- Durable, not a TTL cache: these are fixed points, identical for every user
-- and room, and valid until a place moves. That reuse is what makes routing
-- affordable — most legs GoGo asks for have been asked before.
CREATE TABLE IF NOT EXISTS "travel_legs" (
  "from_place_id" uuid NOT NULL REFERENCES "places"("id") ON DELETE CASCADE,
  "to_place_id" uuid NOT NULL REFERENCES "places"("id") ON DELETE CASCADE,
  "mode" text NOT NULL DEFAULT 'drive',
  "time_bucket" smallint NOT NULL DEFAULT 0,
  "minutes" integer NOT NULL,
  "distance_m" integer NOT NULL,
  "provider" text NOT NULL DEFAULT 'google_routes',
  "fetched_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "travel_legs_pair_unique"
  ON "travel_legs" ("from_place_id","to_place_id","mode","time_bucket");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "travel_legs_from_idx" ON "travel_legs" ("from_place_id");
