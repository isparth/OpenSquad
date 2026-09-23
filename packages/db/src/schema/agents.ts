import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  label: text("label"),
  description: text("description").notNull().default(""),
  avatarUrl: text("avatar_url"),
  instructions: text("instructions").notNull().default(""),
  sandboxEnabled: boolean("sandbox_enabled").notNull().default(false),
  // External provider references only. Postgres stays the source of truth. SPEC section 9.
  sandboxExternalId: text("sandbox_external_id"),
  emailInboxExternalId: text("email_inbox_external_id"),
  phoneExternalId: text("phone_external_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
