import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentRuntimeProvider,
  type AgentToolGrant,
  type RuntimeCredentials,
  type RuntimeEvent,
  type RuntimeEventStream,
  type RuntimeSessionRef,
  type RuntimeTurn,
  type ToolsCredentials,
  ToolsError,
  type ToolsErrorCode,
  type ToolsProvider,
} from "@opensquad/core";
import { type Database, runtimeSessions } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { OUTPUT_FILES_INSTRUCTION, sessionInstructions } from "../memory/render.js";
import { terminal } from "./persistence.js";
import { runtimeStore, saveRun } from "./run-store.js";
import { runtimeEvents } from "./runtime-events.js";

export interface RunWork {
  db: Database;
  runtime: AgentRuntimeProvider;
  tools: ToolsProvider;
  ownerId: string;
  runId: string;
  token: string;
  credentials: RuntimeCredentials;
  /** Only for creating the tool session; never merged into `credentials`. */
  toolsCredentials?: ToolsCredentials;
  signal: AbortSignal;
  mode: "execute" | "recover";
}

const toolsErrorCodes: Partial<Record<ToolsErrorCode, string>> = {
  unauthorized: "tools_key_rejected",
  policy_mismatch: "tools_policy_mismatch",
};

export async function executeRun(work: RunWork) {
  const { db, runtime, tools, ownerId, runId, token, credentials, toolsCredentials, signal, mode } =
    work;
  const store = runtimeStore(db);
  const processor = runtimeEvents(db);
  const owned = <T>(action: Parameters<typeof store.owned<T>>[3]) =>
    store.owned(ownerId, runId, token, action);
  let stream: RuntimeEventStream | undefined;
  let pump: Promise<void> | undefined;
  let done = false;
  let pumpFailure: string | null = null;
  let errorCode: string | null = null;
  let failureCode: string | null = null;
  let bufferedBytes = 0;
  const queued: RuntimeEvent[] = [];
  const deferred: RuntimeEvent[] = [];

  async function mutate<T>(
    phase: "creating" | "sending" | "cancelling",
    call: () => Promise<T>,
    persist?: (value: T) => Promise<void>,
    nextPhase: "subscribing" | "observing" = "observing",
  ) {
    signal.throwIfAborted();
    await owned(async (tx, run) => {
      if (run.mutationInFlight || !run.active)
        throw new Error("Run cannot dispatch another mutation");
      await saveRun(tx, run, {
        phase,
        mutationInFlight: true,
        ...(phase === "cancelling" ? { cancelDispatched: true } : {}),
      });
    });
    let value: T;
    try {
      value = await call();
    } catch {
      await owned((tx, run) =>
        saveRun(tx, run, {
          phase: "uncertain",
          mutationInFlight: false,
          observation: "reconciliation_required",
          errorCode: "uncertain_mutation",
        }),
      );
      errorCode = "uncertain_mutation";
      throw new Error("Uncertain provider mutation");
    }
    if (persist) await persist(value);
    await owned((tx, run) =>
      saveRun(tx, run, {
        mutationInFlight: false,
        phase: nextPhase,
      }),
    );
    return value;
  }

  async function openToolSession(sessionId: string, grants: AgentToolGrant[]) {
    if (!toolsCredentials) {
      failureCode = "tools_key_required";
      throw new Error("Tools key unavailable");
    }
    try {
      const active = (await tools.listConnections(toolsCredentials, ownerId, { signal })).filter(
        (connection) => connection.status === "active",
      );
      const resolved = grants.map((grant) => {
        const matches = active.filter((connection) => connection.toolkit === grant.toolkit);
        if (matches.length !== 1 || !matches[0]) {
          failureCode = matches.length ? "tools_multiple_accounts" : "tools_not_connected";
          throw new Error("Tool connection unavailable");
        }
        return { ...grant, connectionId: matches[0].id };
      });
      signal.throwIfAborted();
      const result = await tools.createSession(toolsCredentials, ownerId, resolved, { signal });
      await owned(async (tx) => {
        await tx
          .update(runtimeSessions)
          .set({ toolsExternalId: result.externalId })
          .where(eq(runtimeSessions.id, sessionId));
      });
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      failureCode ??=
        (error instanceof ToolsError && toolsErrorCodes[error.code]) || "tools_unavailable";
      throw new Error("Tool session setup failed");
    }
  }

  async function savedTurns(ref: RuntimeSessionRef) {
    const result: RuntimeTurn[] = [];
    for await (const turn of runtime.listTurns(ref, credentials, { signal })) {
      if (result.length >= 1000) throw new Error("History limit exceeded");
      result.push(turn);
    }
    return result.filter((turn) => turn.subagentExternalId === null);
  }

  async function apply(event: RuntimeEvent) {
    const result = await processor.apply(ownerId, runId, token, event);
    if (result === "deferred") {
      deferred.push(event);
      return;
    }
    bufferedBytes -= Buffer.byteLength(JSON.stringify(event));
    if (event.type === "turn.status" && result === "applied" && deferred.length) {
      for (const pending of deferred.splice(0)) await apply(pending);
    }
  }

  try {
    let { run, session } = await store.get(ownerId, runId);
    if (session.provider !== runtime.name)
      throw new Error("Runtime is unavailable for this session");
    if (mode === "execute" && run.cancelRequested) {
      await owned((tx, current) => saveRun(tx, current, { status: "cancelled" }));
      return;
    }
    if (
      mode === "recover" &&
      (run.phase === "admitted" || run.phase === "subscribing") &&
      !run.rootTurnId
    ) {
      await owned((tx, current) =>
        saveRun(tx, current, { status: "failed", errorCode: "provider_failure" }),
      );
      return;
    }
    const created = !session.externalId;
    const submitted = created && session.environment === "none";
    if (created) {
      if (mode !== "execute" || run.phase !== "admitted") {
        errorCode = "uncertain_mutation";
        throw new Error("Provider reference requires manual recovery");
      }
      const baseInstructions = sessionInstructions(session.instructions, session.memorySnapshot);
      const instructions =
        session.environment === "hosted"
          ? `${baseInstructions}${baseInstructions ? "\n\n" : ""}${OUTPUT_FILES_INSTRUCTION}`
          : baseInstructions;
      const toolSession = session.toolGrants.length
        ? await openToolSession(session.id, session.toolGrants)
        : null;
      if (toolSession && (await store.get(ownerId, runId)).run.cancelRequested) {
        await owned((tx, current) => saveRun(tx, current, { status: "cancelled" }));
        return;
      }
      await mutate(
        "creating",
        () =>
          runtime.createSession(
            {
              instructions,
              model: session.model,
              environment: session.environment,
              ...(submitted ? { input: run.input } : {}),
              ...(toolSession ? { mcpServers: [toolSession.mcpServer] } : {}),
            },
            toolSession
              ? {
                  ...credentials,
                  mcp: { [toolSession.mcpServer.name]: { headers: toolSession.mcpHeaders } },
                }
              : credentials,
            { signal },
          ),
        async (result) => {
          if (result.provider !== runtime.name || !result.externalId)
            throw new Error("Invalid runtime reference");
          await owned(async (tx) => {
            await tx
              .update(runtimeSessions)
              .set({ externalId: result.externalId })
              .where(eq(runtimeSessions.id, session.id));
          });
        },
        submitted ? "observing" : "subscribing",
      );
      ({ run, session } = await store.get(ownerId, runId));
    }
    if (!session.externalId) throw new Error("Provider reference unavailable");
    const ref: RuntimeSessionRef = { provider: session.provider, externalId: session.externalId };
    const cancel = () => mutate("cancelling", () => runtime.cancel(ref, credentials, { signal }));
    try {
      stream = await runtime.events(ref, credentials, { signal });
    } catch {
      if ((mode === "recover" || submitted) && run.cancelRequested && !run.cancelDispatched)
        await cancel();
      throw new Error("Subscription failed");
    }
    const subscription = stream;
    pump = (async () => {
      try {
        for await (const event of subscription) {
          bufferedBytes += Buffer.byteLength(JSON.stringify(event));
          if (queued.length + deferred.length >= 1000 || bufferedBytes > 1_000_000) {
            pumpFailure = "output_limit";
            subscription.close();
            break;
          }
          queued.push(event);
        }
      } catch {
        pumpFailure = "stream_disconnected";
      } finally {
        done = true;
      }
    })();

    if (mode === "execute" && !submitted) {
      const baseline = created ? [] : await savedTurns(ref);
      if (baseline.some((turn) => !terminal(turn.status)))
        throw new Error("Session already has unresolved work");
      await owned((tx, current) =>
        saveRun(tx, current, {
          phase: "subscribing",
          baselineTurnIds: baseline.map((turn) => turn.externalId),
        }),
      );
      if (done || pumpFailure) throw new Error("Subscription ended before input");
      const current = (await store.get(ownerId, runId)).run;
      if (current.cancelRequested) {
        await owned((tx, value) => saveRun(tx, value, { status: "cancelled" }));
        return;
      }
      await mutate("sending", () => runtime.sendInput(ref, current.input, credentials, { signal }));
    } else {
      const turns = await savedTurns(ref);
      const candidates = turns.filter((turn) =>
        run.rootTurnId
          ? turn.externalId === run.rootTurnId
          : !run.baselineTurnIds.includes(turn.externalId),
      );
      if (candidates.length > 1) {
        errorCode = "history_requires_review";
        throw new Error("Ambiguous root turn");
      }
      const root = candidates[0];
      if (root) {
        await processor.apply(ownerId, runId, token, {
          type: "turn.status",
          externalId: randomUUID(),
          sessionExternalId: ref.externalId,
          turnExternalId: root.externalId,
          turn: root,
        });
        let count = 0;
        for await (const message of runtime.listMessages(ref, credentials, { signal })) {
          if (++count > 1000) throw new Error("History limit exceeded");
          await processor.savedMessage(ownerId, runId, token, message);
        }
      }
    }
    await owned((tx, current) =>
      saveRun(tx, current, { observation: "connected", phase: "observing" }),
    );

    while (!signal.aborted) {
      for (const event of queued.splice(0)) await apply(event);
      const current = await owned(async (tx, value) => {
        if (
          !terminal(value.status) &&
          value.deadlineAt.getTime() <= Date.now() &&
          !value.cancelRequested
        )
          return saveRun(tx, value, { cancelRequested: true, errorCode: "deadline_exceeded" });
        return value;
      });
      if (terminal(current.status)) break;
      if (current.cancelRequested && !current.cancelDispatched) await cancel();
      if (pumpFailure || done) {
        errorCode = pumpFailure ?? "stream_disconnected";
        throw new Error("Subscription ended without a root outcome");
      }
      await delay(100, undefined, { signal });
    }
    if (signal.aborted) errorCode = "worker_lost";
  } catch {
    if (pumpFailure === "output_limit" && !signal.aborted) {
      errorCode = "output_limit";
      const { run, session } = await store.get(ownerId, runId);
      if (session.externalId && !run.cancelDispatched && !run.mutationInFlight) {
        try {
          await mutate("cancelling", () =>
            runtime.cancel(
              { provider: session.provider, externalId: session.externalId as string },
              credentials,
              { signal },
            ),
          );
        } catch {
          errorCode = "uncertain_mutation";
        }
      }
    }
    if (signal.aborted) errorCode = "worker_lost";
    const state = await store.get(ownerId, runId);
    if (
      errorCode !== "output_limit" &&
      !signal.aborted &&
      state.run.leaseToken === token &&
      mode === "execute" &&
      !state.run.mutationInFlight &&
      ["admitted", "subscribing"].includes(state.run.phase)
    ) {
      await owned((tx, current) =>
        saveRun(tx, current, { status: "failed", errorCode: failureCode ?? "provider_failure" }),
      );
    } else {
      errorCode ??= state.run.errorCode ?? "stream_disconnected";
    }
  } finally {
    stream?.close();
    await pump;
    await store.release(ownerId, runId, token, errorCode);
  }
}
