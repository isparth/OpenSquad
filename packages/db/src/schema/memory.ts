import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

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

export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => memoryDocuments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    author: memoryRevisionAuthor("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.version] })],
);
