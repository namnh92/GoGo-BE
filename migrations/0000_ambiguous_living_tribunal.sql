-- Required extensions (must precede table DDL)
CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."budget_mode" AS ENUM('total', 'per_person');--> statement-breakpoint
CREATE TYPE "public"."decision_mode" AS ENUM('match', 'vote', 'host');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('host', 'member');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('draft', 'collecting', 'matching', 'ready', 'active', 'completed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."room_type" AS ENUM('couple', 'group');--> statement-breakpoint
CREATE TYPE "public"."selection_status" AS ENUM('pending', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."hours_source" AS ENUM('provider', 'editor');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."place_import_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."place_source_provider" AS ENUM('google', 'manual', 'community');--> statement-breakpoint
CREATE TYPE "public"."place_status" AS ENUM('draft', 'community_submitted', 'review', 'published', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('provider', 'editor', 'bill_checkin');--> statement-breakpoint
CREATE TYPE "public"."price_unit" AS ENUM('per_person', 'per_item', 'per_hour', 'per_night');--> statement-breakpoint
CREATE TYPE "public"."taxonomy_kind" AS ENUM('mood', 'category', 'setting', 'dietary', 'accessibility', 'spending_style', 'suitability');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('draft', 'current', 'superseded', 'archived');--> statement-breakpoint
CREATE TYPE "public"."stop_status" AS ENUM('planned', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."suggestion_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."vote_value" AS ENUM('yes', 'no', 'star');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android', 'web');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('push', 'email');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('invite', 'preference_reminder', 'plan_ready', 'plan_changed', 'date_reminder', 'moderation_update');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."report_target_type" AS ENUM('place', 'review', 'member');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'published', 'rejected', 'removed');--> statement-breakpoint
CREATE TYPE "public"."saved_target_type" AS ENUM('place', 'plan');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('editor', 'moderator', 'ops_admin', 'super_admin');--> statement-breakpoint
CREATE TYPE "public"."admin_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('admin', 'user', 'system');--> statement-breakpoint
CREATE TYPE "public"."collection_status" AS ENUM('draft', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."import_job_status" AS ENUM('queued', 'running', 'succeeded', 'partial_failure', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ranking_config_status" AS ENUM('draft', 'approved', 'active', 'rolled_back');--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"rotated_from_id" uuid,
	"superseded_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_hash" text NOT NULL,
	"ip_hash" text NOT NULL,
	"succeeded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"display_name" text NOT NULL,
	"locale" text DEFAULT 'vi' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"analytics_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by_user_id" uuid,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"selections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"weights" jsonb,
	"is_draft" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"origin_text" text,
	"origin_lat" double precision,
	"origin_lng" double precision,
	"area_key" text,
	"radius_m" integer,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"budget_mode" "budget_mode" NOT NULL,
	"budget_amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'VND' NOT NULL,
	"dietary_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accessibility_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_constraints_budget_positive" CHECK ("room_constraints"."budget_amount" >= 0),
	CONSTRAINT "room_constraints_time_order" CHECK ("room_constraints"."start_at" is null or "room_constraints"."end_at" is null or "room_constraints"."start_at" < "room_constraints"."end_at")
);
--> statement-breakpoint
CREATE TABLE "room_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid,
	"guest_session_id" uuid,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"display_name" text NOT NULL,
	"selection_status" "selection_status" DEFAULT 'pending' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_member_id" uuid,
	CONSTRAINT "room_members_one_identity" CHECK (("room_members"."user_id" is not null)::int + ("room_members"."guest_session_id" is not null)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "room_seed_places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"type" "room_type" NOT NULL,
	"status" "room_status" DEFAULT 'draft' NOT NULL,
	"decision_mode" "decision_mode" NOT NULL,
	"host_user_id" uuid NOT NULL,
	"participant_count" integer DEFAULT 2 NOT NULL,
	"constraint_version" integer DEFAULT 1 NOT NULL,
	"title" text,
	"scheduled_date" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_participant_count_min" CHECK ("rooms"."participant_count" >= 2)
);
--> statement-breakpoint
CREATE TABLE "place_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"open_minute" integer NOT NULL,
	"close_minute" integer NOT NULL,
	"is_overnight" boolean DEFAULT false NOT NULL,
	"source" "hours_source" DEFAULT 'provider' NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "place_hours_day_range" CHECK ("place_hours"."day_of_week" between 0 and 6),
	CONSTRAINT "place_hours_minute_range" CHECK ("place_hours"."open_minute" between 0 and 1439 and "place_hours"."close_minute" between 0 and 1439)
);
--> statement-breakpoint
CREATE TABLE "place_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submitted_by_user_id" uuid,
	"submitted_by_guest_session_id" uuid,
	"room_id" uuid,
	"url" text NOT NULL,
	"provider_place_id" text,
	"status" "place_import_status" DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"provider_snapshot" jsonb,
	"result_place_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "place_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"moderation" "moderation_status" DEFAULT 'pending' NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "place_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"price_min" bigint NOT NULL,
	"price_max" bigint NOT NULL,
	"currency" char(3) DEFAULT 'VND' NOT NULL,
	"unit" "price_unit" DEFAULT 'per_person' NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.50' NOT NULL,
	"source" "price_source" DEFAULT 'editor' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_prices_range" CHECK ("place_prices"."price_min" >= 0 and "place_prices"."price_max" >= "place_prices"."price_min")
);
--> statement-breakpoint
CREATE TABLE "place_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"provider" "place_source_provider" NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"attribution" text,
	"raw" jsonb,
	"raw_updated_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "place_taxonomies" (
	"place_id" uuid NOT NULL,
	"taxonomy_id" uuid NOT NULL,
	"weight" numeric(4, 2) DEFAULT '1.0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"description" text,
	"status" "place_status" DEFAULT 'draft' NOT NULL,
	"geom" geometry(Point,4326) NOT NULL,
	"address_text" text,
	"area_key" text,
	"phone" text,
	"website" text,
	"rating" numeric(3, 2),
	"rating_count" integer DEFAULT 0 NOT NULL,
	"price_level" smallint,
	"avg_visit_minutes" integer,
	"suitability" jsonb,
	"is_lodging" boolean DEFAULT false NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.50' NOT NULL,
	"freshness_checked_at" timestamp with time zone,
	"curated_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_areas" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"center_lat" double precision NOT NULL,
	"center_lng" double precision NOT NULL,
	"radius_m" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "taxonomy_kind" NOT NULL,
	"key" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_labels" (
	"taxonomy_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"label" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_synonyms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"taxonomy_id" uuid NOT NULL,
	"term" text NOT NULL,
	"locale" text DEFAULT 'vi' NOT NULL,
	"weight" numeric(4, 2) DEFAULT '1.0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score_micros" integer NOT NULL,
	"components" jsonb NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"arrive_at" timestamp with time zone,
	"depart_at" timestamp with time zone,
	"duration_minutes" integer NOT NULL,
	"travel_minutes_from_prev" integer,
	"travel_distance_m_from_prev" integer,
	"cost_min" bigint,
	"cost_max" bigint,
	"is_locked" boolean DEFAULT false NOT NULL,
	"locked_by_member_id" uuid,
	"status" "stop_status" DEFAULT 'planned' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_stops_position_positive" CHECK ("plan_stops"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "plan_status" DEFAULT 'draft' NOT NULL,
	"totals" jsonb NOT NULL,
	"is_stale" boolean DEFAULT false NOT NULL,
	"constraint_version" integer NOT NULL,
	"generated_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stop_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_stop_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"rating" smallint,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"photo_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bill_total" bigint,
	"bill_people_count" integer,
	"bill_photo_key" text,
	"moderation" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stop_checkins_rating_range" CHECK ("stop_checkins"."rating" is null or "stop_checkins"."rating" between 1 and 5),
	CONSTRAINT "stop_checkins_photo_limit" CHECK (jsonb_array_length("stop_checkins"."photo_keys") <= 3),
	CONSTRAINT "stop_checkins_bill_photo_required" CHECK ("stop_checkins"."bill_total" is null or "stop_checkins"."bill_photo_key" is not null)
);
--> statement-breakpoint
CREATE TABLE "suggestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"status" "suggestion_run_status" DEFAULT 'queued' NOT NULL,
	"constraint_version" integer NOT NULL,
	"engine_version" text NOT NULL,
	"weights_version" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"ai_refinement_used" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"target_place_id" uuid NOT NULL,
	"value" "vote_value" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "device_platform" NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" uuid,
	"reporter_guest_session_id" uuid,
	"target_type" "report_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"decided_by_admin_id" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"place_id" uuid,
	"plan_id" uuid,
	"rating" smallint NOT NULL,
	"text" text,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"moderated_by_admin_id" uuid,
	"moderation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5),
	CONSTRAINT "reviews_one_target" CHECK (("reviews"."place_id" is not null)::int + ("reviews"."plan_id" is not null)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "saved_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" "saved_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"sso_subject" text,
	"mfa_totp_secret_enc" text,
	"display_name" text NOT NULL,
	"role" "admin_role" NOT NULL,
	"status" "admin_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"diff" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"collection_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"locale" text DEFAULT 'vi' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "collection_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"description" text,
	"updated_by_admin_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" "import_job_status" DEFAULT 'queued' NOT NULL,
	"is_dry_run" boolean DEFAULT false NOT NULL,
	"file_key" text,
	"report" jsonb,
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ranking_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"bounds" jsonb NOT NULL,
	"status" "ranking_config_status" DEFAULT 'draft' NOT NULL,
	"created_by_admin_id" uuid NOT NULL,
	"approved_by_admin_id" uuid,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"correlation_id" text,
	"payload_schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_selections" ADD CONSTRAINT "preference_selections_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_selections" ADD CONSTRAINT "preference_selections_member_id_room_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."room_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_constraints" ADD CONSTRAINT "room_constraints_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_invites" ADD CONSTRAINT "room_invites_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_seed_places" ADD CONSTRAINT "room_seed_places_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_hours" ADD CONSTRAINT "place_hours_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_imports" ADD CONSTRAINT "place_imports_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_imports" ADD CONSTRAINT "place_imports_result_place_id_places_id_fk" FOREIGN KEY ("result_place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_media" ADD CONSTRAINT "place_media_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_media" ADD CONSTRAINT "place_media_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_prices" ADD CONSTRAINT "place_prices_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_sources" ADD CONSTRAINT "place_sources_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_taxonomies" ADD CONSTRAINT "place_taxonomies_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_taxonomies" ADD CONSTRAINT "place_taxonomies_taxonomy_id_taxonomies_id_fk" FOREIGN KEY ("taxonomy_id") REFERENCES "public"."taxonomies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_labels" ADD CONSTRAINT "taxonomy_labels_taxonomy_id_taxonomies_id_fk" FOREIGN KEY ("taxonomy_id") REFERENCES "public"."taxonomies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_synonyms" ADD CONSTRAINT "taxonomy_synonyms_taxonomy_id_taxonomies_id_fk" FOREIGN KEY ("taxonomy_id") REFERENCES "public"."taxonomies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_run_id_suggestion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."suggestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_stops" ADD CONSTRAINT "plan_stops_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_stops" ADD CONSTRAINT "plan_stops_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_generated_by_run_id_suggestion_runs_id_fk" FOREIGN KEY ("generated_by_run_id") REFERENCES "public"."suggestion_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_checkins" ADD CONSTRAINT "stop_checkins_plan_stop_id_plan_stops_id_fk" FOREIGN KEY ("plan_stop_id") REFERENCES "public"."plan_stops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_checkins" ADD CONSTRAINT "stop_checkins_member_id_room_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."room_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_runs" ADD CONSTRAINT "suggestion_runs_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_member_id_room_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."room_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_target_place_id_places_id_fk" FOREIGN KEY ("target_place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_content_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."content_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_unique" ON "auth_sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_family_idx" ON "auth_sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "login_attempts_identifier_idx" ON "login_attempts" USING btree ("identifier_hash","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email")) WHERE "users"."status" <> 'deleted' and "users"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_sessions_token_hash_unique" ON "guest_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guest_sessions_room_idx" ON "guest_sessions" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "preference_selections_member_unique" ON "preference_selections" USING btree ("room_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_constraints_room_version_unique" ON "room_constraints" USING btree ("room_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "room_invites_code_hash_unique" ON "room_invites" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "room_invites_room_idx" ON "room_invites" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_room_user_unique" ON "room_members" USING btree ("room_id","user_id") WHERE "room_members"."user_id" is not null and "room_members"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_room_guest_unique" ON "room_members" USING btree ("room_id","guest_session_id") WHERE "room_members"."guest_session_id" is not null and "room_members"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "room_members_room_idx" ON "room_members" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_seed_places_unique" ON "room_seed_places" USING btree ("room_id","place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_code_unique" ON "rooms" USING btree ("code");--> statement-breakpoint
CREATE INDEX "rooms_host_idx" ON "rooms" USING btree ("host_user_id");--> statement-breakpoint
CREATE INDEX "rooms_status_idx" ON "rooms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "place_hours_place_idx" ON "place_hours" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "place_imports_status_idx" ON "place_imports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "place_imports_submitter_idx" ON "place_imports" USING btree ("submitted_by_user_id");--> statement-breakpoint
CREATE INDEX "place_media_place_idx" ON "place_media" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "place_prices_place_idx" ON "place_prices" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "place_sources_provider_external_unique" ON "place_sources" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "place_sources_place_idx" ON "place_sources" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "place_taxonomies_unique" ON "place_taxonomies" USING btree ("place_id","taxonomy_id");--> statement-breakpoint
CREATE INDEX "place_taxonomies_taxonomy_idx" ON "place_taxonomies" USING btree ("taxonomy_id");--> statement-breakpoint
CREATE INDEX "places_status_idx" ON "places" USING btree ("status");--> statement-breakpoint
CREATE INDEX "places_area_idx" ON "places" USING btree ("area_key");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomies_kind_key_unique" ON "taxonomies" USING btree ("kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_labels_unique" ON "taxonomy_labels" USING btree ("taxonomy_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_synonyms_unique" ON "taxonomy_synonyms" USING btree ("taxonomy_id","term","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_scores_run_place_unique" ON "candidate_scores" USING btree ("run_id","place_id");--> statement-breakpoint
CREATE INDEX "candidate_scores_room_idx" ON "candidate_scores" USING btree ("room_id","is_stale");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_stops_plan_position_unique" ON "plan_stops" USING btree ("plan_id","position");--> statement-breakpoint
CREATE INDEX "plan_stops_place_idx" ON "plan_stops" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_room_version_unique" ON "plans" USING btree ("room_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_room_current_unique" ON "plans" USING btree ("room_id") WHERE "plans"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "stop_checkins_stop_member_unique" ON "stop_checkins" USING btree ("plan_stop_id","member_id");--> statement-breakpoint
CREATE INDEX "suggestion_runs_room_idx" ON "suggestion_runs" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_room_member_target_unique" ON "votes" USING btree ("room_id","member_id","target_place_id");--> statement-breakpoint
CREATE INDEX "votes_room_target_idx" ON "votes" USING btree ("room_id","target_place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_token_unique" ON "device_tokens" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_unique" ON "notification_preferences" USING btree ("user_id","channel","kind");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reviews_place_idx" ON "reviews" USING btree ("place_id","status");--> statement-breakpoint
CREATE INDEX "reviews_user_idx" ON "reviews" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_items_unique" ON "saved_items" USING btree ("user_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_unique" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_items_unique" ON "collection_items" USING btree ("collection_id","place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_collections_slug_locale_unique" ON "content_collections" USING btree ("slug","locale");--> statement-breakpoint
CREATE INDEX "import_jobs_status_idx" ON "import_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_configs_key_version_unique" ON "ranking_configs" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_configs_key_active_unique" ON "ranking_configs" USING btree ("key") WHERE "ranking_configs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("published_at","occurred_at");