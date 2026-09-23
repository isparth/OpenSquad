CREATE TYPE "public"."memory_update_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."memory_update_trigger" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TABLE "memory_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"auto_update" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"processed_through_sequence" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger" "memory_update_trigger" NOT NULL,
	"status" "memory_update_status" DEFAULT 'running' NOT NULL,
	"base_versions" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"session_external_id" text,
	"error_code" text,
	"usage" jsonb,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD COLUMN "update_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_updates" ADD CONSTRAINT "memory_updates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_updates_running_idx" ON "memory_updates" USING btree ("owner_id") WHERE "memory_updates"."status" = 'running';--> statement-breakpoint
CREATE INDEX "memory_updates_owner_created_idx" ON "memory_updates" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_updates_agent_created_idx" ON "memory_updates" USING btree ("agent_id","created_at");--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_update_id_memory_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."memory_updates"("id") ON DELETE set null ON UPDATE no action;