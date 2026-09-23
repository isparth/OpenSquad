import type { AgentRuntimeProvider, RuntimeCredentials } from "@opensquad/core";
import type { Database } from "@opensquad/db";
import { terminal } from "./persistence.js";
import { runtimeStore, saveRun, withRun } from "./run-store.js";
import { awaitTurnUsage, type UsageBackfillOptions } from "./turn-usage.js";

export async function backfillRunUsage(
  db: Database,
  runtime: AgentRuntimeProvider,
  ownerId: string,
  runId: string,
  credentials: RuntimeCredentials,
  signal: AbortSignal,
  options: UsageBackfillOptions,
): Promise<void> {
  try {
    if (signal.aborted) return;
    const { run, session } = await runtimeStore(db).get(ownerId, runId);
    const sessionExternalId = session.externalId;
    if (
      signal.aborted ||
      run.active ||
      !terminal(run.status) ||
      run.usage !== null ||
      !run.rootTurnId ||
      !sessionExternalId ||
      session.provider !== runtime.name
    )
      return;

    const turnExternalId = run.rootTurnId;
    const usage = await awaitTurnUsage(
      runtime,
      { provider: session.provider, externalId: sessionExternalId },
      turnExternalId,
      credentials,
      {
        ...options,
        signal,
      },
    );
    if (!usage || signal.aborted) return;
    await withRun(db, ownerId, runId, async (tx, current) => {
      if (current.usage === null && current.rootTurnId === turnExternalId)
        await saveRun(tx, current, { usage });
    });
  } catch {}
}
