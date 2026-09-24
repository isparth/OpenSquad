import type { AgentRuntimeProvider, RuntimeCredentials, StorageProvider } from "@opensquad/core";
import type { Database } from "@opensquad/db";
import { ConversationError } from "./dto.js";
import { collectRunFiles, type FileCollectionOptions } from "./file-collection.js";
import { runtimeStore } from "./run-store.js";
import { executeRun } from "./run-worker.js";
import type { UsageBackfillOptions } from "./turn-usage.js";
import { backfillRunUsage } from "./usage-backfill.js";

export function runCoordinator(
  db: Database,
  runtime: AgentRuntimeProvider,
  storage: StorageProvider,
  reportFailure: () => void,
  usageBackfill: UsageBackfillOptions,
  fileCollection: FileCollectionOptions = {},
) {
  const jobs = new Map<string, { controller: AbortController; work: Promise<void> }>();
  const starts = new Set<Promise<void>>();
  let closing = false;
  async function launch(
    ownerId: string,
    runId: string,
    credentials: RuntimeCredentials,
    mode: "execute" | "recover",
  ) {
    if (closing) throw new ConversationError(503, "Runtime worker is shutting down");
    if (jobs.has(runId)) return;
    const token = await runtimeStore(db).claim(ownerId, runId);
    if (!token) return;
    if (closing) {
      await runtimeStore(db).release(ownerId, runId, token, "worker_lost");
      return;
    }
    const controller = new AbortController();
    const work = executeRun({
      db,
      runtime,
      ownerId,
      runId,
      token,
      credentials,
      signal: controller.signal,
      mode,
    })
      .then(async () => {
        await Promise.allSettled([
          backfillRunUsage(
            db,
            runtime,
            ownerId,
            runId,
            credentials,
            controller.signal,
            usageBackfill,
          ),
          collectRunFiles(
            db,
            runtime,
            storage,
            ownerId,
            runId,
            credentials,
            controller.signal,
            fileCollection,
          ),
        ]);
      })
      .catch(reportFailure)
      .finally(() => jobs.delete(runId));
    jobs.set(runId, { controller, work });
  }
  return {
    async start(
      ownerId: string,
      runId: string,
      credentials: RuntimeCredentials,
      mode: "execute" | "recover",
    ) {
      const pending = launch(ownerId, runId, credentials, mode);
      starts.add(pending);
      try {
        await pending;
      } finally {
        starts.delete(pending);
      }
    },
    async close() {
      closing = true;
      await Promise.allSettled(starts);
      for (const job of jobs.values()) job.controller.abort();
      await Promise.all([...jobs.values()].map((job) => job.work));
    },
  };
}
