import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRuntimeProvider,
  RuntimeCredentials,
  RuntimeSessionRef,
  RuntimeUsage,
} from "@opensquad/core";

export interface UsageBackfillOptions {
  attempts: number;
  intervalMs: number;
}

export async function awaitTurnUsage(
  runtime: AgentRuntimeProvider,
  ref: RuntimeSessionRef,
  turnExternalId: string,
  credentials: RuntimeCredentials,
  options: UsageBackfillOptions & { signal?: AbortSignal },
): Promise<RuntimeUsage | null> {
  if (options.attempts <= 0) return null;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    if (options.signal?.aborted) return null;
    let usage: RuntimeUsage | null = null;
    try {
      let inspected = 0;
      for await (const turn of runtime.listTurns(
        ref,
        credentials,
        options.signal ? { signal: options.signal } : undefined,
      )) {
        if (inspected >= 1_000) break;
        inspected++;
        if (
          turn.externalId === turnExternalId &&
          turn.subagentExternalId === null &&
          turn.usage !== null
        ) {
          usage = turn.usage;
          break;
        }
      }
    } catch {
      if (options.signal?.aborted) return null;
    }
    if (usage !== null) return usage;
    if (options.signal?.aborted) return null;
    if (attempt + 1 < options.attempts) {
      try {
        await delay(
          options.intervalMs,
          undefined,
          options.signal ? { signal: options.signal } : undefined,
        );
      } catch {
        return null;
      }
    }
  }
  return null;
}
