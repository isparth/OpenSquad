CREATE TYPE "public"."conversation_run_status" AS ENUM('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_observation" AS ENUM('connected', 'disconnected', 'reconciliation_required');--> statement-breakpoint
CREATE TYPE "public"."run_phase" AS ENUM('admitted', 'creating', 'subscribing', 'sending', 'observing', 'cancelling', 'uncertain', 'finished');--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"conversation_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"run_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_events_conversation_id_sequence_pk" PRIMARY KEY("conversation_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"external_item_id" text,
	"sequence" bigint NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"phase" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"agent_participant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"input" text NOT NULL,
	"status" "conversation_run_status" DEFAULT 'pending' NOT NULL,
	"observation" "run_observation" DEFAULT 'disconnected' NOT NULL,
	"phase" "run_phase" DEFAULT 'admitted' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"mutation_in_flight" boolean DEFAULT false NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"cancel_dispatched" boolean DEFAULT false NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"root_turn_id" text,
	"baseline_turn_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recovery_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text,
	"event_sequence" bigint DEFAULT 0 NOT NULL,
	"message_sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"agent_id" uuid,
	"name" text NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "participants_kind_check" CHECK ("participants"."kind" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "request_rate_limits" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_event_receipts" (
	"session_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	CONSTRAINT "runtime_event_receipts_session_id_event_id_pk" PRIMARY KEY("session_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "runtime_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_participant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"instructions" text NOT NULL,
	"model" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_run_id_conversation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."conversation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_run_id_conversation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."conversation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_session_id_runtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."runtime_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_runs" ADD CONSTRAINT "conversation_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_runs" ADD CONSTRAINT "conversation_runs_agent_participant_id_participants_id_fk" FOREIGN KEY ("agent_participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_runs" ADD CONSTRAINT "conversation_runs_session_id_runtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."runtime_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_event_receipts" ADD CONSTRAINT "runtime_event_receipts_session_id_runtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."runtime_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_sessions" ADD CONSTRAINT "runtime_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_sessions" ADD CONSTRAINT "runtime_sessions_agent_participant_id_participants_id_fk" FOREIGN KEY ("agent_participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_sequence_idx" ON "conversation_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_external_idx" ON "conversation_messages" USING btree ("session_id","external_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_runs_request_idx" ON "conversation_runs" USING btree ("conversation_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_runs_active_idx" ON "conversation_runs" USING btree ("conversation_id") WHERE "conversation_runs"."active";--> statement-breakpoint
CREATE INDEX "conversation_runs_owner_time_idx" ON "conversation_runs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_owner_id_idx" ON "conversations" USING btree ("owner_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_identity_idx" ON "participants" USING btree ("conversation_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "participants_agent_idx" ON "participants" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_sessions_conversation_idx" ON "runtime_sessions" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_sessions_external_idx" ON "runtime_sessions" USING btree ("provider","external_id");