import { type AgentRow, agents, type Database, type NewAgentRow } from "@opensquad/db";
import { and, eq } from "drizzle-orm";

/** Data access for agents. Routes call this; this never touches HTTP. */
export function agentsService(db: Database) {
  return {
    list: (ownerId: string): Promise<AgentRow[]> =>
      db.select().from(agents).where(eq(agents.ownerId, ownerId)),

    get: async (ownerId: string, id: string): Promise<AgentRow | null> => {
      const [row] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)));
      return row ?? null;
    },

    create: async (input: NewAgentRow): Promise<AgentRow> => {
      const [row] = await db.insert(agents).values(input).returning();
      if (!row) throw new Error("insert returned no row");
      return row;
    },

    delete: async (ownerId: string, id: string): Promise<boolean> => {
      const rows = await db
        .delete(agents)
        .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)))
        .returning({ id: agents.id });
      return rows.length > 0;
    },
  };
}
