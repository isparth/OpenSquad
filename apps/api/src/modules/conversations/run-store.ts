import { randomUUID } from "node:crypto";
import {
  type ConversationRunRow,
  conversationMessages,
  conversationRuns,
  type Database,
  runtimeSessions,
} from "@opensquad/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { ConversationError, messageDto, runDto } from "./dto.js";
import { appendEvent, lockConversation, type Transaction, terminal } from "./persistence.js";

type RunPatch = Partial<
  Pick<
    ConversationRunRow,
    | "status"
    | "observation"
    | "phase"
    | "active"
    | "mutationInFlight"
    | "cancelRequested"
    | "cancelDispatched"
    | "rootTurnId"
    | "baselineTurnIds"
    | "recoveryMessages"
    | "errorCode"
    | "usage"
    | "finishedAt"
  >
>;

export async function withRun<T>(
  db: Database,
  ownerId: string,
  id: string,
  action: (tx: Transaction, run: ConversationRunRow) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [initial] = await tx
      .select()
      .from(conversationRuns)
      .where(and(eq(conversationRuns.id, id), eq(conversationRuns.ownerId, ownerId)));
    if (!initial) throw new ConversationError(404, "Run not found");
    await lockConversation(tx, ownerId, initial.conversationId);
    const [run] = await tx.select().from(conversationRuns).where(eq(conversationRuns.id, id));
    if (!run) throw new ConversationError(404, "Run not found");
    return action(tx, run);
  });
}

export async function saveRun(tx: Transaction, run: ConversationRunRow, patch: RunPatch) {
  const [updated] = await tx
    .update(conversationRuns)
    .set(patch)
    .where(eq(conversationRuns.id, run.id))
    .returning();
  if (!updated) throw new Error("Run update failed");
  await appendEvent(tx, run.conversationId, "run.updated", run.id, { run: runDto(updated) });
  return updated;
}

export async function refreshObservation(tx: Transaction, run: ConversationRunRow) {
  if (!run.active || run.observation === "reconciliation_required") return run;
  const [expired] = await tx
    .select({ id: conversationRuns.id })
    .from(conversationRuns)
    .where(
      and(
        eq(conversationRuns.id, run.id),
        or(
          and(
            isNull(conversationRuns.leaseToken),
            sql`${conversationRuns.createdAt} < clock_timestamp() - interval '30 seconds'`,
          ),
          sql`${conversationRuns.leaseExpiresAt} < clock_timestamp()`,
        ),
      ),
    );
  return expired
    ? saveRun(tx, run, {
        observation: "reconciliation_required",
        errorCode: run.errorCode ?? (run.mutationInFlight ? "uncertain_mutation" : "worker_lost"),
      })
    : run;
}

export function runtimeStore(db: Database) {
  return {
    get: (ownerId: string, id: string) =>
      withRun(db, ownerId, id, async (tx, run) => {
        const [session] = await tx
          .select()
          .from(runtimeSessions)
          .where(
            and(
              eq(runtimeSessions.id, run.sessionId),
              eq(runtimeSessions.conversationId, run.conversationId),
            ),
          );
        if (!session) throw new Error("Runtime reference missing");
        return { run: await refreshObservation(tx, run), session };
      }),
    claim: (ownerId: string, id: string) =>
      withRun(db, ownerId, id, async (tx, run) => {
        if (!run.active) return null;
        const [available] = await tx
          .select({ id: conversationRuns.id })
          .from(conversationRuns)
          .where(
            and(
              eq(conversationRuns.id, id),
              or(
                isNull(conversationRuns.leaseToken),
                sql`${conversationRuns.leaseExpiresAt} < clock_timestamp()`,
              ),
            ),
          );
        if (!available) return null;
        if (run.mutationInFlight)
          throw new ConversationError(
            409,
            "An interrupted provider mutation needs manual recovery before another worker can act",
          );
        const token = randomUUID();
        await tx
          .update(conversationRuns)
          .set({
            leaseToken: token,
            leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
          })
          .where(eq(conversationRuns.id, id));
        return token;
      }),
    owned: <T>(
      ownerId: string,
      id: string,
      token: string,
      action: (tx: Transaction, run: ConversationRunRow) => Promise<T>,
    ) =>
      withRun(db, ownerId, id, async (tx, run) => {
        if (run.leaseToken !== token)
          throw new ConversationError(409, "Execution ownership changed");
        await tx
          .update(conversationRuns)
          .set({ leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'` })
          .where(eq(conversationRuns.id, id));
        return action(tx, run);
      }),
    cancel: (ownerId: string, id: string) =>
      withRun(db, ownerId, id, async (tx, run) => {
        if (!run.active || run.cancelRequested) return run;
        return saveRun(tx, run, { cancelRequested: true });
      }),
    release: (ownerId: string, id: string, token: string, errorCode: string | null) =>
      withRun(db, ownerId, id, async (tx, run) => {
        if (run.leaseToken !== token) return;
        const finished =
          errorCode === null &&
          terminal(run.status) &&
          !run.mutationInFlight &&
          run.recoveryMessages.length === 0 &&
          run.errorCode !== "history_requires_review";
        if (finished) {
          const messages = await tx
            .select()
            .from(conversationMessages)
            .where(
              and(eq(conversationMessages.runId, id), eq(conversationMessages.status, "running")),
            );
          for (const message of messages) {
            const status =
              run.status === "succeeded" &&
              message.content.length > 0 &&
              message.content.every((part) => part.completed)
                ? "completed"
                : "incomplete";
            const [updated] = await tx
              .update(conversationMessages)
              .set({ status })
              .where(eq(conversationMessages.id, message.id))
              .returning();
            if (updated)
              await appendEvent(tx, run.conversationId, "message.completed", id, {
                message: messageDto(updated),
              });
          }
        }
        await tx
          .update(conversationRuns)
          .set({ leaseToken: null, leaseExpiresAt: null })
          .where(eq(conversationRuns.id, id));
        await saveRun(tx, run, {
          active: !finished,
          phase: finished ? "finished" : run.mutationInFlight ? "uncertain" : run.phase,
          observation: finished ? "disconnected" : "reconciliation_required",
          errorCode: errorCode ?? run.errorCode,
          finishedAt: finished ? (run.finishedAt ?? new Date()) : null,
        });
      }),
  };
}
