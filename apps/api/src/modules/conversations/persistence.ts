import type { ConversationEventType } from "@opensquad/core";
import { conversationEvents, conversations, type Database, participants } from "@opensquad/db";
import { and, eq, sql } from "drizzle-orm";
import { ConversationError } from "./dto.js";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function lockConversation(tx: Transaction, ownerId: string, id: string) {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.ownerId, ownerId)))
    .for("update");
  if (!row) throw new ConversationError(404, "Conversation not found");
  const [member] = await tx
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(
        eq(participants.conversationId, id),
        eq(participants.kind, "user"),
        eq(participants.refId, ownerId),
      ),
    );
  if (!member) throw new ConversationError(404, "Conversation not found");
  return row;
}

export async function appendEvent(
  tx: Transaction,
  conversationId: string,
  type: ConversationEventType,
  runId: string | null,
  payload: Record<string, unknown>,
) {
  const [row] = await tx
    .update(conversations)
    .set({ eventSequence: sql`${conversations.eventSequence} + 1` })
    .where(eq(conversations.id, conversationId))
    .returning();
  if (!row) throw new ConversationError(404, "Conversation not found");
  await tx
    .insert(conversationEvents)
    .values({ conversationId, sequence: row.eventSequence, type, runId, payload });
}

export async function nextMessageSequence(tx: Transaction, conversationId: string) {
  const [row] = await tx
    .update(conversations)
    .set({ messageSequence: sql`${conversations.messageSequence} + 1` })
    .where(eq(conversations.id, conversationId))
    .returning();
  if (!row) throw new ConversationError(404, "Conversation not found");
  return row.messageSequence;
}

export const terminal = (status: string) => ["succeeded", "failed", "cancelled"].includes(status);
