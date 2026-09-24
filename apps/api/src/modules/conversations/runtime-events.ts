import type { MessageContentPart, RuntimeEvent, RuntimeMessage } from "@opensquad/core";
import {
  type ConversationRunRow,
  conversationMessages,
  type Database,
  runtimeEventReceipts,
  runtimeSessions,
} from "@opensquad/db";
import { and, eq } from "drizzle-orm";
import { messageDto } from "./dto.js";
import { appendEvent, nextMessageSequence, type Transaction, terminal } from "./persistence.js";
import { runtimeStore, saveRun } from "./run-store.js";

async function saveMessage(tx: Transaction, run: ConversationRunRow, message: RuntimeMessage) {
  if (Buffer.byteLength(JSON.stringify(message)) > 1_000_000)
    throw new Error("Output limit exceeded");
  if (!message.externalId) {
    if (
      run.recoveryMessages.length >= 100 ||
      Buffer.byteLength(JSON.stringify([...run.recoveryMessages, message])) > 1_000_000
    )
      throw new Error("Recovery snapshot limit exceeded");
    await saveRun(tx, run, {
      recoveryMessages: [...run.recoveryMessages, message],
      errorCode: "history_requires_review",
    });
    return;
  }
  let [row] = await tx
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.sessionId, run.sessionId),
        eq(conversationMessages.externalItemId, message.externalId),
      ),
    );
  if (row && row.runId !== run.id) throw new Error("Provider item belongs to another run");
  const content: MessageContentPart[] = message.content.map((part, index) => ({
    ...part,
    index,
    completed: message.status !== "running",
  }));
  if (Buffer.byteLength(JSON.stringify(content)) > 1_000_000)
    throw new Error("Output limit exceeded");
  if (message.role === "user") {
    if (
      message.content.length !== 1 ||
      message.content[0]?.type !== "text" ||
      message.content[0].text !== run.input
    )
      throw new Error("Saved input does not match admission");
    [row] = await tx
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.runId, run.id), eq(conversationMessages.role, "user")));
  }
  if (row?.status === "completed") return;
  const created = !row;
  if (!row) {
    [row] = await tx
      .insert(conversationMessages)
      .values({
        conversationId: run.conversationId,
        participantId: run.agentParticipantId,
        runId: run.id,
        sessionId: run.sessionId,
        sequence: await nextMessageSequence(tx, run.conversationId),
        role: "assistant",
        content: [],
        status: "running",
      })
      .returning();
  }
  if (!row) throw new Error("Message insert failed");
  const [updated] = await tx
    .update(conversationMessages)
    .set({
      externalItemId: message.externalId,
      content,
      phase: message.phase,
      status: message.status,
    })
    .where(eq(conversationMessages.id, row.id))
    .returning();
  if (!updated) throw new Error("Message update failed");
  if (created)
    await appendEvent(tx, run.conversationId, "message.created", run.id, {
      message: messageDto(updated),
    });
  await appendEvent(tx, run.conversationId, "message.completed", run.id, {
    message: messageDto(updated),
  });
}

