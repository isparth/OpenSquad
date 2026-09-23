import {
  conversationMessages,
  conversationRuns,
  conversations,
  memorySources,
  participants,
} from "@opensquad/db";
import { and, asc, eq, exists, gt, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { Transaction } from "../conversations/persistence.js";
import type { ExtractorConversation } from "./extractor-prompt.js";

export interface SelectedMemorySource extends ExtractorConversation {
  conversationId: string;
  throughSequence: string;
}

const eligibleMessage = and(
  eq(conversationMessages.status, "completed"),
  or(
    eq(conversationMessages.role, "user"),
    and(
      eq(conversationMessages.role, "assistant"),
      sql`${conversationMessages.phase} is distinct from 'commentary'`,
    ),
  ),
);

async function advanceSource(
  tx: Transaction,
  ownerId: string,
  agentId: string,
  conversationId: string,
  sequence: bigint,
) {
  await tx
    .insert(memorySources)
    .values({
      conversationId,
      ownerId,
      agentId,
      processedThroughSequence: sequence,
    })
    .onConflictDoUpdate({
      target: memorySources.conversationId,
      set: {
        ownerId,
        agentId,
        processedThroughSequence: sequence,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

export async function selectSources(
  tx: Transaction,
  ownerId: string,
  agentId: string,
  excludeConversationId?: string,
): Promise<SelectedMemorySource[]> {
  const hasEligibleMessage = exists(
    tx
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversations.id),
          gt(
            conversationMessages.sequence,
            sql`coalesce(${memorySources.processedThroughSequence}, 0)`,
          ),
          eligibleMessage,
        ),
      ),
  );
  const hasActiveRun = notExists(
    tx
      .select({ id: conversationRuns.id })
      .from(conversationRuns)
      .where(
        and(
          eq(conversationRuns.conversationId, conversations.id),
          eq(conversationRuns.active, true),
        ),
      ),
  );
  const candidates = await tx
    .select({
      id: conversations.id,
      createdAt: conversations.createdAt,
      messageSequence: conversations.messageSequence,
      processedThroughSequence: memorySources.processedThroughSequence,
    })
    .from(conversations)
    .innerJoin(
      participants,
      and(
        eq(participants.conversationId, conversations.id),
        eq(participants.kind, "agent"),
        eq(participants.agentId, agentId),
        isNull(participants.deletedAt),
      ),
    )
    .leftJoin(
      memorySources,
      and(
        eq(memorySources.conversationId, conversations.id),
        eq(memorySources.ownerId, ownerId),
        eq(memorySources.agentId, agentId),
      ),
    )
    .where(
      and(
        eq(conversations.ownerId, ownerId),
        excludeConversationId ? ne(conversations.id, excludeConversationId) : undefined,
        hasActiveRun,
        hasEligibleMessage,
      ),
    )
    .orderBy(asc(conversations.createdAt), asc(conversations.id))
    .limit(3);

  const selected: SelectedMemorySource[] = [];
  for (const candidate of candidates) {
    const processedThrough = candidate.processedThroughSequence ?? 0n;
    const messages = await tx
      .select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, candidate.id),
          gt(conversationMessages.sequence, processedThrough),
          eligibleMessage,
        ),
      )
      .orderBy(asc(conversationMessages.sequence));
    const textMessages = messages.flatMap((message) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .sort((left, right) => left.index - right.index)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      return text.trim() ? [{ role: message.role, text }] : [];
    });
    if (textMessages.length === 0) {
      await advanceSource(tx, ownerId, agentId, candidate.id, candidate.messageSequence);
      continue;
    }

    let totalCharacters = 0;
    let earlierMessagesOmitted = false;
    const boundedMessages: SelectedMemorySource["messages"] = [];
    for (let index = textMessages.length - 1; index >= 0; index--) {
      const message = textMessages[index];
      if (!message) continue;
      if (totalCharacters + message.text.length > 30_000) {
        earlierMessagesOmitted = true;
        if (boundedMessages.length === 0) {
          boundedMessages.unshift({ ...message, text: message.text.slice(-30_000) });
        }
        break;
      }
      boundedMessages.unshift(message);
      totalCharacters += message.text.length;
    }

    selected.push({
      conversationId: candidate.id,
      throughSequence: candidate.messageSequence.toString(),
      startedAt: candidate.createdAt.toISOString(),
      earlierMessagesOmitted,
      messages: boundedMessages,
    });
  }
  return selected;
}
