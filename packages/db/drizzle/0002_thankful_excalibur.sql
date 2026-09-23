CREATE TYPE "public"."memory_document_name" AS ENUM('profile', 'preferences', 'notes');--> statement-breakpoint
CREATE TYPE "public"."memory_revision_author" AS ENUM('user', 'extraction', 'revert');--> statement-breakpoint
CREATE TABLE "memory_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" uuid,
	"name" "memory_document_name" NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_documents_scope_check" CHECK (("memory_documents"."name" = 'notes') = ("memory_documents"."agent_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"author" "memory_revision_author" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_revisions_document_id_version_pk" PRIMARY KEY("document_id","version")
);
--> statement-breakpoint
ALTER TABLE "runtime_sessions" ADD COLUMN "memory_snapshot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_document_id_memory_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."memory_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_documents_shared_idx" ON "memory_documents" USING btree ("owner_id","name") WHERE "memory_documents"."agent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_documents_agent_idx" ON "memory_documents" USING btree ("owner_id","agent_id","name") WHERE "memory_documents"."agent_id" is not null;