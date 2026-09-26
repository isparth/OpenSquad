ALTER TABLE "agents" ADD COLUMN "tool_grants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_sessions" ADD COLUMN "tool_grants" jsonb DEFAULT '[]'::jsonb NOT NULL;