export function runtimeEvents(db: Database) {
  const store = runtimeStore(db);
  return {
    savedMessage: (ownerId: string, runId: string, token: string, message: RuntimeMessage) =>
      store.owned(ownerId, runId, token, async (tx, run) => {
        if (message.turnExternalId === run.rootTurnId) await saveMessage(tx, run, message);
      }),
    apply: (ownerId: string, runId: string, token: string, event: RuntimeEvent) =>
      store.owned(ownerId, runId, token, async (tx, run) => {
        const [session] = await tx
          .select()
          .from(runtimeSessions)
          .where(eq(runtimeSessions.id, run.sessionId));
        if (session?.externalId !== event.sessionExternalId)
          throw new Error("Event session mismatch");
        if (event.type === "environment.status") {
          const receipts = await tx
            .insert(runtimeEventReceipts)
            .values({ sessionId: run.sessionId, eventId: event.externalId })
            .onConflictDoNothing()
            .returning();
          if (!receipts.length) return "ignored";
          await tx
            .update(runtimeSessions)
            .set({ environmentStatus: event.status })
            .where(eq(runtimeSessions.id, run.sessionId));
          await appendEvent(tx, run.conversationId, "environment.updated", run.id, {
            status: event.status,
          });
          return "applied";
        }
        if (event.type === "session.status") return "ignored";
        if (event.type === "turn.status") {
          if (
            event.turn.subagentExternalId !== null ||
            run.baselineTurnIds.includes(event.turn.externalId)
          )
            return "ignored";
          if (run.rootTurnId && run.rootTurnId !== event.turn.externalId)
            throw new Error("Ambiguous root turn");
          if (terminal(run.status) && event.turn.status !== run.status) return "ignored";
        } else if (event.type !== "runtime.error") {
          if (!run.rootTurnId) return "deferred";
          const turnId =
            event.type === "message.completed"
              ? event.message.turnExternalId
              : event.turnExternalId;
          if (turnId !== run.rootTurnId) return "ignored";
        }
        const receipts = await tx
          .insert(runtimeEventReceipts)
          .values({ sessionId: run.sessionId, eventId: event.externalId })
          .onConflictDoNothing()
          .returning();
        if (!receipts.length) return "ignored";
        if (event.type === "turn.status") {
          await saveRun(tx, run, {
            rootTurnId: event.turn.externalId,
            status: event.turn.status,
            usage: event.turn.usage,
            errorCode:
              event.turn.status === "failed"
                ? "provider_failure"
                : run.errorCode === "history_requires_review"
                  ? run.errorCode
                  : null,
          });
        } else if (event.type === "runtime.error") {
          await saveRun(tx, run, {
            observation: "reconciliation_required",
            errorCode: "provider_failure",
          });
        } else if (event.type === "message.completed") {
          await saveMessage(tx, run, event.message);
        } else {
          let [message] = await tx
            .select()
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.sessionId, run.sessionId),
                eq(conversationMessages.externalItemId, event.itemExternalId),
              ),
            );
          if (message && message.runId !== runId)
            throw new Error("Provider item belongs to another run");
          if (!message) {
            [message] = await tx
              .insert(conversationMessages)
              .values({
                conversationId: run.conversationId,
                participantId: run.agentParticipantId,
                runId,
                sessionId: run.sessionId,
                externalItemId: event.itemExternalId,
                sequence: await nextMessageSequence(tx, run.conversationId),
                role: "assistant",
                content: [],
                status: "running",
              })
              .returning();
            if (message)
              await appendEvent(tx, run.conversationId, "message.created", runId, {
                message: messageDto(message),
              });
          }
          if (!message || message.status === "completed") return "ignored";
          if (
            !Number.isInteger(event.contentIndex) ||
            event.contentIndex < 0 ||
            event.contentIndex >= 100
          )
            throw new Error("Invalid content index");
          const previous = message.content.find((part) => part.index === event.contentIndex);
          if (previous?.completed) return "ignored";
          const text =
            event.type === "message.text.completed"
              ? event.text
              : `${previous?.type === "text" ? previous.text : ""}${event.text}`;
          const content = [
            ...message.content.filter((part) => part.index !== event.contentIndex),
            {
              index: event.contentIndex,
              type: "text" as const,
              text,
              completed: event.type === "message.text.completed",
            },
          ].sort((a, b) => a.index - b.index);
          if (Buffer.byteLength(JSON.stringify(content)) > 1_000_000)
            throw new Error("Output limit exceeded");
          await tx
            .update(conversationMessages)
            .set({ content })
            .where(eq(conversationMessages.id, message.id));
          await appendEvent(tx, run.conversationId, event.type, runId, {
            messageId: message.id,
            contentIndex: event.contentIndex,
            text: event.text,
          });
        }
        return "applied";
      }),
  };
}
