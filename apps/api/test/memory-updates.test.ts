import { randomUUID } from "node:crypto";
import type { RuntimeMessage, RuntimeTurn } from "@opensquad/core";
import {
  agents,
  conversationMessages,
  conversationRuns,
  conversations,
  createDatabase,
  memoryDocuments,
  memoryRevisions,
  memorySettings,
  memorySources,
  memoryUpdates,
  participants,
  runtimeSessions,
} from "@opensquad/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import {
  extractorInput,
  extractorInstructions,
  extractorOutputSchema,
} from "../src/modules/memory/extractor-prompt.js";
import { selectSources } from "../src/modules/memory/sources.js";
import { testDatabaseUrl } from "./database-url.js";
import { FakeRuntimeProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import { RuntimeQueue } from "./runtime-queue.js";

type SeedMessage = {
  role: "user" | "assistant";
  text: string;
  status?: "completed" | "incomplete";
  phase?: "commentary" | "final" | null;
};

describe("automatic memory updates", () => {
  const ownerId = "dev-user";
  let app: App;
  let runtime: FakeRuntimeProvider;
  let agentId: string;
  let agentIds: string[];
  let conversationIds: string[];
  let queues: Map<string, RuntimeQueue>;
  let sessionNumber: number;
  let extractionText: string;
  let extractionTurnStatus: RuntimeTurn["status"] | null;
  let rejectExtractionCreation: boolean;
  let extractionGate: { promise: Promise<void>; release: () => void } | null;
  let appClosed: boolean;

  function holdExtractionCreation() {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    extractionGate = { promise, release };
  }

  async function createBot(owner = ownerId, name = "Memory bot", sandboxEnabled = true) {
    const agent = await agentsService(app.db).create({ ownerId: owner, name, sandboxEnabled });
    agentIds.push(agent.id);
    return agent.id;
  }

  async function createConversation(id = agentId, owner = ownerId) {
    const { conversation } = await conversationsService(app.db).create(owner, id, null);
    conversationIds.push(conversation.id);
    return conversation.id;
  }

  async function addTranscript(
    id: string,
    messages: SeedMessage[],
    options: { createdAt?: Date; active?: boolean } = {},
  ) {
    const conversationId = await createConversation(id);
    if (options.createdAt)
      await app.db
        .update(conversations)
        .set({ createdAt: options.createdAt })
        .where(eq(conversations.id, conversationId));
    const [user] = await app.db
      .select()
      .from(participants)
      .where(and(eq(participants.conversationId, conversationId), eq(participants.kind, "user")));
    const [agent] = await app.db
      .select()
      .from(participants)
      .where(and(eq(participants.conversationId, conversationId), eq(participants.kind, "agent")));
    if (!user || !agent) throw new Error("Expected conversation participants");
    const [session] = await app.db
      .insert(runtimeSessions)
      .values({
        conversationId,
        agentParticipantId: agent.id,
        provider: runtime.name,
        externalId: `history_${randomUUID().replaceAll("-", "")}`,
        instructions: "",
        memorySnapshot: "",
        model: "gpt-6-luna",
        environment: "hosted",
      })
      .returning();
    if (!session) throw new Error("Expected runtime session");
    const active = options.active ?? false;
    const [run] = await app.db
      .insert(conversationRuns)
      .values({
        conversationId,
        ownerId,
        agentParticipantId: agent.id,
        sessionId: session.id,
        clientRequestId: randomUUID(),
        input: messages[0]?.text ?? "history",
        status: active ? "running" : "succeeded",
        observation: "connected",
        phase: active ? "observing" : "finished",
        active,
        deadlineAt: new Date(Date.now() + 60_000),
        finishedAt: active ? null : new Date(),
      })
      .returning();
    if (!run) throw new Error("Expected conversation run");
    if (messages.length > 0) {
      await app.db.insert(conversationMessages).values(
        messages.map((message, index) => ({
          conversationId,
          participantId: message.role === "user" ? user.id : agent.id,
          runId: run.id,
          sessionId: session.id,
          sequence: BigInt(index + 1),
          role: message.role,
          status: message.status ?? "completed",
          phase: message.phase ?? (message.role === "assistant" ? "final" : null),
          content: [{ index: 0, type: "text" as const, text: message.text, completed: true }],
        })),
      );
      await app.db
        .update(conversations)
        .set({ messageSequence: BigInt(messages.length) })
        .where(eq(conversations.id, conversationId));
    }
    return { conversationId, throughSequence: String(messages.length) };
  }

  async function sendMessage(conversationId: string, text: string) {
    return app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      headers: { "x-opensquad-runtime-key": "dummy-user-key" },
      payload: { text, clientRequestId: randomUUID() },
    });
  }

  async function startManualRefresh(id = agentId, key = true) {
    return app.inject({
      method: "POST",
      url: `/agents/${id}/memory/refresh`,
      headers: key ? { "x-opensquad-runtime-key": "dummy-user-key" } : {},
      payload: {},
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
      },
      { timeout: 3_000, interval: 10 },
    );
  }

  async function waitForUpdate(id?: string, status?: "running" | "succeeded" | "failed") {
    let row: typeof memoryUpdates.$inferSelect | undefined;
    await vi.waitFor(
      async () => {
        const rows = await app.db
          .select()
          .from(memoryUpdates)
          .where(eq(memoryUpdates.ownerId, ownerId))
          .orderBy(memoryUpdates.createdAt);
        row = id ? rows.find((item) => item.id === id) : rows.at(-1);
        expect(row).toBeDefined();
        if (status) expect(row?.status).toBe(status);
      },
      { timeout: 3_000, interval: 10 },
    );
    if (!row) throw new Error("Expected memory update");
    return row;
  }

  async function waitUntil(predicate: () => boolean) {
    await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3_000, interval: 5 });
  }

  beforeEach(async () => {
    runtime = new FakeRuntimeProvider();
    queues = new Map();
    sessionNumber = 0;
    extractionText = JSON.stringify({ profile: "- Name: Parth", preferences: null, notes: null });
    extractionTurnStatus = "succeeded";
    rejectExtractionCreation = false;
    extractionGate = null;
    appClosed = false;
    app = await createTestApp({
      capabilities: { runtime },
      memoryUpdates: { autoTrigger: true, pollIntervalMs: 5, turnDeadlineMs: 300 },
    });
    agentIds = [];
    conversationIds = [];
    agentId = await createBot();

    runtime.createSession.mockImplementation(async (options) => {
      if (options.outputSchema) {
        if (rejectExtractionCreation) throw new Error("provider secret must not be logged");
        if (extractionGate) await extractionGate.promise;
      }
      const isExtraction = options.outputSchema !== undefined;
      const externalId = `${isExtraction ? "extract" : "chat"}_${++sessionNumber}`;
      return {
        provider: runtime.name,
        externalId,
        model: options.model ?? "gpt-6-luna",
        status: "idle",
        environmentExternalId: options.environment === "none" ? null : "env_test",
      };
    });
    runtime.events.mockImplementation(async (session) => {
      const queue = new RuntimeQueue();
      queues.set(session.externalId, queue);
      return queue;
    });
    runtime.sendInput.mockImplementation(async (session) => {
      const queue = queues.get(session.externalId);
      if (!queue) throw new Error("Expected chat stream");
      const turn: RuntimeTurn = {
        externalId: "chat-root",
        subagentExternalId: null,
        status: "succeeded",
        usage: null,
        error: null,
      };
      queue.emit({
        externalId: randomUUID(),
        sessionExternalId: session.externalId,
        turnExternalId: turn.externalId,
        type: "turn.status",
        turn,
      });
    });
    runtime.listTurns.mockImplementation(async function* (session) {
      if (!session.externalId.startsWith("extract_")) return;
      if (extractionTurnStatus === null) return;
      yield {
        externalId: "extract-root",
        subagentExternalId: null,
        status: extractionTurnStatus,
        usage: { inputTokens: 12, outputTokens: 7 },
        error: null,
      };
    });
    runtime.listMessages.mockImplementation(async function* (session) {
      if (!session.externalId.startsWith("extract_")) return;
      const message: RuntimeMessage = {
        externalId: "extract-message",
        turnExternalId: "extract-root",
        role: "assistant",
        status: "completed",
        phase: "final",
        content: [{ type: "text", text: extractionText }],
      };
      yield message;
    });
    runtime.cancel.mockResolvedValue(undefined);
    runtime.destroySession.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (!appClosed) await app.close();
    const cleanup = createDatabase(testDatabaseUrl);
    try {
      await cleanup.db.delete(memoryUpdates).where(eq(memoryUpdates.ownerId, ownerId));
      await cleanup.db.delete(memorySources).where(eq(memorySources.ownerId, ownerId));
      await cleanup.db.delete(memorySettings).where(eq(memorySettings.ownerId, ownerId));
      await cleanup.db.delete(memoryDocuments).where(eq(memoryDocuments.ownerId, ownerId));
      if (conversationIds.length > 0)
        await cleanup.db.delete(conversations).where(inArray(conversations.id, conversationIds));
      if (agentIds.length > 0) await cleanup.db.delete(agents).where(inArray(agents.id, agentIds));
    } finally {
      await cleanup.close();
    }
  });

  it("auto-updates from earlier conversations on a first message and leaves the chat run intact", async () => {
    const startedAt = new Date("2026-09-01T00:00:00.000Z");
    const earlier = await addTranscript(
      agentId,
      [
        { role: "user", text: "My name is Parth" },
        { role: "assistant", text: "Nice to meet you" },
      ],
      { createdAt: startedAt },
    );
    const conversationId = await createConversation();
    const response = await sendMessage(conversationId, "Remember this later");
    expect(response.statusCode).toBe(202);
    await waitForRun(response.json().run.id);
    const update = await waitForUpdate(undefined, "succeeded");
    const [history] = await app.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, earlier.conversationId));
    expect(history).toBeDefined();
    expect(runtime.createSession.mock.calls.find(([options]) => options.outputSchema)?.[0]).toEqual(
      {
        instructions: extractorInstructions,
        model: "gpt-6-luna",
        environment: "none",
        input: extractorInput({
          bot: { name: "Memory bot", description: "" },
          memory: { profile: "", preferences: "", notes: "" },
          conversations: [
            {
              startedAt: startedAt.toISOString(),
              earlierMessagesOmitted: false,
              messages: [
                { role: "user", text: "My name is Parth" },
                { role: "assistant", text: "Nice to meet you" },
              ],
            },
          ],
        }),
        outputSchema: extractorOutputSchema,
      },
    );
    expect(update).toMatchObject({
      status: "succeeded",
      changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
      usage: { inputTokens: 12, outputTokens: 7 },
      errorCode: null,
    });
    const [document] = await app.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.ownerId, ownerId));
    expect(document).toMatchObject({ name: "profile", content: "- Name: Parth", version: 1 });
    if (!document) throw new Error("Expected extracted memory document");
    const [revision] = await app.db
      .select()
      .from(memoryRevisions)
      .where(eq(memoryRevisions.documentId, document.id));
    expect(revision).toMatchObject({ author: "extraction", updateId: update.id });
    const [source] = await app.db
      .select()
      .from(memorySources)
      .where(eq(memorySources.conversationId, earlier.conversationId));
    expect(source?.processedThroughSequence).toBe(2n);
    expect(
      await app.db
        .select()
        .from(memorySources)
        .where(eq(memorySources.conversationId, conversationId)),
    ).toHaveLength(0);
    expect(runtime.destroySession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: runtime.name,
        externalId: expect.stringMatching(/^extract_/),
      }),
      { apiKey: "dummy-user-key" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not trigger on follow-ups, with auto-update disabled, or when sources are current", async () => {
    const earlier = await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
    await app.inject({ method: "PATCH", url: "/memory/settings", payload: { autoUpdate: false } });
    const conversationId = await createConversation();
    const first = await sendMessage(conversationId, "First");
    await waitForRun(first.json().run.id);
    await app.inject({ method: "PATCH", url: "/memory/settings", payload: { autoUpdate: true } });
    const second = await sendMessage(conversationId, "Follow-up");
    await waitForRun(second.json().run.id);
    expect(
      runtime.createSession.mock.calls.filter(([options]) => options.outputSchema),
    ).toHaveLength(0);

    await app.db.insert(memorySources).values({
      conversationId: earlier.conversationId,
      ownerId,
      agentId,
      processedThroughSequence: BigInt(earlier.throughSequence),
    });
    const [previousChat] = await app.db
      .select({ messageSequence: conversations.messageSequence })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!previousChat) throw new Error("Expected earlier chat conversation");
    await app.db.insert(memorySources).values({
      conversationId,
      ownerId,
      agentId,
      processedThroughSequence: previousChat.messageSequence,
    });
    const secondConversation = await createConversation();
    const third = await sendMessage(secondConversation, "Nothing new to extract");
    await waitForRun(third.json().run.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      await app.db.select().from(memoryUpdates).where(eq(memoryUpdates.ownerId, ownerId)),
    ).toHaveLength(0);
  });

  it("records provider creation failure without affecting the chat run", async () => {
    await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
    rejectExtractionCreation = true;
    const conversationId = await createConversation();
    const response = await sendMessage(conversationId, "Continue");
    await waitForRun(response.json().run.id);
    const update = await waitForUpdate(undefined, "failed");
    expect(update.errorCode).toBe("provider_failure");
    expect(runtime.destroySession).not.toHaveBeenCalled();
  });

  it.each([
    { name: "failed turn", status: "failed" as const, text: "{}", errorCode: "provider_failure" },
    {
      name: "invalid JSON",
      status: "succeeded" as const,
      text: "not JSON",
      errorCode: "invalid_output",
    },
    {
      name: "extra output key",
      status: "succeeded" as const,
      text: JSON.stringify({ profile: null, preferences: null, notes: null, extra: true }),
      errorCode: "invalid_output",
    },
    {
      name: "over-cap output",
      status: "succeeded" as const,
      text: JSON.stringify({ profile: "x".repeat(4001), preferences: null, notes: null }),
      errorCode: "output_too_long",
    },
  ])(
    "fails $name without applying memory or advancing sources",
    async ({ status, text, errorCode }) => {
      const earlier = await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
      extractionTurnStatus = status;
      extractionText = text;
      const conversationId = await createConversation();
      const response = await sendMessage(conversationId, "Continue");
      await waitForRun(response.json().run.id);
      const update = await waitForUpdate(undefined, "failed");
      expect(update.errorCode).toBe(errorCode);
      expect(
        await app.db.select().from(memoryDocuments).where(eq(memoryDocuments.ownerId, ownerId)),
      ).toHaveLength(0);
      expect(await app.db.select().from(memoryRevisions)).toHaveLength(0);
      expect(
        await app.db
          .select()
          .from(memorySources)
          .where(eq(memorySources.conversationId, earlier.conversationId)),
      ).toHaveLength(0);
      expect(runtime.destroySession).toHaveBeenCalled();
    },
  );

  it("cancels at the turn deadline and destroys the extraction session", async () => {
    await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
    extractionTurnStatus = null;
    const conversationId = await createConversation();
    const response = await sendMessage(conversationId, "Continue");
    await waitForRun(response.json().run.id);
    const update = await waitForUpdate(undefined, "failed");
    expect(update.errorCode).toBe("deadline_exceeded");
    expect(runtime.cancel).toHaveBeenCalledWith(
      { provider: runtime.name, externalId: expect.stringMatching(/^extract_/) },
      { apiKey: "dummy-user-key" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runtime.destroySession).toHaveBeenCalled();
  });

  it("applies non-conflicting documents when a user edits one during extraction", async () => {
    await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
    extractionText = JSON.stringify({
      profile: "- Extracted profile",
      preferences: null,
      notes: "- Project note",
    });
    holdExtractionCreation();
    const conversationId = await createConversation();
    const response = await sendMessage(conversationId, "Continue");
    await waitForRun(response.json().run.id);
    const running = await waitForUpdate(undefined, "running");
    await waitUntil(() =>
      runtime.createSession.mock.calls.some(([options]) => options.outputSchema),
    );
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/agents/${agentId}/memory/profile`,
          payload: { content: "- User profile", expectedVersion: 0 },
        })
      ).statusCode,
    ).toBe(200);
    extractionGate?.release();
    const finished = await waitForUpdate(running.id, "succeeded");
    expect(finished).toMatchObject({
      errorCode: "memory_changed",
      changed: [{ name: "notes", fromVersion: 0, toVersion: 1 }],
    });
    const docs = await app.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.ownerId, ownerId));
    expect(docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "profile", content: "- User profile" }),
        expect.objectContaining({ name: "notes", content: "- Project note" }),
      ]),
    );
    expect(
      await app.db.select().from(memorySources).where(eq(memorySources.ownerId, ownerId)),
    ).toHaveLength(0);
  });

  it("returns the running update for a concurrent refresh without starting another job", async () => {
    await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
    holdExtractionCreation();
    const first = await startManualRefresh();
    expect(first.statusCode).toBe(202);
    const running = first.json().update;
    await waitUntil(() =>
      runtime.createSession.mock.calls.some(([options]) => options.outputSchema),
    );
    const second = await startManualRefresh();
    expect(second.statusCode).toBe(200);
    expect(second.json().update).toMatchObject({ id: running.id, status: "running" });
    expect(
      runtime.createSession.mock.calls.filter(([options]) => options.outputSchema),
    ).toHaveLength(1);
    extractionGate?.release();
    await waitForUpdate(running.id, "succeeded");
  });

  it("sweeps an expired lease before starting a new update", async () => {
    await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
    const [expired] = await app.db
      .insert(memoryUpdates)
      .values({
        ownerId,
        agentId,
        trigger: "manual",
        status: "running",
        baseVersions: { profile: 0, preferences: 0, notes: 0 },
        sources: [],
        provider: runtime.name,
        leaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .returning();
    if (!expired) throw new Error("Expected expired update row");
    const response = await startManualRefresh();
    expect(response.statusCode).toBe(202);
    const [swept] = await app.db
      .select()
      .from(memoryUpdates)
      .where(eq(memoryUpdates.id, expired.id));
    expect(swept).toMatchObject({ status: "failed", errorCode: "worker_lost" });
    expect(swept?.finishedAt).toBeInstanceOf(Date);
    await waitForUpdate(response.json().update.id, "succeeded");
  });

  it("enforces the hourly limit for manual refresh and silently skips automatic work", async () => {
    const history = await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
    for (let index = 0; index < 10; index++) {
      await app.db.insert(memoryUpdates).values({
        ownerId,
        agentId,
        trigger: "auto",
        status: "succeeded",
        baseVersions: { profile: 0, preferences: 0, notes: 0 },
        sources: [],
        provider: runtime.name,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        finishedAt: new Date(),
      });
    }
    const refresh = await startManualRefresh();
    expect(refresh.statusCode).toBe(429);
    app.memoryUpdates.schedule(ownerId, agentId, randomUUID(), { apiKey: "dummy-user-key" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      await app.db.select().from(memoryUpdates).where(eq(memoryUpdates.ownerId, ownerId)),
    ).toHaveLength(10);
    expect(
      await app.db
        .select()
        .from(memorySources)
        .where(eq(memorySources.conversationId, history.conversationId)),
    ).toHaveLength(0);
    expect(
      runtime.createSession.mock.calls.filter(([options]) => options.outputSchema),
    ).toHaveLength(0);
  });

  it("forget during extraction fences writes and advances old conversation sources", async () => {
    const history = await addTranscript(agentId, [
      { role: "user", text: "Remembered before forget" },
    ]);
    holdExtractionCreation();
    const started = await startManualRefresh();
    expect(started.statusCode).toBe(202);
    await waitForUpdate(started.json().update.id, "running");
    await waitUntil(() =>
      runtime.createSession.mock.calls.some(([options]) => options.outputSchema),
    );
    expect((await app.inject({ method: "DELETE", url: "/memory" })).statusCode).toBe(204);
    extractionGate?.release();
    await waitUntil(() => runtime.destroySession.mock.calls.length === 1);
    expect(
      await app.db.select().from(memoryDocuments).where(eq(memoryDocuments.ownerId, ownerId)),
    ).toHaveLength(0);
    expect(await app.db.select().from(memoryRevisions)).toHaveLength(0);
    const [source] = await app.db
      .select()
      .from(memorySources)
      .where(eq(memorySources.conversationId, history.conversationId));
    expect(source?.processedThroughSequence).toBe(1n);
    const retry = await startManualRefresh();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ update: null });
  });

  it("filters transcript candidates, takes the three oldest, caps text, and resumes after the source cursor", async () => {
    const botB = await createBot(ownerId, "Other bot");
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await addTranscript(agentId, [{ role: "assistant", text: "commentary", phase: "commentary" }], {
      createdAt: new Date(base),
    });
    await addTranscript(agentId, [{ role: "user", text: "incomplete", status: "incomplete" }], {
      createdAt: new Date(base + 1),
    });
    await addTranscript(botB, [{ role: "user", text: "other bot" }], {
      createdAt: new Date(base + 2),
    });
    await addTranscript(agentId, [{ role: "user", text: "active" }], {
      createdAt: new Date(base + 3),
      active: true,
    });
    const first = await addTranscript(agentId, [{ role: "user", text: "oldest one" }], {
      createdAt: new Date(base + 4),
    });
    const second = await addTranscript(agentId, [{ role: "user", text: "oldest two" }], {
      createdAt: new Date(base + 5),
    });
    const third = await addTranscript(agentId, [{ role: "user", text: "oldest three" }], {
      createdAt: new Date(base + 6),
    });
    const fourth = await addTranscript(agentId, [{ role: "user", text: "oldest four" }], {
      createdAt: new Date(base + 7),
    });
    const firstBatch = await app.db.transaction((tx) => selectSources(tx, ownerId, agentId));
    expect(firstBatch.map((source) => source.conversationId)).toEqual([
      first.conversationId,
      second.conversationId,
      third.conversationId,
    ]);
    for (const source of [first, second, third, fourth]) {
      await app.db.insert(memorySources).values({
        conversationId: source.conversationId,
        ownerId,
        agentId,
        processedThroughSequence: BigInt(source.throughSequence),
      });
    }
    const cap = await addTranscript(
      agentId,
      [
        { role: "user", text: "O".repeat(30_005) },
        { role: "assistant", text: "N".repeat(30_005) },
      ],
      { createdAt: new Date(base + 8) },
    );
    const incremental = await addTranscript(
      agentId,
      [
        { role: "user", text: "already seen" },
        { role: "user", text: "new after cursor" },
      ],
      { createdAt: new Date(base + 9) },
    );
    await app.db.insert(memorySources).values({
      conversationId: incremental.conversationId,
      ownerId,
      agentId,
      processedThroughSequence: 1n,
    });
    const resumed = await app.db.transaction((tx) => selectSources(tx, ownerId, agentId));
    expect(resumed.map((source) => source.conversationId)).toEqual([
      cap.conversationId,
      incremental.conversationId,
    ]);
    expect(resumed[0]).toMatchObject({
      conversationId: cap.conversationId,
      throughSequence: "2",
      earlierMessagesOmitted: true,
      messages: [{ role: "assistant", text: "N".repeat(30_000) }],
    });
    expect(resumed[1]?.messages).toEqual([{ role: "user", text: "new after cursor" }]);
    const capped = resumed[0];
    if (!capped) throw new Error("Expected capped transcript");
    expect(
      extractorInput({
        bot: { name: "Memory bot", description: "" },
        memory: { profile: "", preferences: "", notes: "" },
        conversations: [capped],
      }),
    ).toContain('"earlier_messages_omitted":true');

    await app.db.insert(memorySources).values({
      conversationId: cap.conversationId,
      ownerId,
      agentId,
      processedThroughSequence: 2n,
    });
    await app.db
      .update(memorySources)
      .set({ processedThroughSequence: 2n })
      .where(eq(memorySources.conversationId, incremental.conversationId));
    const blank = await addTranscript(agentId, [{ role: "user", text: " \t" }], {
      createdAt: new Date(base + 10),
    });
    expect(await app.db.transaction((tx) => selectSources(tx, ownerId, agentId))).toHaveLength(0);
    const [advanced] = await app.db
      .select()
      .from(memorySources)
      .where(eq(memorySources.conversationId, blank.conversationId));
    expect(advanced?.processedThroughSequence).toBe(1n);
  });

  it("validates refresh routes, feature support, settings, and GET status shape", async () => {
    const otherAgent = await createBot("other-owner", "Foreign bot");
    const get = await app.inject({ method: "GET", url: `/agents/${agentId}/memory` });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      autoUpdate: true,
      lastUpdate: null,
      documents: expect.any(Array),
    });
    expect((await startManualRefresh(agentId, false)).statusCode).toBe(400);
    expect((await startManualRefresh(otherAgent)).statusCode).toBe(404);
    runtime.features.structuredOutput = false;
    expect((await startManualRefresh()).statusCode).toBe(409);
    runtime.features.structuredOutput = true;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/memory/settings",
          payload: { autoUpdate: false, extra: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/memory/settings",
          payload: { autoUpdate: false },
        })
      ).json(),
    ).toEqual({ autoUpdate: false });
  });

  it("marks a running update worker_lost on close without destroying its provider session", async () => {
    await addTranscript(agentId, [{ role: "user", text: "Earlier fact" }]);
    extractionTurnStatus = null;
    const started = await startManualRefresh();
    expect(started.statusCode).toBe(202);
    await waitUntil(() => runtime.listTurns.mock.calls.length > 0);
    const updateId = started.json().update.id as string;
    await app.close();
    appClosed = true;
    const verification = createDatabase(testDatabaseUrl);
    try {
      const [update] = await verification.db
        .select()
        .from(memoryUpdates)
        .where(eq(memoryUpdates.id, updateId));
      expect(update).toMatchObject({ status: "failed", errorCode: "worker_lost" });
      expect(runtime.destroySession).not.toHaveBeenCalled();
    } finally {
      await verification.close();
    }
  });
});
