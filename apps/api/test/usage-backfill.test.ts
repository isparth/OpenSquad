import { randomUUID } from "node:crypto";
import type { RuntimeEvent, RuntimeTurn, RuntimeUsage } from "@opensquad/core";
import {
  agents,
  conversationEvents,
  conversationRuns,
  conversations,
  createDatabase,
} from "@opensquad/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import { testDatabaseUrl } from "./database-url.js";
import { FakeRuntimeProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import { RuntimeQueue } from "./runtime-queue.js";

const root = (externalId: string, usage: RuntimeUsage | null): RuntimeTurn => ({
  externalId,
  subagentExternalId: null,
  status: "succeeded",
  usage,
  error: null,
});

function terminalEvent(sessionExternalId: string, turn: RuntimeTurn): RuntimeEvent {
  return {
    externalId: randomUUID(),
    sessionExternalId,
    turnExternalId: turn.externalId,
    type: "turn.status",
    turn,
  };
}

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("chat run usage backfill", () => {
  const ownerId = "dev-user";
  const usage: RuntimeUsage = { inputTokens: 10, outputTokens: 2 };
  let app: App;
  let runtime: FakeRuntimeProvider;
  let agentId: string;
  let conversationId: string;
  let queues: RuntimeQueue[];
  let sendCount: number;
  let releaseBackfill: (() => void) | null;

  beforeEach(async () => {
    runtime = new FakeRuntimeProvider();
    queues = [];
    sendCount = 0;
    releaseBackfill = null;
    const session = {
      provider: runtime.name,
      externalId: "usage-backfill-session",
      model: "gpt-6-luna",
      status: "idle" as const,
      environmentExternalId: "usage-backfill-environment",
    };
    runtime.createSession.mockResolvedValue(session);
    runtime.events.mockImplementation(async () => {
      const queue = new RuntimeQueue();
      queues.push(queue);
      return queue;
    });
    runtime.listTurns.mockImplementation(async function* () {
      yield* [];
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield* [];
    });
    runtime.sendInput.mockImplementation(async () => {
      const queue = queues[sendCount];
      if (!queue) throw new Error("Expected runtime event queue");
      const index = sendCount++;
      const turn = root(index === 0 ? "root-1" : "root-2", index === 0 ? null : usage);
      queue.emit(terminalEvent(session.externalId, turn));
    });
    app = await createTestApp({
      capabilities: { runtime },
      usageBackfill: { attempts: 5, intervalMs: 5 },
    });
    agentId = (
      await agentsService(app.db).create({
        ownerId,
        name: "Usage backfill bot",
        sandboxEnabled: true,
      })
    ).id;
    conversationId = (await conversationsService(app.db).create(ownerId, agentId, null))
      .conversation.id;
  });

  afterEach(async () => {
    releaseBackfill?.();
    await app.close();
    const cleanup = createDatabase(testDatabaseUrl);
    try {
      await cleanup.db.delete(conversations).where(eq(conversations.id, conversationId));
      await cleanup.db.delete(agents).where(eq(agents.id, agentId));
    } finally {
      await cleanup.close();
    }
  });

  function send(text = "Hello") {
    return app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      headers: { "x-opensquad-runtime-key": "dummy-user-key" },
      payload: { text, clientRequestId: randomUUID() },
    });
  }

  async function waitForRun(runId: string) {
    await vi.waitFor(
      async () => {
        const [run] = await app.db
          .select()
          .from(conversationRuns)
          .where(eq(conversationRuns.id, runId));
        expect(run?.status).toBe("succeeded");
        expect(run?.active).toBe(false);
      },
      { timeout: 3_000, interval: 10 },
    );
  }

  async function waitForUsage(runId: string, expected: RuntimeUsage) {
    await vi.waitFor(
      async () => {
        const [run] = await app.db
          .select()
          .from(conversationRuns)
          .where(eq(conversationRuns.id, runId));
        expect(run?.usage).toEqual(expected);
      },
      { timeout: 3_000, interval: 10 },
    );
  }

  it("backfills a succeeded run and appends the updated usage event", async () => {
    let reads = 0;
    runtime.listTurns.mockImplementation(async function* () {
      reads++;
      yield root("root-1", reads === 1 ? null : usage);
    });

    const response = await send();
    expect(response.statusCode).toBe(202);
    const runId = response.json().run.id as string;
    await waitForRun(runId);
    await waitForUsage(runId, usage);

    const [run] = await app.db
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, runId));
    expect(run?.status).toBe("succeeded");
    expect(run?.active).toBe(false);
    const events = await app.db
      .select()
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, conversationId),
          eq(conversationEvents.runId, runId),
          eq(conversationEvents.type, "run.updated"),
        ),
      );
    expect(
      events.some((event) => {
        const eventRun = (event.payload as { run?: { usage?: RuntimeUsage | null } }).run;
        return eventRun?.usage?.inputTokens === 10 && eventRun.usage.outputTokens === 2;
      }),
    ).toBe(true);
    expect(runtime.listTurns).toHaveBeenCalledTimes(2);
  });

  it("admits the next message while the previous run's usage read is waiting", async () => {
    const gate = deferred();
    const backfillStarted = deferred();
    releaseBackfill = gate.release;
    let reads = 0;
    runtime.listTurns.mockImplementation(async function* () {
      reads++;
      if (reads === 1) {
        backfillStarted.release();
        await gate.promise;
        yield root("root-1", usage);
        return;
      }
      if (reads === 2) yield root("root-1", null);
    });

    const first = await send("First message");
    expect(first.statusCode).toBe(202);
    const firstRunId = first.json().run.id as string;
    await waitForRun(firstRunId);
    await backfillStarted.promise;

    const second = await send("Second message");
    expect(second.statusCode).toBe(202);
    const secondRunId = second.json().run.id as string;
    await waitForRun(secondRunId);
    gate.release();
    await waitForUsage(firstRunId, usage);
    expect(runtime.listTurns).toHaveBeenCalledTimes(2);
  });

  it("does not read saved turns when the terminal event already has usage", async () => {
    runtime.sendInput.mockImplementationOnce(async () => {
      const queue = queues[0];
      if (!queue) throw new Error("Expected runtime event queue");
      queue.emit(terminalEvent("usage-backfill-session", root("root-1", usage)));
    });

    const response = await send();
    expect(response.statusCode).toBe(202);
    const runId = response.json().run.id as string;
    await waitForRun(runId);
    const [run] = await app.db
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, runId));
    expect(run?.usage).toEqual(usage);
    expect(runtime.listTurns).not.toHaveBeenCalled();
  });

  it("keeps the succeeded run unchanged when all saved-turn reads throw", async () => {
    runtime.listTurns.mockImplementation(async function* () {
      const empty: RuntimeTurn[] = [];
      for (const turn of empty) yield turn;
      throw new Error("temporary provider read failure");
    });

    const response = await send();
    expect(response.statusCode).toBe(202);
    const runId = response.json().run.id as string;
    await waitForRun(runId);
    await vi.waitFor(() => expect(runtime.listTurns).toHaveBeenCalledTimes(5), {
      timeout: 3_000,
      interval: 10,
    });
    const [run] = await app.db
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, runId));
    expect(run?.status).toBe("succeeded");
    expect(run?.active).toBe(false);
    expect(run?.usage).toBeNull();
    expect(run?.errorCode).toBeNull();
  });
});
