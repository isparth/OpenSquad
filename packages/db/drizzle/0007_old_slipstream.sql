CREATE TYPE "public"."conversation_file_status" AS ENUM('stored', 'too_large', 'failed');--> statement-breakpoint
CREATE TABLE "conversation_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"external_artifact_id" text NOT NULL,
	"turn_external_id" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"storage_key" text,
	"status" "conversation_file_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_files" ADD CONSTRAINT "conversation_files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_files" ADD CONSTRAINT "conversation_files_run_id_conversation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."conversation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_files" ADD CONSTRAINT "conversation_files_session_id_runtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."runtime_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_files_session_artifact_idx" ON "conversation_files" USING btree ("session_id","external_artifact_id");--> statement-breakpoint
CREATE INDEX "conversation_files_conversation_time_idx" ON "conversation_files" USING btree ("conversation_id","created_at");