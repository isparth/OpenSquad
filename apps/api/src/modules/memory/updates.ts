import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRuntimeProvider,
  MemoryDocumentName,
  MemoryUpdate,
  RuntimeCredentials,
  RuntimeTurn,
} from "@opensquad/core";
import {
  agents,
  type Database,
  memoryDocuments,
  memorySettings,
  memorySources,
  memoryUpdates,
} from "@opensquad/db";
import { and, count, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  extractorInput,
  extractorInstructions,
  extractorOutputSchema,
  parseExtractorOutput,
} from "./extractor-prompt.js";
import {
  assertAgent,
  documentLimits,
  lockMemoryOwner,
  MemoryError,
  memoryUpdateDto,
  sweepExpiredMemoryUpdates,
  writeDocument,
} from "./service.js";
import { type SelectedMemorySource, selectSources } from "./sources.js";

const documentNames: MemoryDocumentName[] = ["profile", "preferences", "notes"];
const terminalTurnStatuses = new Set(["succeeded", "failed", "cancelled"]);

interface MemoryJob {
  update: typeof memoryUpdates.$inferSelect;
  bot: { name: string; description: string };
  memory: Record<MemoryDocumentName, string>;
  conversations: SelectedMemorySource[];
  credentials: RuntimeCredentials;
}

interface StartResult {
  started: boolean;
  update: MemoryUpdate | null;
  job?: MemoryJob;
}

class UpdateFailure extends Error {
  constructor(readonly errorCode: string) {
    super(errorCode);
  }
}

async function firstRootTurn(
  runtime: AgentRuntimeProvider,
  ref: { provider: string; externalId: string },
  credentials: RuntimeCredentials,
  signal: AbortSignal,
): Promise<RuntimeTurn | null> {
  let inspected = 0;
  for await (const turn of runtime.listTurns(ref, credentials, { signal })) {
    if (inspected >= 100) break;
    inspected++;
    if (turn.subagentExternalId !== null) continue;
    return terminalTurnStatuses.has(turn.status) ? turn : null;
  }
  return null;
}

async function finalAssistantText(
  runtime: AgentRuntimeProvider,
  ref: { provider: string; externalId: string },
  turnExternalId: string,
  credentials: RuntimeCredentials,
  signal: AbortSignal,
): Promise<string | null> {
  let final: string | null = null;
  let inspected = 0;
  for await (const message of runtime.listMessages(ref, credentials, { signal })) {
    if (inspected >= 100) break;
    inspected++;
    if (
      message.role === "assistant" &&
      message.turnExternalId === turnExternalId &&
      message.status === "completed" &&
      message.phase !== "commentary"
    ) {
      final = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    }
  }
  return final;
}

