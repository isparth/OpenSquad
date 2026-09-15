import {
  agents,
  conversationEvents,
  conversationMessages,
  conversationRuns,
  conversations,
  type Database,
  participants,
} from "@opensquad/db";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import {
  ConversationError,
  conversationDto,
  eventDto,
  messageDto,
  participantDto,
  runDto,
} from "./dto.js";
import { lockConversation, type Transaction } from "./persistence.js";
import { refreshObservation } from "./run-store.js";

async function readMessages(
  tx: Transaction,
  conversationId: string,
  limit: number,
  before?: bigint,
) {
  const rows = await tx
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        before === undefined ? undefined : lt(conversationMessages.sequence, before),
      ),
    )
    .orderBy(desc(conversationMessages.sequence))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.reverse().map(messageDto),
    nextCursor: rows.length > limit ? (page[0]?.sequence.toString() ?? null) : null,
  };
}

export function conversationsService(db: Database) {
  const eventWindow = (ownerId: string, id: string, after: bigint, limit = 100) => db.transaction(async (tx) => {
    const conversation = await lockConversation(tx, ownerId, id);
    if (after > conversation.eventSequence) throw new ConversationError(400, "Event cursor is ahead of this conversation");
    const [active] = await tx.select().from(conversationRuns).where(and(eq(conversationRuns.conversationId, id), eq(conversationRuns.active, true)));
    if (active) await refreshObservation(tx, active);
    const rows = await tx.select().from(conversationEvents).where(and(eq(conversationEvents.conversationId, id), gt(conversationEvents.sequence, after))).orderBy(asc(conversationEvents.sequence)).limit(limit);
    const [current] = await tx.select({ sequence: conversations.eventSequence }).from(conversations).where(eq(conversations.id, id));
    return { items: rows.map(eventDto), sequence: current?.sequence ?? conversation.eventSequence };
  });
  return {
    create: (ownerId: string, agentId: string, title: string | null) =>
      db.transaction(async (tx) => {
        const [agent] = await tx
          .select()
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
          .for("share");
        if (!agent) throw new ConversationError(404, "Bot not found");
        const [row] = await tx.insert(conversations).values({ ownerId, title }).returning();
        if (!row) throw new Error("Conversation insert failed");
        await tx.insert(participants).values([
          { conversationId: row.id, kind: "user", refId: ownerId, name: "You" },
          {
            conversationId: row.id,
            kind: "agent",
            refId: agent.id,
            agentId: agent.id,
            name: agent.name,
          },
        ]);
        return { conversation: conversationDto(row) };
      }),
    list: async (ownerId: string, limit: number, after?: string) => {
      const rows = await db
        .select({ conversation: conversations })
        .from(conversations)
        .innerJoin(
          participants,
          and(
            eq(participants.conversationId, conversations.id),
            eq(participants.kind, "user"),
            eq(participants.refId, ownerId),
          ),
        )
        .where(
          and(eq(conversations.ownerId, ownerId), after ? gt(conversations.id, after) : undefined),
        )
        .orderBy(asc(conversations.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => conversationDto(row.conversation)),
        nextCursor:
          rows.length > limit
            ? Buffer.from(page.at(-1)?.conversation.id ?? "").toString("base64url")
            : null,
      };
    },
    snapshot: (ownerId: string, id: string) =>
      db.transaction(async (tx) => {
        const conversation = await lockConversation(tx, ownerId, id);
        const members = await tx
          .select()
          .from(participants)
          .where(eq(participants.conversationId, id))
          .orderBy(asc(participants.kind));
        let [active] = await tx
          .select()
          .from(conversationRuns)
          .where(and(eq(conversationRuns.conversationId, id), eq(conversationRuns.active, true)));
        if (active) active = await refreshObservation(tx, active);
        const history = await readMessages(tx, id, 50);
        const [current] = await tx
          .select({ sequence: conversations.eventSequence })
          .from(conversations)
          .where(eq(conversations.id, id));
        return {
          sequence: (current?.sequence ?? conversation.eventSequence).toString(),
          snapshot: {
            conversation: conversationDto(conversation),
            participants: members.map(participantDto),
            activeRun: active ? runDto(active) : null,
            latestMessages: history.items,
            nextMessageCursor: history.nextCursor,
          },
        };
      }),
    messages: (ownerId: string, id: string, limit: number, before?: bigint) =>
      db.transaction(async (tx) => {
        await lockConversation(tx, ownerId, id);
        return readMessages(tx, id, limit, before);
      }),
    eventWindow,
    events: async (ownerId: string, id: string, after: bigint, limit = 100) => (await eventWindow(ownerId, id, after, limit)).items,
  };
}
