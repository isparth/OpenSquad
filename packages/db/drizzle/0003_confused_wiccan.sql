ALTER TABLE "agents" ADD COLUMN "sandbox_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_sessions" ADD COLUMN "environment" text DEFAULT 'hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_sessions" ADD CONSTRAINT "runtime_sessions_environment_check" CHECK ("runtime_sessions"."environment" in ('hosted', 'none'));