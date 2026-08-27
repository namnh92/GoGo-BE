CREATE TYPE "public"."ingest_job_mode" AS ENUM('dry_run', 'create_drafts', 'publish_approved');--> statement-breakpoint
CREATE TYPE "public"."ingest_job_status" AS ENUM('uploaded', 'validating', 'processing', 'review_required', 'completed', 'partial_success', 'failed', 'cancelled', 'paused_provider_quota');--> statement-breakpoint
CREATE TYPE "public"."ingest_row_status" AS ENUM('pending', 'validation_failed', 'resolving', 'unresolved', 'needs_confirmation', 'duplicate', 'ready', 'imported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ingest_source_type" AS ENUM('csv', 'xlsx', 'google_sheet', 'mobile_link');--> statement-breakpoint
CREATE TYPE "public"."provider_source_status" AS ENUM('active', 'moved', 'closed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."place_submission_status" AS ENUM('pending', 'approved', 'rejected', 'merged');--> statement-breakpoint
CREATE TABLE "place_ingest_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" "ingest_source_type" NOT NULL,
	"source_file_name" text,
	"source_checksum" text,
	"status" "ingest_job_status" DEFAULT 'uploaded' NOT NULL,
	"mode" "ingest_job_mode" DEFAULT 'dry_run' NOT NULL,
	"default_city" text,
	"mapping" jsonb,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"success_rows" integer DEFAULT 0 NOT NULL,
	"warning_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"created_by_admin_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "place_ingest_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"source_row_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"raw_input" jsonb NOT NULL,
	"normalized_input" jsonb,
	"resolved_google_place_id" text,
	"matched_place_id" uuid,
	"match_confidence" numeric(4, 3),
	"match_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "ingest_row_status" DEFAULT 'pending' NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_ingest_rows_confidence_range" CHECK ("place_ingest_rows"."match_confidence" is null or ("place_ingest_rows"."match_confidence" >= 0 and "place_ingest_rows"."match_confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "place_provider_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"provider" text DEFAULT 'google_places' NOT NULL,
	"external_id" text NOT NULL,
	"provider_uri" text,
	"rating" numeric(3, 2),
	"rating_count" integer,
	"derived_score" numeric(5, 2),
	"price_level" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refresh_after" timestamp with time zone,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_status" "provider_source_status" DEFAULT 'active' NOT NULL,
	"fetch_tier" text DEFAULT 'core' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "place_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_place_id" text NOT NULL,
	"submitted_by_user_id" uuid,
	"submitted_by_guest_session_id" uuid,
	"room_id" uuid,
	"category_key" text,
	"price_min" bigint,
	"price_max" bigint,
	"price_unit" text,
	"vibe_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"status" "place_submission_status" DEFAULT 'pending' NOT NULL,
	"submission_count" integer DEFAULT 1 NOT NULL,
	"result_place_id" uuid,
	"decided_by_admin_id" uuid,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "place_ingest_jobs" ADD CONSTRAINT "place_ingest_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_ingest_rows" ADD CONSTRAINT "place_ingest_rows_job_id_place_ingest_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."place_ingest_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_ingest_rows" ADD CONSTRAINT "place_ingest_rows_matched_place_id_places_id_fk" FOREIGN KEY ("matched_place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_provider_sources" ADD CONSTRAINT "place_provider_sources_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_submissions" ADD CONSTRAINT "place_submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_submissions" ADD CONSTRAINT "place_submissions_result_place_id_places_id_fk" FOREIGN KEY ("result_place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_ingest_jobs_status_idx" ON "place_ingest_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "place_ingest_jobs_checksum_unique" ON "place_ingest_jobs" USING btree ("source_checksum","mode") WHERE "place_ingest_jobs"."source_checksum" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "place_ingest_rows_job_source_unique" ON "place_ingest_rows" USING btree ("job_id","source_row_id");--> statement-breakpoint
CREATE INDEX "place_ingest_rows_status_idx" ON "place_ingest_rows" USING btree ("job_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "place_provider_sources_provider_external_unique" ON "place_provider_sources" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "place_provider_sources_place_idx" ON "place_provider_sources" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "place_provider_sources_refresh_idx" ON "place_provider_sources" USING btree ("refresh_after");--> statement-breakpoint
CREATE UNIQUE INDEX "place_submissions_pending_unique" ON "place_submissions" USING btree ("google_place_id") WHERE "place_submissions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "place_submissions_status_idx" ON "place_submissions" USING btree ("status","created_at");