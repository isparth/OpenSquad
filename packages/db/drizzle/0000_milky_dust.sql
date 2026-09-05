CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"label" text,
	"description" text DEFAULT '' NOT NULL,
	"avatar_url" text,
	"instructions" text DEFAULT '' NOT NULL,
	"sandbox_external_id" text,
	"memory_external_id" text,
	"email_inbox_external_id" text,
	"phone_external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
