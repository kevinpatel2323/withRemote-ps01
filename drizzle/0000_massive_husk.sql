CREATE TYPE "public"."canonical_type" AS ENUM('party', 'transaction', 'event');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'success', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('scheduled', 'webhook', 'manual');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('hubspot', 'stripe', 'google_calendar');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('INCREMENTAL', 'BACKFILL', 'NEEDS_BACKFILL');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "source" NOT NULL,
	"source_object_type" text,
	"source_id" text,
	"raw" jsonb,
	"error" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "source" NOT NULL,
	"source_object_type" text NOT NULL,
	"source_id" text NOT NULL,
	"canonical_type" "canonical_type" NOT NULL,
	"external_created_at" timestamp with time zone,
	"external_updated_at" timestamp with time zone NOT NULL,
	"title" text,
	"name" text,
	"email" text,
	"amount" numeric,
	"currency" text,
	"status" text,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"description" text,
	"url" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "source" NOT NULL,
	"object_type" text,
	"mode" "sync_mode" NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"cursor_before" text,
	"cursor_after" text,
	"backfill_triggered" boolean DEFAULT false NOT NULL,
	"records_seen" integer DEFAULT 0 NOT NULL,
	"records_inserted" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"records_deduped" integer DEFAULT 0 NOT NULL,
	"records_quarantined" integer DEFAULT 0 NOT NULL,
	"records_deleted" integer DEFAULT 0 NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_state" (
	"source" "source" NOT NULL,
	"object_type" text NOT NULL,
	"cursor_type" text,
	"cursor_value" text,
	"mode" "sync_mode" DEFAULT 'NEEDS_BACKFILL' NOT NULL,
	"last_full_sync_at" timestamp with time zone,
	"last_incremental_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_state_source_object_type_pk" PRIMARY KEY("source","object_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "source" NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"payload" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "records_natural_key" ON "records" USING btree ("source","source_object_type","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "records_canonical_type_idx" ON "records" USING btree ("canonical_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "records_external_updated_at_idx" ON "records" USING btree ("external_updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_run_source_idx" ON "sync_run" USING btree ("source","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_source_event_idx" ON "webhook_events" USING btree ("source","event_id");