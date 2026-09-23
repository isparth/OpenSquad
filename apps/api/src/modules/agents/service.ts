import {
  type AgentRow,
  agents,
  conversationRuns,
  conversations,
  type Database,
  type NewAgentRow,
  participants,
} from "@opensquad/db";
import { and, eq, sql } from "drizzle-orm";
import { participantDto } from "../conversations/dto.js";
import { appendEvent } from "../conversations/persistence.js";

export class AgentRunConflict extends Error {
  readonly statusCode = 409;
  constructor() {
    super("Finish or reconcile this bot's active runs before deleting it");
  }
}

export type AgentUpdate = {
  [Field in "name" | "label" | "description" | "instructions" | "sandboxEnabled"]?:
    | AgentRow[Field]
    | undefined;
};
const nextUpdatedAt = sql`greatest(clock_timestamp(), ${agents.updatedAt} + interval '1 millisecond')`;

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

    update: async (ownerId: string, id: string, input: AgentUpdate): Promise<AgentRow | null> => {
      const [row] = await db
        .update(agents)
        .set({ ...input, updatedAt: nextUpdatedAt })
        .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)))
        .returning();
      return row ?? null;
    },

    setAvatar: (ownerId: string, id: string, avatarUrl: string) =>
      db.transaction(async (tx) => {
        const condition = and(eq(agents.id, id), eq(agents.ownerId, ownerId));
        const [previous] = await tx.select().from(agents).where(condition).for("update");
        if (!previous) return null;
        await tx.update(agents).set({ avatarUrl, updatedAt: nextUpdatedAt }).where(condition);
        return { previousUrl: previous.avatarUrl, avatarUrl };
      }),

    delete: (ownerId: string, id: string): Promise<AgentRow | null> =>
      db.transaction(async (tx) => {
        const condition = and(eq(agents.id, id), eq(agents.ownerId, ownerId));
        const [agent] = await tx.select().from(agents).where(condition).for("update");
        if (!agent) return null;
        const [active] = await tx
          .select({ id: conversationRuns.id })
          .from(conversationRuns)
          .innerJoin(participants, eq(participants.id, conversationRuns.agentParticipantId))
          .where(and(eq(participants.agentId, id), eq(conversationRuns.active, true)))
          .limit(1);
        if (active) throw new AgentRunConflict();
        const members = await tx
          .select()
          .from(participants)
          .where(eq(participants.agentId, id))
          .orderBy(participants.conversationId);
        for (const member of members) {
          await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, member.conversationId))
            .for("update");
          const [updated] = await tx
            .update(participants)
            .set({ agentId: null, deletedAt: new Date() })
            .where(eq(participants.id, member.id))
            .returning();
          if (updated)
            await appendEvent(tx, member.conversationId, "participant.updated", null, {
              participant: participantDto(updated),
            });
        }
        await tx.delete(agents).where(condition);
        return agent;
      }),
  };
}
