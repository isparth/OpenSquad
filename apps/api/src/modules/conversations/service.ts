import {
  agents,
  conversationEvents,
  conversationFiles,
  conversationMessages,
  conversationRuns,
  conversations,
  type Database,
  participants,
  runtimeSessions,
} from "@opensquad/db";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  ConversationError,
  conversationDto,
  conversationFileDto,
  eventDto,
  messageDto,
  participantDto,
  runDto,
} from "./dto.js";
import { lockConversation, type Transaction } from "./persistence.js";
import { refreshObservation } from "./run-store.js";

type ConversationFileCursor = { createdAt: Date; id: string };

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
  const eventWindow = (ownerId: string, id: string, after: bigint, limit = 100) =>
    db.transaction(async (tx) => {
      const conversation = await lockConversation(tx, ownerId, id);
      if (after > conversation.eventSequence)
        throw new ConversationError(400, "Event cursor is ahead of this conversation");
      const [active] = await tx
        .select()
        .from(conversationRuns)
        .where(and(eq(conversationRuns.conversationId, id), eq(conversationRuns.active, true)));
      if (active) await refreshObservation(tx, active);
      const rows = await tx
        .select()
        .from(conversationEvents)
        .where(
          and(eq(conversationEvents.conversationId, id), gt(conversationEvents.sequence, after)),
        )
        .orderBy(asc(conversationEvents.sequence))
        .limit(limit);
      const [current] = await tx
        .select({ sequence: conversations.eventSequence })
        .from(conversations)
        .where(eq(conversations.id, id));
      return {
        items: rows.map(eventDto),
        sequence: current?.sequence ?? conversation.eventSequence,
      };
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
    list: async (ownerId: string, limit: number, after?: string, agentId?: string) => {
      const agentParticipant = alias(participants, "agent_participant");
      let query = db
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
        .$dynamic();
      if (agentId !== undefined) {
        query = query.innerJoin(
          agentParticipant,
          and(
            eq(agentParticipant.conversationId, conversations.id),
            eq(agentParticipant.kind, "agent"),
            eq(agentParticipant.refId, agentId),
          ),
        );
      }
      const rows = await query
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
        const [session] = await tx
          .select()
          .from(runtimeSessions)
          .where(eq(runtimeSessions.conversationId, id));
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
            environment: session
              ? { type: session.environment, status: session.environmentStatus }
              : null,
          },
        };
      }),
    messages: (ownerId: string, id: string, limit: number, before?: bigint) =>
      db.transaction(async (tx) => {
        await lockConversation(tx, ownerId, id);
        return readMessages(tx, id, limit, before);
      }),
    files: (ownerId: string, id: string, limit: number, after?: ConversationFileCursor) =>
      db.transaction(async (tx) => {
        await lockConversation(tx, ownerId, id);
        const createdAt = sql<Date>`date_trunc('milliseconds', ${conversationFiles.createdAt})`;
        const cursorCreatedAt = after?.createdAt.toISOString();
        const rows = await tx
          .select()
          .from(conversationFiles)
          .where(
            and(
              eq(conversationFiles.conversationId, id),
              after && cursorCreatedAt
                ? or(
                    lt(createdAt, cursorCreatedAt),
                    and(eq(createdAt, cursorCreatedAt), lt(conversationFiles.id, after.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(createdAt), desc(conversationFiles.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map(conversationFileDto),
          nextCursor:
            rows.length > limit && last
              ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url")
              : null,
        };
      }),
    file: (ownerId: string, id: string, fileId: string) =>
      db.transaction(async (tx) => {
        await lockConversation(tx, ownerId, id);
        const [file] = await tx
          .select()
          .from(conversationFiles)
          .where(
            and(
              eq(conversationFiles.conversationId, id),
              eq(conversationFiles.id, fileId),
              eq(conversationFiles.status, "stored"),
            ),
          );
        return file ?? null;
      }),
    eventWindow,
    events: async (ownerId: string, id: string, after: bigint, limit = 100) =>
      (await eventWindow(ownerId, id, after, limit)).items,
  };
}
