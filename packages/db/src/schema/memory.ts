import type { MemoryDocumentName, MemoryUpdateChange } from "@opensquad/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { conversations } from "./conversations.js";

export const memoryDocumentName = pgEnum("memory_document_name", [
  "profile",
  "preferences",
  "notes",
]);
export const memoryRevisionAuthor = pgEnum("memory_revision_author", [
  "user",
  "extraction",
  "revert",
]);
export const memoryUpdateStatus = pgEnum("memory_update_status", [
  "running",
  "succeeded",
  "failed",
]);
export const memoryUpdateTrigger = pgEnum("memory_update_trigger", ["auto", "manual"]);

export const memoryDocuments = pgTable(
  "memory_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    name: memoryDocumentName("name").notNull(),
    content: text("content").notNull().default(""),
    version: integer("version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_documents_shared_idx")
      .on(table.ownerId, table.name)
      .where(sql`${table.agentId} is null`),
    uniqueIndex("memory_documents_agent_idx")
      .on(table.ownerId, table.agentId, table.name)
      .where(sql`${table.agentId} is not null`),
    check(
      "memory_documents_scope_check",
      sql`(${table.name} = 'notes') = (${table.agentId} is not null)`,
    ),
  ],
);

export const memoryUpdates = pgTable(
  "memory_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    trigger: memoryUpdateTrigger("trigger").notNull(),
    status: memoryUpdateStatus("status").notNull().default("running"),
    baseVersions: jsonb("base_versions").$type<Record<MemoryDocumentName, number>>().notNull(),
    sources: jsonb("sources")
      .$type<Array<{ conversationId: string; throughSequence: string }>>()
      .notNull(),
    changed: jsonb("changed").$type<MemoryUpdateChange[]>().notNull().default([]),
    provider: text("provider").notNull(),
    sessionExternalId: text("session_external_id"),
    errorCode: text("error_code"),
    usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number }>(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("memory_updates_running_idx")
      .on(table.ownerId)
      .where(sql`${table.status} = 'running'`),
    index("memory_updates_owner_created_idx").on(table.ownerId, table.createdAt),
    index("memory_updates_agent_created_idx").on(table.agentId, table.createdAt),
  ],
);

export const memorySources = pgTable("memory_sources", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  processedThroughSequence: bigint("processed_through_sequence", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memorySettings = pgTable("memory_settings", {
  ownerId: text("owner_id").primaryKey(),
  autoUpdate: boolean("auto_update").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => memoryDocuments.id, { onDelete: "cascade" }),
    updateId: uuid("update_id").references(() => memoryUpdates.id, { onDelete: "set null" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    author: memoryRevisionAuthor("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.version] })],
);
