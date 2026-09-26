import type {
  AgentToolGrant,
  ConversationEventType,
  ConversationFileStatus,
  EnvironmentStatus,
  MessageContentPart,
  RuntimeMessage,
} from "@opensquad/core";
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

export const conversationRunStatus = pgEnum("conversation_run_status", [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
export const runObservation = pgEnum("run_observation", [
  "connected",
  "disconnected",
  "reconciliation_required",
]);
export const runPhase = pgEnum("run_phase", [
  "admitted",
  "creating",
  "subscribing",
  "sending",
  "observing",
  "cancelling",
  "uncertain",
  "finished",
]);
export const conversationFileStatus = pgEnum("conversation_file_status", [
  "stored",
  "too_large",
  "failed",
]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    title: text("title"),
    eventSequence: bigint("event_sequence", { mode: "bigint" }).notNull().default(sql`0`),
    messageSequence: bigint("message_sequence", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("conversations_owner_id_idx").on(table.ownerId, table.id)],
);

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["user", "agent"] }).notNull(),
    refId: text("ref_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("participants_identity_idx").on(table.conversationId, table.kind, table.refId),
    index("participants_agent_idx").on(table.agentId),
    check("participants_kind_check", sql`${table.kind} in ('user', 'agent')`),
  ],
);

export const runtimeSessions = pgTable(
  "runtime_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    agentParticipantId: uuid("agent_participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    instructions: text("instructions").notNull(),
    memorySnapshot: text("memory_snapshot").notNull().default(""),
    model: text("model").notNull(),
    // Admission always sets this explicitly; the default preserves legacy hosted sessions.
    environment: text("environment", { enum: ["hosted", "none"] })
      .notNull()
      .default("hosted"),
    environmentStatus: text("environment_status").$type<EnvironmentStatus>(),
    toolGrants: jsonb("tool_grants").$type<AgentToolGrant[]>().notNull().default([]),
  },
  (table) => [
    uniqueIndex("runtime_sessions_conversation_idx").on(table.conversationId),
    uniqueIndex("runtime_sessions_external_idx").on(table.provider, table.externalId),
    check("runtime_sessions_environment_check", sql`${table.environment} in ('hosted', 'none')`),
    check(
      "runtime_sessions_environment_status_check",
      sql`${table.environmentStatus} in ('pending', 'ready', 'connected', 'disconnected', 'reset')`,
    ),
  ],
);

export const conversationRuns = pgTable(
  "conversation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    agentParticipantId: uuid("agent_participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => runtimeSessions.id, { onDelete: "cascade" }),
    clientRequestId: uuid("client_request_id").notNull(),
    input: text("input").notNull(),
    status: conversationRunStatus("status").notNull().default("pending"),
    observation: runObservation("observation").notNull().default("disconnected"),
    phase: runPhase("phase").notNull().default("admitted"),
    active: boolean("active").notNull().default(true),
    mutationInFlight: boolean("mutation_in_flight").notNull().default(false),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    cancelDispatched: boolean("cancel_dispatched").notNull().default(false),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    rootTurnId: text("root_turn_id"),
    baselineTurnIds: jsonb("baseline_turn_ids").$type<string[]>().notNull().default([]),
    recoveryMessages: jsonb("recovery_messages").$type<RuntimeMessage[]>().notNull().default([]),
    errorCode: text("error_code"),
    usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("conversation_runs_request_idx").on(table.conversationId, table.clientRequestId),
    uniqueIndex("conversation_runs_active_idx")
      .on(table.conversationId)
      .where(sql`${table.active}`),
    index("conversation_runs_owner_time_idx").on(table.ownerId, table.createdAt),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => conversationRuns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => runtimeSessions.id, { onDelete: "cascade" }),
    externalItemId: text("external_item_id"),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: jsonb("content").$type<MessageContentPart[]>().notNull(),
    phase: text("phase", { enum: ["commentary", "final"] }),
    status: text("status", { enum: ["running", "completed", "incomplete"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_messages_sequence_idx").on(table.conversationId, table.sequence),
    uniqueIndex("conversation_messages_external_idx").on(table.sessionId, table.externalItemId),
  ],
);

export const conversationFiles = pgTable(
  "conversation_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => conversationRuns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => runtimeSessions.id, { onDelete: "cascade" }),
    externalArtifactId: text("external_artifact_id").notNull(),
    turnExternalId: text("turn_external_id").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    storageKey: text("storage_key"),
    status: conversationFileStatus("status").$type<ConversationFileStatus>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_files_session_artifact_idx").on(
      table.sessionId,
      table.externalArtifactId,
    ),
    index("conversation_files_conversation_time_idx").on(table.conversationId, table.createdAt),
  ],
);

export const conversationEvents = pgTable(
  "conversation_events",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    type: text("type").$type<ConversationEventType>().notNull(),
    runId: uuid("run_id").references(() => conversationRuns.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.sequence] })],
);

export const runtimeEventReceipts = pgTable(
  "runtime_event_receipts",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => runtimeSessions.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.eventId] })],
);

export const requestRateLimits = pgTable("request_rate_limits", {
  ownerId: text("owner_id").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

export type ConversationRow = typeof conversations.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type ConversationRunRow = typeof conversationRuns.$inferSelect;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type ConversationFileRow = typeof conversationFiles.$inferSelect;
export type RuntimeSessionRow = typeof runtimeSessions.$inferSelect;
export type ConversationEventRow = typeof conversationEvents.$inferSelect;