export function memoryUpdater(
  db: Database,
  runtime: AgentRuntimeProvider,
  options: {
    model: string;
    log: FastifyBaseLogger;
    autoTrigger: boolean;
    turnDeadlineMs: number;
    pollIntervalMs: number;
  },
): {
  refresh(
    ownerId: string,
    agentId: string,
    credentials: RuntimeCredentials,
  ): Promise<{ started: boolean; update: MemoryUpdate | null }>;
  schedule(
    ownerId: string,
    agentId: string,
    excludeConversationId: string,
    credentials: RuntimeCredentials,
  ): void;
  close(): Promise<void>;
} {
  let closing = false;
  const jobs = new Map<string, { controller: AbortController; work: Promise<void> }>();
  const pendingTriggers = new Set<Promise<void>>();

  async function startUpdate(
    ownerId: string,
    agentId: string,
    credentials: RuntimeCredentials,
    trigger: "auto" | "manual",
    excludeConversationId?: string,
  ): Promise<StartResult> {
    return db.transaction(async (tx) => {
      await lockMemoryOwner(tx, ownerId);
      await assertAgent(tx, ownerId, agentId, true);
      await sweepExpiredMemoryUpdates(tx, ownerId);

      if (trigger === "auto") {
        const [setting] = await tx
          .select({ autoUpdate: memorySettings.autoUpdate })
          .from(memorySettings)
          .where(eq(memorySettings.ownerId, ownerId));
        if (setting?.autoUpdate === false) return { started: false, update: null };
      }

      const [running] = await tx
        .select()
        .from(memoryUpdates)
        .where(and(eq(memoryUpdates.ownerId, ownerId), eq(memoryUpdates.status, "running")))
        .limit(1);
      if (running) return { started: false, update: memoryUpdateDto(running) };

      const [recent] = await tx
        .select({ total: count() })
        .from(memoryUpdates)
        .where(
          and(
            eq(memoryUpdates.ownerId, ownerId),
            gte(memoryUpdates.createdAt, sql`clock_timestamp() - interval '1 hour'`),
          ),
        );
      if ((recent?.total ?? 0) >= 10) {
        if (trigger === "manual")
          throw new MemoryError(429, "Memory update limit reached; try again later");
        return { started: false, update: null };
      }

      const conversations = await selectSources(tx, ownerId, agentId, excludeConversationId);
      if (conversations.length === 0) return { started: false, update: null };

      const [bot] = await tx
        .select({ name: agents.name, description: agents.description })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)));
      if (!bot) throw new MemoryError(404, "Bot not found");
      const rows = await tx
        .select({
          name: memoryDocuments.name,
          agentId: memoryDocuments.agentId,
          content: memoryDocuments.content,
          version: memoryDocuments.version,
        })
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.ownerId, ownerId),
            or(isNull(memoryDocuments.agentId), eq(memoryDocuments.agentId, agentId)),
          ),
        );
      const memory: Record<MemoryDocumentName, string> = {
        profile: "",
        preferences: "",
        notes: "",
      };
      const baseVersions: Record<MemoryDocumentName, number> = {
        profile: 0,
        preferences: 0,
        notes: 0,
      };
      for (const row of rows) {
        if (row.name === "notes" && row.agentId !== agentId) continue;
        if (row.name !== "notes" && row.agentId !== null) continue;
        memory[row.name] = row.content;
        baseVersions[row.name] = row.version;
      }

      const [update] = await tx
        .insert(memoryUpdates)
        .values({
          ownerId,
          agentId,
          trigger,
          baseVersions,
          sources: conversations.map(({ conversationId, throughSequence }) => ({
            conversationId,
            throughSequence,
          })),
          provider: runtime.name,
          leaseExpiresAt: sql`clock_timestamp() + ${options.turnDeadlineMs + 180_000} * interval '1 millisecond'`,
        })
        .returning();
      if (!update) throw new Error("Memory update insert returned no row");
      return {
        started: true,
        update: memoryUpdateDto(update),
        job: {
          update,
          bot: { name: bot.name, description: bot.description ?? "" },
          memory,
          conversations,
          credentials,
        },
      };
    });
  }

  async function markFailed(updateId: string, errorCode: string): Promise<boolean> {
    const [row] = await db
      .update(memoryUpdates)
      .set({ status: "failed", errorCode, finishedAt: sql`clock_timestamp()` })
      .where(and(eq(memoryUpdates.id, updateId), eq(memoryUpdates.status, "running")))
      .returning({ id: memoryUpdates.id });
    return Boolean(row);
  }

  async function applyUpdate(
    job: MemoryJob,
    output: NonNullable<ReturnType<typeof parseExtractorOutput>>,
    usage: { inputTokens: number; outputTokens: number } | null,
  ): Promise<{ completed: boolean; changed: MemoryDocumentName[]; errorCode: string | null }> {
    const { update } = job;
    return db.transaction(async (tx) => {
      await lockMemoryOwner(tx, update.ownerId);
      const [currentUpdate] = await tx
        .select()
        .from(memoryUpdates)
        .where(
          and(
            eq(memoryUpdates.id, update.id),
            eq(memoryUpdates.status, "running"),
            gt(memoryUpdates.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .for("update");
      if (!currentUpdate) return { completed: false, changed: [], errorCode: null };

      const rows = await tx
        .select({
          name: memoryDocuments.name,
          agentId: memoryDocuments.agentId,
          content: memoryDocuments.content,
          version: memoryDocuments.version,
        })
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.ownerId, update.ownerId),
            or(isNull(memoryDocuments.agentId), eq(memoryDocuments.agentId, update.agentId)),
          ),
        );
      const current: Record<MemoryDocumentName, { content: string; version: number }> = {
        profile: { content: "", version: 0 },
        preferences: { content: "", version: 0 },
        notes: { content: "", version: 0 },
      };
      for (const row of rows) {
        if (row.name === "notes" && row.agentId !== update.agentId) continue;
        if (row.name !== "notes" && row.agentId !== null) continue;
        current[row.name] = { content: row.content, version: row.version };
      }

      const changed: MemoryUpdate["changed"] = [];
      const conflicted: MemoryDocumentName[] = [];
      for (const name of documentNames) {
        const content = output[name];
        if (content === null) continue;
        if (current[name].version !== currentUpdate.baseVersions[name]) {
          conflicted.push(name);
          continue;
        }
        if (content === current[name].content) continue;
        const saved = await writeDocument(tx, {
          ownerId: update.ownerId,
          agentId: update.agentId,
          name,
          content,
          expectedVersion: current[name].version,
          author: "extraction",
          updateId: update.id,
        });
        changed.push({ name, fromVersion: current[name].version, toVersion: saved.version });
      }

      if (conflicted.length === 0) {
        for (const source of currentUpdate.sources) {
          await tx
            .insert(memorySources)
            .values({
              conversationId: source.conversationId,
              ownerId: update.ownerId,
              agentId: update.agentId,
              processedThroughSequence: BigInt(source.throughSequence),
            })
            .onConflictDoUpdate({
              target: memorySources.conversationId,
              set: {
                ownerId: update.ownerId,
                agentId: update.agentId,
                processedThroughSequence: sql`greatest(${memorySources.processedThroughSequence}, excluded.processed_through_sequence)`,
                updatedAt: sql`clock_timestamp()`,
              },
            });
        }
      }

      const [finished] = await tx
        .update(memoryUpdates)
        .set({
          status: "succeeded",
          changed,
          errorCode: conflicted.length > 0 ? "memory_changed" : null,
          usage,
          finishedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(memoryUpdates.id, update.id), eq(memoryUpdates.status, "running")))
        .returning({ id: memoryUpdates.id });
      return {
        completed: Boolean(finished),
        changed: changed.map((item) => item.name),
        errorCode: conflicted.length > 0 ? "memory_changed" : null,
      };
    });
  }

  async function processJob(job: MemoryJob, signal: AbortSignal): Promise<void> {
    const { update, credentials } = job;
    let session: { provider: string; externalId: string } | null = null;
    let finalStatus: "succeeded" | "failed" | null = null;
    let errorCode: string | null = null;
    let changedNames: MemoryDocumentName[] = [];
    try {
      const created = await runtime.createSession(
        {
          instructions: extractorInstructions,
          model: options.model,
          environment: "none",
          input: extractorInput({
            bot: job.bot,
            memory: job.memory,
            conversations: job.conversations,
          }),
          outputSchema: extractorOutputSchema,
        },
        credentials,
        { signal },
      );
      if (created.provider !== runtime.name || !created.externalId)
        throw new UpdateFailure("provider_failure");
      session = { provider: created.provider, externalId: created.externalId };
      const [persisted] = await db
        .update(memoryUpdates)
        .set({ sessionExternalId: created.externalId })
        .where(and(eq(memoryUpdates.id, update.id), eq(memoryUpdates.status, "running")))
        .returning({ id: memoryUpdates.id });
      if (!persisted) return;

      const deadline = Date.now() + options.turnDeadlineMs;
      let root: RuntimeTurn | null = null;
      while (Date.now() < deadline) {
        let observed: RuntimeTurn | null = null;
        try {
          observed = await firstRootTurn(runtime, session, credentials, signal);
        } catch (error) {
          if (signal.aborted) throw error;
        }
        if (Date.now() >= deadline) break;
        if (observed) {
          root = observed;
          break;
        }
        await delay(
          Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())),
          undefined,
          { signal },
        );
      }
      if (!root) {
        try {
          await runtime.cancel(session, credentials, { signal: AbortSignal.timeout(30_000) });
        } catch {}
        throw new UpdateFailure("deadline_exceeded");
      }
      if (root.status !== "succeeded") throw new UpdateFailure("provider_failure");

      const text = await finalAssistantText(runtime, session, root.externalId, credentials, signal);
      if (text === null) throw new UpdateFailure("invalid_output");
      const output = parseExtractorOutput(text);
      if (!output || documentNames.some((name) => output[name]?.includes("\u0000")))
        throw new UpdateFailure("invalid_output");
      if (documentNames.some((name) => (output[name]?.length ?? 0) > documentLimits[name]))
        throw new UpdateFailure("output_too_long");
      const applied = await applyUpdate(job, output, root.usage);
      if (applied.completed) {
        finalStatus = "succeeded";
        errorCode = applied.errorCode;
        changedNames = applied.changed;
      }
    } catch (error) {
      errorCode =
        closing || signal.aborted
          ? "worker_lost"
          : error instanceof UpdateFailure
            ? error.errorCode
            : "provider_failure";
      try {
        if (await markFailed(update.id, errorCode)) finalStatus = "failed";
      } catch {}
    } finally {
      if (session && !closing) {
        try {
          await runtime.destroySession(session, credentials, {
            signal: AbortSignal.timeout(30_000),
          });
        } catch {}
      }
      if (finalStatus) {
        options.log.info(
          { updateId: update.id, status: finalStatus, errorCode, changed: changedNames },
          "Memory update finished",
        );
      }
    }
  }

  function launch(job: MemoryJob) {
    const controller = new AbortController();
    const work = processJob(job, controller.signal).finally(() => jobs.delete(job.update.id));
    jobs.set(job.update.id, { controller, work });
  }

  async function startAndLaunch(
    ownerId: string,
    agentId: string,
    credentials: RuntimeCredentials,
    trigger: "auto" | "manual",
    excludeConversationId?: string,
  ): Promise<StartResult> {
    const result = await startUpdate(ownerId, agentId, credentials, trigger, excludeConversationId);
    if (result.started && result.job) launch(result.job);
    return result;
  }

  return {
    async refresh(ownerId, agentId, credentials) {
      if (closing) throw new MemoryError(503, "Memory updates are shutting down");
      if (!runtime.features.environmentless || !runtime.features.structuredOutput)
        throw new MemoryError(409, "This runtime cannot update memory");
      const pending = startAndLaunch(ownerId, agentId, credentials, "manual");
      let tracked: Promise<void>;
      tracked = pending
        .then(
          () => {},
          () => {},
        )
        .finally(() => pendingTriggers.delete(tracked));
      pendingTriggers.add(tracked);
      const { started, update } = await pending;
      return { started, update };
    },
    schedule(ownerId, agentId, excludeConversationId, credentials) {
      if (
        closing ||
        !options.autoTrigger ||
        !runtime.features.environmentless ||
        !runtime.features.structuredOutput
      )
        return;
      let pending: Promise<void>;
      pending = startAndLaunch(ownerId, agentId, credentials, "auto", excludeConversationId)
        .then(() => {})
        .catch(() => {
          options.log.warn(
            { updateId: null, status: "failed", errorCode: "trigger_failed", changed: [] },
            "Automatic memory update could not start",
          );
        })
        .finally(() => pendingTriggers.delete(pending));
      pendingTriggers.add(pending);
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pendingTriggers]);
      const active = [...jobs.values()];
      for (const job of active) job.controller.abort();
      await Promise.allSettled(active.map((job) => job.work));
    },
  };
}
