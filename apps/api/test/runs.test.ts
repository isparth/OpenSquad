import { randomUUID } from "node:crypto";
import {
  type RuntimeEvent,
  type RuntimeMessage,
  type RuntimeTurn,
  type ToolConnection,
  ToolsError,
} from "@opensquad/core";
import {
  agents,
  conversationEvents,
  conversationMessages,
  conversationRuns,
  conversations,
  participants,
  runtimeSessions,
} from "@opensquad/db";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { runAdmission } from "../src/modules/conversations/admission.js";
import { runtimeStore } from "../src/modules/conversations/run-store.js";
import { executeRun } from "../src/modules/conversations/run-worker.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import { testDatabaseUrl } from "./database-url.js";
import { FakeRuntimeProvider, FakeToolsProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import { RuntimeQueue } from "./runtime-queue.js";

describe("runtime HTTP execution", () => {
  let app: App;
  let runtime: FakeRuntimeProvider;
  let tools: FakeToolsProvider;
  let queue: RuntimeQueue;
  let conversationId: string;
  let agentId: string;
  const headers = { "x-opensquad-runtime-key": "dummy-user-key" };
  const expectedAutoMemoryInstructions = `## Memory
Nothing is saved about this user yet. If the user asks you to remember or forget something, acknowledge it briefly. Saved memory is updated in the background after conversations and applies to later ones.`;
  const expectedHostedInstructions = `${expectedAutoMemoryInstructions}\n\nSave files the user should receive under /workspace/outputs.`;
  const session = {
    provider: "fake-runtime",
    externalId: "session-test",
    model: "gpt-6-luna",
    status: "idle" as const,
    environmentExternalId: null,
  };
  const root = (status: RuntimeTurn["status"]): RuntimeTurn => ({
    externalId: "root-test",
    subagentExternalId: null,
    status,
    usage: { inputTokens: 2, outputTokens: 3 },
    error: null,
  });
  const turn = (status: RuntimeTurn["status"], externalId = "root-test"): RuntimeEvent => ({
    externalId: randomUUID(),
    sessionExternalId: session.externalId,
    turnExternalId: externalId,
    type: "turn.status",
    turn: { ...root(status), externalId },
  });
  const savedMessage = (
    role: RuntimeMessage["role"],
    externalId: string,
    text: string,
  ): RuntimeMessage => ({
    externalId,
    turnExternalId: "root-test",
    role,
    status: "completed",
    phase: role === "assistant" ? "final" : null,
    content: [{ type: "text", text }],
  });
  beforeEach(async () => {
    runtime = new FakeRuntimeProvider();
    tools = new FakeToolsProvider();
    queue = new RuntimeQueue();
    runtime.createSession.mockResolvedValue(session);
    runtime.events.mockResolvedValue(queue);
    runtime.listTurns.mockImplementation(async function* () {
      yield* [];
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield* [];
    });
    app = await createTestApp({ capabilities: { runtime, tools } });
    agentId = (
      await agentsService(app.db).create({ ownerId: "dev-user", name: "HTTP runtime test" })
    ).id;
    conversationId = (await conversationsService(app.db).create("dev-user", agentId, null))
      .conversation.id;
  });
  afterEach(async () => {
    await app.close();
    const { createDatabase } = await import("@opensquad/db");
    const database = createDatabase(testDatabaseUrl);
    try {
      await database.db.delete(conversations).where(eq(conversations.id, conversationId));
      await database.db.delete(agents).where(eq(agents.id, agentId));
    } finally {
      await database.close();
    }
  });
  const send = (clientRequestId = randomUUID(), text = "Hello", extra = {}) =>
    app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      headers: { ...headers, ...extra },
      payload: { text, clientRequestId },
    });
  const toolsHeaders = { "x-opensquad-tools-key": "dummy-tools-key" };
  async function setSandboxEnabled(sandboxEnabled: boolean) {
    const response = await app.inject({
      method: "PATCH",
      url: `/agents/${agentId}`,
      payload: { sandboxEnabled },
    });
    expect(response.statusCode).toBe(200);
  }
  async function setToolGrants(toolGrants: { toolkit: string; access: "read" | "write" }[]) {
    const response = await app.inject({
      method: "PATCH",
      url: `/agents/${agentId}`,
      payload: { toolGrants },
    });
    expect(response.statusCode).toBe(200);
  }
  async function completeFirstTurn() {
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield savedMessage("user", "saved-user", "Hello");
      yield savedMessage("assistant", "saved-assistant", "First reply");
    });
    const first = await send();
    expect(first.statusCode).toBe(202);
    await waitStatus(first.json().run.id, "succeeded");
  }
  async function waitStatus(id: string, status: string) {
    await vi.waitFor(
      async () => {
        const [row] = await app.db
          .select()
          .from(conversationRuns)
          .where(eq(conversationRuns.id, id));
        expect(row?.status).toBe(status);
        expect(row?.active).toBe(false);
      },
      { timeout: 3000, interval: 20 },
    );
  }

  it("submits the first environmentless input during creation and persists streamed output", async () => {
    runtime.events.mockImplementationOnce(async () => {
      expect(runtime.createSession).toHaveBeenCalledOnce();
      queue.emit(turn("running"));
      queue.emit({
        externalId: "text-test",
        sessionExternalId: session.externalId,
        turnExternalId: "root-test",
        type: "message.text.completed",
        itemExternalId: "assistant-test",
        contentIndex: 0,
        text: "Hello back",
      });
      queue.emit(turn("succeeded"));
      return queue;
    });

    const response = await send();
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await waitStatus(id, "succeeded");
    expect(runtime.createSession.mock.calls[0]?.[0]).toEqual({
      instructions: expectedAutoMemoryInstructions,
      model: "gpt-6-luna",
      environment: "none",
      input: "Hello",
    });
    expect(runtime.createSession.mock.calls[0]?.[1]).toEqual({ apiKey: "dummy-user-key" });
    expect(runtime.createSession.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.events.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(runtime.sendInput).not.toHaveBeenCalled();
    const history = await app.inject({
      method: "GET",
      url: `/conversations/${conversationId}/messages`,
    });
    expect(history.json().items[1].content[0].text).toBe("Hello back");
    expect(queue.close).toHaveBeenCalled();
  });

  it("adopts a fast environmentless turn from saved turns and messages", async () => {
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield savedMessage("user", "saved-user", "Hello");
      yield savedMessage("assistant", "saved-assistant", "Fast reply");
    });

    const response = await send();
    expect(response.statusCode).toBe(202);
    await waitStatus(response.json().run.id, "succeeded");
    const history = (
      await app.inject({ method: "GET", url: `/conversations/${conversationId}/messages` })
    ).json().items;
    expect(
      history.map((message: { content: Array<{ text: string }> }) => message.content[0]?.text),
    ).toEqual(["Hello", "Fast reply"]);
    expect(runtime.sendInput).not.toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalled();
  });

  it("reuses an environmentless session for follow-up input", async () => {
    const queues: RuntimeQueue[] = [];
    runtime.events.mockImplementation(async () => {
      const next = new RuntimeQueue();
      queues.push(next);
      return next;
    });
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield savedMessage("user", "saved-user", "Hello");
      yield savedMessage("assistant", "saved-assistant", "First reply");
    });
    runtime.sendInput.mockImplementation(async (_ref, text) => {
      const activeQueue = queues[1];
      if (!activeQueue) throw new Error("Second subscription is missing");
      activeQueue.emit(turn("running", "second-turn"));
      activeQueue.emit({
        externalId: "second-text",
        sessionExternalId: session.externalId,
        turnExternalId: "second-turn",
        type: "message.text.completed",
        itemExternalId: "second-assistant",
        contentIndex: 0,
        text: `${text} received`,
      });
      activeQueue.emit(turn("succeeded", "second-turn"));
    });

    const first = await send();
    await waitStatus(first.json().run.id, "succeeded");
    const second = await send(randomUUID(), "Second message");
    expect(second.statusCode).toBe(202);
    await waitStatus(second.json().run.id, "succeeded");
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(runtime.sendInput).toHaveBeenCalledOnce();
    expect(runtime.sendInput.mock.calls[0]?.[0]).toEqual({
      provider: "fake-runtime",
      externalId: session.externalId,
    });
    expect(runtime.sendInput.mock.calls[0]?.[1]).toBe("Second message");
    expect(runtime.sendInput.mock.calls[0]?.[2]).toEqual({ apiKey: "dummy-user-key" });
  });

  it("keeps failed environmentless creation uncertain and idempotent", async () => {
    runtime.createSession.mockRejectedValue(new Error("private create diagnostic"));
    const clientRequestId = randomUUID();
    const first = await send(clientRequestId);
    expect(first.statusCode).toBe(202);
    const id = first.json().run.id;
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/runs/${id}` });
      expect(response.json().run.observation).toBe("reconciliation_required");
      expect(response.json().run.error.code).toBe("uncertain_mutation");
      expect(response.json().run.active).toBe(true);
    });
    const retry = await send(clientRequestId);
    expect(retry.json().run.id).toBe(id);
    expect(runtime.createSession).toHaveBeenCalledOnce();
  });

  it("keeps a successfully submitted environmentless run active when subscription fails", async () => {
    runtime.events.mockRejectedValue(new Error("private subscription detail"));
    const response = await send();
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await vi.waitFor(async () => {
      const run = (await app.inject({ method: "GET", url: `/runs/${id}` })).json().run;
      expect(run.active).toBe(true);
      expect(run.status).not.toBe("failed");
      expect(run.observation).toBe("reconciliation_required");
    });
    expect(runtime.createSession).toHaveBeenCalledOnce();
  });

  it("dispatches cancellation after an environmentless create when subscription fails", async () => {
    runtime.createSession.mockImplementation(async () => {
      await app.db
        .update(conversationRuns)
        .set({ cancelRequested: true })
        .where(eq(conversationRuns.conversationId, conversationId));
      return session;
    });
    runtime.events.mockRejectedValue(new Error("private subscription detail"));
    runtime.cancel.mockResolvedValue(undefined);

    const response = await send();
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await vi.waitFor(async () => {
      const [row] = await app.db.select().from(conversationRuns).where(eq(conversationRuns.id, id));
      expect(row?.observation).toBe("reconciliation_required");
      expect(row?.cancelDispatched).toBe(true);
      expect(row?.active).toBe(true);
      expect(row?.status).not.toBe("failed");
    });
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(runtime.cancel.mock.calls[0]?.[0]).toEqual({
      provider: session.provider,
      externalId: session.externalId,
    });
    expect(runtime.cancel.mock.calls[0]?.[1]).toEqual({ apiKey: "dummy-user-key" });
    expect(runtime.sendInput).not.toHaveBeenCalled();
  });

  it("recovers an environmentless run from saved messages and turns without resending input", async () => {
    runtime.events.mockImplementationOnce(async () => {
      queue.fail(new Error("Disconnect"));
      return queue;
    });
    const response = await send();
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await vi.waitFor(async () => {
      const [row] = await app.db.select().from(conversationRuns).where(eq(conversationRuns.id, id));
      expect(row?.active).toBe(true);
      expect(row?.observation).toBe("reconciliation_required");
    });

    runtime.events.mockResolvedValueOnce(new RuntimeQueue());
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield savedMessage("user", "saved-user", "Hello");
      yield savedMessage("assistant", "saved-assistant", "Recovered environmentless reply");
    });
    const reconcile = await app.inject({
      method: "POST",
      url: `/runs/${id}/reconcile`,
      headers,
    });
    expect(reconcile.statusCode).toBe(202);
    await waitStatus(id, "succeeded");
    const history = (
      await app.inject({ method: "GET", url: `/conversations/${conversationId}/messages` })
    ).json().items;
    expect(
      history.map((message: { content: Array<{ text: string }> }) => message.content[0]?.text),
    ).toEqual(["Hello", "Recovered environmentless reply"]);
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(runtime.sendInput).not.toHaveBeenCalled();
  });

  it("creates hosted sessions without initial input and sends after subscribing", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(turn("running"));
      queue.emit({
        externalId: "hosted-text",
        sessionExternalId: session.externalId,
        turnExternalId: "root-test",
        type: "message.text.completed",
        itemExternalId: "hosted-assistant",
        contentIndex: 0,
        text: "Hosted reply",
      });
      queue.emit(turn("succeeded"));
    });
    const response = await send();
    expect(response.statusCode).toBe(202);
    await waitStatus(response.json().run.id, "succeeded");
    expect(runtime.createSession.mock.calls[0]?.[0]).toEqual({
      instructions: expectedHostedInstructions,
      model: "gpt-6-luna",
      environment: "hosted",
    });
    expect(runtime.sendInput.mock.calls[0]?.[1]).toBe("Hello");
    expect(runtime.sendInput.mock.invocationCallOrder[0]).toBeGreaterThan(
      runtime.events.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("persists command messages in order with commentary and final assistant messages", async () => {
    await setSandboxEnabled(true);
    const cappedOutput = `${"a".repeat(8_000)}\n… output truncated …\n${"b".repeat(8_000)}`;
    const commandPart = {
      type: "command" as const,
      command: "/bin/bash -lc \"printf 'hi'\"",
      cwd: "/workspace",
      exitCode: 0,
      durationMs: 400,
      output: cappedOutput,
      outputTruncated: true,
    };
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(turn("running"));
      queue.emit({
        type: "message.completed",
        externalId: "command-added-event",
        sessionExternalId: session.externalId,
        turnExternalId: "root-test",
        message: {
          externalId: "exec_123",
          turnExternalId: "root-test",
          role: "assistant",
          status: "running",
          phase: null,
          content: [commandPart],
        },
      });
      queue.emit({
        type: "message.completed",
        externalId: "command-done-event",
        sessionExternalId: session.externalId,
        turnExternalId: "root-test",
        message: {
          externalId: "exec_123",
          turnExternalId: "root-test",
          role: "assistant",
          status: "completed",
          phase: null,
          content: [commandPart],
        },
      });
      queue.emit({
        type: "message.completed",
        externalId: "commentary-event",
        sessionExternalId: session.externalId,
        turnExternalId: "root-test",
        message: {
          externalId: "commentary_123",
          turnExternalId: "root-test",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "text", text: "I am checking the file." }],
        },
      });
      queue.emit({
        type: "message.completed",
        externalId: "final-event",
        sessionExternalId: session.externalId,
        turnExternalId: "root-test",
        message: {
          externalId: "final_123",
          turnExternalId: "root-test",
          role: "assistant",
          status: "completed",
          phase: "final",
          content: [{ type: "text", text: "The file contains hi." }],
        },
      });
      queue.emit(turn("succeeded"));
    });

    const response = await send();
    expect(response.statusCode).toBe(202);
    await waitStatus(response.json().run.id, "succeeded");
    const history = (
      await app.inject({ method: "GET", url: `/conversations/${conversationId}/messages` })
    ).json().items;
    const assistant = history.filter((message: { role: string }) => message.role === "assistant");
    expect(
      assistant.map((message: { content: Array<{ type: string }> }) => message.content[0]?.type),
    ).toEqual(["command", "text", "text"]);
    expect(assistant.map((message: { sequence: string }) => message.sequence)).toEqual([
      "2",
      "3",
      "4",
    ]);
    expect(assistant[0]?.content[0]).toMatchObject({ ...commandPart, index: 0, completed: true });
    expect(assistant[1]).toMatchObject({ phase: "commentary" });
    expect(assistant[2]).toMatchObject({ phase: "final" });

    const productEvents = await app.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversationId))
      .orderBy(asc(conversationEvents.sequence));
    const commandEvents = productEvents.filter((event) => {
      const payload = event.payload as { message?: { content?: Array<{ type?: string }> } };
      return payload.message?.content?.some((part) => part.type === "command");
    });
    expect(commandEvents.map((event) => event.type)).toEqual([
      "message.created",
      "message.completed",
      "message.completed",
    ]);
  });

  it("applies and deduplicates environment events before the root turn is known", async () => {
    await setSandboxEnabled(true);
    const readyEvent: RuntimeEvent = {
      type: "environment.status",
      externalId: "environment-ready-event",
      sessionExternalId: session.externalId,
      turnExternalId: null,
      status: "ready",
    };
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(readyEvent);
      queue.emit(readyEvent);
      queue.emit({ ...readyEvent, externalId: "environment-connected-event", status: "connected" });
      queue.emit(turn("running"));
      queue.emit(turn("succeeded"));
    });

    const response = await send();
    expect(response.statusCode).toBe(202);
    await waitStatus(response.json().run.id, "succeeded");
    const [savedSession] = await app.db
      .select()
      .from(runtimeSessions)
      .where(eq(runtimeSessions.conversationId, conversationId));
    expect(savedSession?.environmentStatus).toBe("connected");

    const events = await app.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversationId))
      .orderBy(asc(conversationEvents.sequence));
    const environmentEvents = events.filter((event) => event.type === "environment.updated");
    expect(environmentEvents.map((event) => event.payload.status)).toEqual(["ready", "connected"]);
    const rootRunning = events.find((event) => {
      if (event.type !== "run.updated") return false;
      const payload = event.payload as { run?: { status?: string } };
      return payload.run?.status === "running";
    });
    expect(environmentEvents[0]?.sequence).toBeLessThan(rootRunning?.sequence ?? 0n);
  });

  it("snapshots hosted, environmentless, and absent runtime environments", async () => {
    const service = conversationsService(app.db);
    expect((await service.snapshot("dev-user", conversationId)).snapshot.environment).toBeNull();
    const [agentParticipant] = await app.db
      .select()
      .from(participants)
      .where(and(eq(participants.conversationId, conversationId), eq(participants.kind, "agent")));
    if (!agentParticipant) throw new Error("Expected an agent participant");
    const [runtimeSession] = await app.db
      .insert(runtimeSessions)
      .values({
        conversationId,
        agentParticipantId: agentParticipant.id,
        provider: runtime.name,
        externalId: `snapshot-${randomUUID()}`,
        instructions: "",
        memorySnapshot: "",
        model: "gpt-6-luna",
        environment: "hosted",
        environmentStatus: "ready",
      })
      .returning();
    if (!runtimeSession) throw new Error("Expected a runtime session");
    expect((await service.snapshot("dev-user", conversationId)).snapshot.environment).toEqual({
      type: "hosted",
      status: "ready",
    });
    await app.db
      .update(runtimeSessions)
      .set({ environment: "none", environmentStatus: null })
      .where(eq(runtimeSessions.id, runtimeSession.id));
    expect((await service.snapshot("dev-user", conversationId)).snapshot.environment).toEqual({
      type: "none",
      status: null,
    });
  });

  it("rejects sandbox drift after a completed environmentless conversation", async () => {
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield savedMessage("user", "saved-user", "Hello");
      yield savedMessage("assistant", "saved-assistant", "First reply");
    });
    const first = await send();
    await waitStatus(first.json().run.id, "succeeded");
    await setSandboxEnabled(true);

    const response = await send();
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe(
      "Bot or runtime settings changed; start a new conversation",
    );
    expect(
      await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.conversationId, conversationId)),
    ).toHaveLength(1);
  });

  it("snapshots no tool grants and rejects older conversations after grants change", async () => {
    await completeFirstTurn();
    const [snapshot] = await app.db
      .select()
      .from(runtimeSessions)
      .where(eq(runtimeSessions.conversationId, conversationId));
    expect(snapshot?.toolGrants).toEqual([]);
    await setToolGrants([{ toolkit: "github", access: "read" }]);

    const response = await send();
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe(
      "Bot or runtime settings changed; start a new conversation",
    );
    expect(
      await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.conversationId, conversationId)),
    ).toHaveLength(1);
  });

  async function expectNothingAdmitted() {
    for (const table of [runtimeSessions, conversationRuns, conversationMessages])
      expect(
        await app.db.select().from(table).where(eq(table.conversationId, conversationId)),
      ).toHaveLength(0);
  }

  it("requires the tools key before starting a conversation with a bot that has apps", async () => {
    runtime.features.mcp = true;
    await setToolGrants([{ toolkit: "github", access: "read" }]);

    const response = await send();
    expect(response.statusCode).toBe(428);
    expect(response.json().message).toBe("Add your Composio key in Tools to use this bot's apps");
    await expectNothingAdmitted();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(tools.listConnections).not.toHaveBeenCalled();
  });

  it("refuses apps on a runtime without MCP support before checking the tools key", async () => {
    await setToolGrants([{ toolkit: "github", access: "read" }]);

    const response = await send(randomUUID(), "Hello", toolsHeaders);
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe("This runtime does not support apps");
    await expectNothingAdmitted();
  });

  it("admits a conversation with apps when the tools key is present", async () => {
    runtime.features.mcp = true;
    await setToolGrants([{ toolkit: "github", access: "read" }]);

    const response = await send(randomUUID(), "Hello", toolsHeaders);
    expect(response.statusCode).toBe(202);
    const [snapshot] = await app.db
      .select()
      .from(runtimeSessions)
      .where(eq(runtimeSessions.conversationId, conversationId));
    expect(snapshot?.toolGrants).toEqual([{ toolkit: "github", access: "read" }]);
  });

  it("requires the tools key while an existing session with apps has no provider reference", async () => {
    runtime.features.mcp = true;
    await setToolGrants([{ toolkit: "github", access: "read" }]);
    const [agentMember] = await app.db
      .select()
      .from(participants)
      .where(and(eq(participants.conversationId, conversationId), eq(participants.kind, "agent")));
    await app.db.insert(runtimeSessions).values({
      conversationId,
      agentParticipantId: agentMember?.id as string,
      provider: "fake-runtime",
      model: "gpt-6-luna",
      instructions: "",
      environment: "none",
      toolGrants: [{ toolkit: "github", access: "read" }],
    });

    const response = await send();
    expect(response.statusCode).toBe(428);
    expect(
      await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.conversationId, conversationId)),
    ).toHaveLength(0);
  });

  it("does not require the tools key for follow-up turns once the session exists", async () => {
    await completeFirstTurn();
    await app.db
      .update(runtimeSessions)
      .set({
        toolGrants: [
          { toolkit: "gmail", access: "write" },
          { toolkit: "github", access: "read" },
        ],
      })
      .where(eq(runtimeSessions.conversationId, conversationId));
    await setToolGrants([
      { toolkit: "github", access: "read" },
      { toolkit: "gmail", access: "write" },
    ]);
    const queues: RuntimeQueue[] = [];
    runtime.events.mockImplementation(async () => {
      const next = new RuntimeQueue();
      queues.push(next);
      return next;
    });
    runtime.sendInput.mockImplementation(async () => {
      const activeQueue = queues[0];
      if (!activeQueue) throw new Error("Subscription is missing");
      activeQueue.emit(turn("running", "followup-turn"));
      activeQueue.emit(turn("succeeded", "followup-turn"));
    });

    const followup = await send(randomUUID(), "Second message");
    expect(followup.statusCode).toBe(202);
    await waitStatus(followup.json().run.id, "succeeded");
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(runtime.sendInput.mock.calls[0]?.[2]).toEqual({ apiKey: "dummy-user-key" });
    expect(tools.listConnections).not.toHaveBeenCalled();
    expect(tools.createSession).not.toHaveBeenCalled();
  });

  it("ignores the tools key for bots without apps", async () => {
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield savedMessage("user", "saved-user", "Hello");
      yield savedMessage("assistant", "saved-assistant", "Reply");
    });

    const response = await send(randomUUID(), "Hello", toolsHeaders);
    expect(response.statusCode).toBe(202);
    await waitStatus(response.json().run.id, "succeeded");
    expect(runtime.createSession.mock.calls[0]?.[0]).toEqual({
      instructions: expectedAutoMemoryInstructions,
      model: "gpt-6-luna",
      environment: "none",
      input: "Hello",
    });
    expect(runtime.createSession.mock.calls[0]?.[1]).toEqual({ apiKey: "dummy-user-key" });
    expect(tools.listConnections).not.toHaveBeenCalled();
    expect(tools.createSession).not.toHaveBeenCalled();
  });

  const connection = (id: string, toolkit: string, status: ToolConnection["status"]) => ({
    id,
    toolkit,
    status,
    createdAt: "2026-09-20T00:00:00.000Z",
  });
  const toolSession = {
    externalId: "tool-session-test",
    mcpServer: {
      name: "composio",
      url: "https://backend.composio.dev/tool_router/test/mcp",
      allowedTools: ["COMPOSIO_SEARCH_TOOLS"],
    },
    mcpHeaders: { "x-api-key": "dummy-tools-key" },
  };
  async function enableApps() {
    runtime.features.mcp = true;
    await setToolGrants([
      { toolkit: "gmail", access: "write" },
      { toolkit: "github", access: "read" },
    ]);
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield savedMessage("user", "saved-user", "Hello");
      yield savedMessage("assistant", "saved-assistant", "Reply");
    });
  }
  function connectApps() {
    tools.listConnections.mockResolvedValue([
      connection("github-old", "github", "attention"),
      connection("github-active", "github", "active"),
      connection("gmail-pending", "gmail", "pending"),
      connection("gmail-active", "gmail", "active"),
      connection("slack-active", "slack", "active"),
    ]);
    tools.createSession.mockResolvedValue(toolSession);
  }
  async function sessionRow() {
    const [row] = await app.db
      .select()
      .from(runtimeSessions)
      .where(eq(runtimeSessions.conversationId, conversationId));
    return row;
  }

  it("creates a tool session before the runtime session and wires it as an MCP server", async () => {
    await enableApps();
    connectApps();
    let toolsReferenceAtCreate: string | null | undefined;
    runtime.createSession.mockImplementationOnce(async () => {
      toolsReferenceAtCreate = (await sessionRow())?.toolsExternalId;
      return session;
    });

    const response = await send(randomUUID(), "Hello", toolsHeaders);
    expect(response.statusCode).toBe(202);
    await waitStatus(response.json().run.id, "succeeded");
    expect(toolsReferenceAtCreate).toBe("tool-session-test");
    expect(tools.listConnections).toHaveBeenCalledOnce();
    expect(tools.listConnections.mock.calls[0]?.slice(0, 2)).toEqual([
      { apiKey: "dummy-tools-key" },
      "dev-user",
    ]);
    expect(tools.createSession.mock.calls[0]?.slice(0, 3)).toEqual([
      { apiKey: "dummy-tools-key" },
      "dev-user",
      [
        { toolkit: "github", access: "read", connectionId: "github-active" },
        { toolkit: "gmail", access: "write", connectionId: "gmail-active" },
      ],
    ]);
    expect(runtime.createSession.mock.calls[0]?.[0]).toEqual({
      instructions: expectedAutoMemoryInstructions,
      model: "gpt-6-luna",
      environment: "none",
      input: "Hello",
      mcpServers: [toolSession.mcpServer],
    });
    expect(runtime.createSession.mock.calls[0]?.[1]).toEqual({
      apiKey: "dummy-user-key",
      mcp: { composio: { headers: { "x-api-key": "dummy-tools-key" } } },
    });
    const signal = runtime.createSession.mock.calls[0]?.[2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(tools.listConnections.mock.calls[0]?.[2]?.signal).toBe(signal);
    expect(tools.createSession.mock.calls[0]?.[3]?.signal).toBe(signal);
    expect(tools.createSession.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.createSession.mock.invocationCallOrder[0] ?? 0,
    );
    for (const call of [...runtime.events.mock.calls, ...runtime.listTurns.mock.calls])
      expect(call[1]).toEqual({ apiKey: "dummy-user-key" });
    expect((await sessionRow())?.toolsExternalId).toBe("tool-session-test");

    const queues: RuntimeQueue[] = [];
    runtime.events.mockImplementation(async () => {
      const next = new RuntimeQueue();
      queues.push(next);
      return next;
    });
    runtime.sendInput.mockImplementation(async () => {
      queues[0]?.emit(turn("running", "followup-turn"));
      queues[0]?.emit(turn("succeeded", "followup-turn"));
    });
    const followup = await send(randomUUID(), "Second message");
    expect(followup.statusCode).toBe(202);
    await waitStatus(followup.json().run.id, "succeeded");
    expect(tools.listConnections).toHaveBeenCalledOnce();
    expect(tools.createSession).toHaveBeenCalledOnce();
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(runtime.sendInput.mock.calls[0]?.[2]).toEqual({ apiKey: "dummy-user-key" });

    const persisted = JSON.stringify(
      [
        await sessionRow(),
        ...(await Promise.all(
          [conversationRuns, conversationEvents, conversationMessages].map((table) =>
            app.db.select().from(table).where(eq(table.conversationId, conversationId)),
          ),
        )),
      ],
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(persisted).not.toContain("dummy-tools-key");
    const reads = JSON.stringify(
      await Promise.all(
        [
          `/runs/${response.json().run.id}`,
          `/conversations/${conversationId}`,
          `/conversations/${conversationId}/messages`,
        ].map(async (url) => (await app.inject({ method: "GET", url })).json()),
      ),
    );
    const events = JSON.stringify(
      await conversationsService(app.db).events("dev-user", conversationId, 0n),
    );
    for (const serialized of [reads, events]) {
      expect(serialized).not.toContain("dummy-tools-key");
      expect(serialized).not.toContain("tool-session-test");
    }
  });

  it.each([
    [
      "tools_not_connected",
      () =>
        tools.listConnections.mockResolvedValue([
          connection("github-old", "github", "attention"),
          connection("gmail-active", "gmail", "active"),
        ]),
    ],
    [
      "tools_multiple_accounts",
      () =>
        tools.listConnections.mockResolvedValue([
          connection("github-a", "github", "active"),
          connection("github-b", "github", "active"),
          connection("gmail-active", "gmail", "active"),
        ]),
    ],
    [
      "tools_key_rejected",
      () => tools.listConnections.mockRejectedValue(new ToolsError("unauthorized", "Rejected")),
    ],
    [
      "tools_policy_mismatch",
      () => {
        connectApps();
        tools.createSession.mockRejectedValue(new ToolsError("policy_mismatch", "Mismatch"));
      },
    ],
    [
      "tools_unavailable",
      () => {
        connectApps();
        tools.createSession.mockRejectedValue(new ToolsError("unavailable", "Unavailable"));
      },
    ],
    [
      "tools_unavailable",
      () => {
        connectApps();
        tools.createSession.mockRejectedValue(new ToolsError("rate_limited", "Limited"));
      },
    ],
  ])("fails cleanly with %s without calling the runtime, then retries", async (code, setup) => {
    await enableApps();
    setup();

    const response = await send(randomUUID(), "Hello", toolsHeaders);
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await waitStatus(id, "failed");
    const run = (await app.inject({ method: "GET", url: `/runs/${id}` })).json().run;
    expect(run.error.code).toBe(code);
    expect(run.error.message).toMatch(/Tools|Composio|app/);
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect((await sessionRow())?.toolsExternalId).toBeNull();
    const [row] = await app.db.select().from(conversationRuns).where(eq(conversationRuns.id, id));
    expect(row?.observation).toBe("disconnected");
    expect(row?.mutationInFlight).toBe(false);

    tools.listConnections.mockReset();
    tools.createSession.mockReset();
    connectApps();
    runtime.createSession.mockResolvedValue(session);
    const retry = await send(randomUUID(), "Hello", toolsHeaders);
    expect(retry.statusCode).toBe(202);
    await waitStatus(retry.json().run.id, "succeeded");
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect((await sessionRow())?.toolsExternalId).toBe("tool-session-test");
  });

  async function runWorker(
    signal = new AbortController().signal,
    toolsCredentials?: { apiKey: string },
    beforeExecute?: (runId: string) => void,
  ) {
    const admitted = await runAdmission(app.db, {
      provider: runtime.name,
      model: "gpt-6-luna",
      features: runtime.features,
    })("dev-user", conversationId, { text: "Hello", clientRequestId: randomUUID() }, true);
    const token = await runtimeStore(app.db).claim("dev-user", admitted.run.id);
    beforeExecute?.(admitted.run.id);
    await executeRun({
      db: app.db,
      runtime,
      tools,
      ownerId: "dev-user",
      runId: admitted.run.id,
      token: token as string,
      credentials: { apiKey: "dummy-user-key" },
      ...(toolsCredentials ? { toolsCredentials } : {}),
      signal,
      mode: "execute",
    });
    const [row] = await app.db
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, admitted.run.id));
    return row;
  }

  it("fails with tools_key_required when the worker has no tools key", async () => {
    await enableApps();
    const row = await runWorker();
    const run = (await app.inject({ method: "GET", url: `/runs/${row?.id}` })).json().run;
    expect(run.status).toBe("failed");
    expect(run.active).toBe(false);
    expect(run.error).toEqual({
      code: "tools_key_required",
      message: "Add your Composio key in Tools, then send again.",
    });
    expect(tools.listConnections).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it.each([
    ["environmentless", false],
    ["hosted", true],
  ])("cancels atomically just before creating the %s session", async (_kind, sandbox) => {
    await setSandboxEnabled(sandbox);
    const transaction = app.db.transaction.bind(app.db);
    const row = await runWorker(undefined, undefined, (runId) => {
      let calls = 0;
      vi.spyOn(app.db, "transaction").mockImplementation(async (...args) => {
        // The worker's first transaction reads the run; the second is the creating pre-check.
        if (++calls === 2)
          await app.db
            .update(conversationRuns)
            .set({ cancelRequested: true })
            .where(eq(conversationRuns.id, runId));
        return transaction(...args);
      });
    });
    vi.mocked(app.db.transaction).mockRestore();
    expect(row?.status).toBe("cancelled");
    expect(row?.active).toBe(false);
    expect(row?.errorCode).toBeNull();
    expect(row?.mutationInFlight).toBe(false);
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.sendInput).not.toHaveBeenCalled();
  });

  it("stops before creating the runtime session when cancelled during tool setup", async () => {
    await enableApps();
    connectApps();
    let release: (value: typeof toolSession) => void = () => {};
    tools.createSession.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const response = await send(randomUUID(), "Hello", toolsHeaders);
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await vi.waitFor(() => expect(tools.createSession).toHaveBeenCalled());
    expect(
      (await app.inject({ method: "POST", url: `/runs/${id}/cancel`, headers })).statusCode,
    ).toBe(202);
    release(toolSession);
    await waitStatus(id, "cancelled");
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("keeps a tools failure when shutdown aborts the worker at the same time", async () => {
    await enableApps();
    const controller = new AbortController();
    controller.abort();

    const row = await runWorker(controller.signal);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("tools_key_required");
    expect(row?.active).toBe(false);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("treats an abort during tool setup as a lost worker, not a tools failure", async () => {
    await enableApps();
    const controller = new AbortController();
    tools.listConnections.mockImplementation(async () => {
      controller.abort();
      throw new Error("Aborted");
    });

    const row = await runWorker(controller.signal, { apiKey: "dummy-tools-key" });
    expect(row?.status).not.toBe("failed");
    expect(row?.errorCode).toBe("worker_lost");
    expect(row?.active).toBe(true);
    expect(row?.observation).toBe("reconciliation_required");
    expect(tools.createSession).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("checks the abort signal before listing connections", async () => {
    await enableApps();
    const controller = new AbortController();
    controller.abort();

    const row = await runWorker(controller.signal, { apiKey: "dummy-tools-key" });
    expect(row?.errorCode).toBe("worker_lost");
    expect(tools.listConnections).not.toHaveBeenCalled();
  });

  it("does not report missing connections found after an abort as a tools failure", async () => {
    await enableApps();
    const controller = new AbortController();
    tools.listConnections.mockImplementation(async () => {
      controller.abort();
      return [];
    });

    const row = await runWorker(controller.signal, { apiKey: "dummy-tools-key" });
    expect(row?.status).not.toBe("failed");
    expect(row?.errorCode).toBe("worker_lost");
  });

  it("checks the abort signal between listing connections and creating the tool session", async () => {
    await enableApps();
    const controller = new AbortController();
    tools.listConnections.mockImplementation(async () => {
      controller.abort();
      return [
        connection("github-active", "github", "active"),
        connection("gmail-active", "gmail", "active"),
      ];
    });

    const row = await runWorker(controller.signal, { apiKey: "dummy-tools-key" });
    expect(row?.errorCode).toBe("worker_lost");
    expect(tools.createSession).not.toHaveBeenCalled();
  });

  it.each([
    ["an unexpected tools error", () => tools.listConnections.mockRejectedValue(new Error("Bug"))],
    [
      "a failed tool session write",
      () => {
        connectApps();
        tools.createSession.mockResolvedValue({ ...toolSession, externalId: "bad\u0000id" });
      },
    ],
  ])("does not report %s as a tools problem", async (_case, setup) => {
    await enableApps();
    setup();

    const row = await runWorker(undefined, { apiKey: "dummy-tools-key" });
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("provider_failure");
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("reports hosted session drift before checking support for the new environment", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(turn("running"));
      queue.emit(turn("succeeded"));
    });
    const first = await send();
    expect(first.statusCode).toBe(202);
    await waitStatus(first.json().run.id, "succeeded");

    await setSandboxEnabled(false);
    runtime.features.environmentless = false;
    const followup = await send();
    expect(followup.statusCode).toBe(409);
    expect(followup.json().message).toBe(
      "Bot or runtime settings changed; start a new conversation",
    );
    expect(
      await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.conversationId, conversationId)),
    ).toHaveLength(1);
  });

  it("does not gate follow-up input to an existing environmentless session", async () => {
    const queues: RuntimeQueue[] = [];
    runtime.events.mockImplementation(async () => {
      const next = new RuntimeQueue();
      queues.push(next);
      return next;
    });
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield savedMessage("user", "saved-user", "Hello");
      yield savedMessage("assistant", "saved-assistant", "First reply");
    });
    runtime.sendInput.mockImplementation(async (_ref, _text) => {
      const activeQueue = queues[1];
      if (!activeQueue) throw new Error("Second subscription is missing");
      activeQueue.emit(turn("running", "followup-turn"));
      activeQueue.emit(turn("succeeded", "followup-turn"));
    });

    const first = await send();
    expect(first.statusCode).toBe(202);
    await waitStatus(first.json().run.id, "succeeded");
    runtime.features.environmentless = false;

    const followup = await send(randomUUID(), "Second message");
    expect(followup.statusCode).toBe(202);
    await waitStatus(followup.json().run.id, "succeeded");
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(runtime.sendInput).toHaveBeenCalledOnce();
    expect(runtime.sendInput.mock.calls[0]?.[1]).toBe("Second message");
  });

  it("gates environment choices against runtime features before creating a run", async () => {
    runtime.features.environmentless = false;
    const withoutEnvironment = await send();
    expect(withoutEnvironment.statusCode).toBe(409);
    expect(withoutEnvironment.json().message).toBe(
      "This runtime requires a sandbox; turn on the bot's sandbox",
    );
    expect(
      await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.conversationId, conversationId)),
    ).toHaveLength(0);

    await setSandboxEnabled(true);
    runtime.features.hostedEnvironment = false;
    const withoutSandbox = await send();
    expect(withoutSandbox.statusCode).toBe(409);
    expect(withoutSandbox.json().message).toBe(
      "This runtime does not support sandboxes; turn off the bot's sandbox",
    );
    expect(
      await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.conversationId, conversationId)),
    ).toHaveLength(0);
  });

  it("rejects missing credentials before admitting a run", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      payload: { text: "Hello", clientRequestId: randomUUID() },
    });
    expect(response.statusCode).toBe(400);
    expect(
      await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.conversationId, conversationId)),
    ).toHaveLength(0);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("subscribes before sending and persists the root outcome and complete text", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockImplementation(async () => {
      expect(runtime.events).toHaveBeenCalledOnce();
      queue.emit(turn("running"));
      queue.emit({
        externalId: "text-test",
        sessionExternalId: session.externalId,
        turnExternalId: "root-test",
        type: "message.text.completed",
        itemExternalId: "assistant-test",
        contentIndex: 0,
        text: "Hello back",
      });
      queue.emit(turn("succeeded"));
    });
    const response = await send();
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await waitStatus(id, "succeeded");
    const history = await app.inject({
      method: "GET",
      url: `/conversations/${conversationId}/messages`,
    });
    expect(history.json().items).toHaveLength(2);
    expect(history.json().items[1].content[0].text).toBe("Hello back");
    expect(history.json().items[1].status).toBe("completed");
    expect(runtime.createSession.mock.calls[0]?.[1]).toEqual({ apiKey: "dummy-user-key" });
    expect(queue.close).toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
    const runResponse = await app.inject({ method: "GET", url: `/runs/${id}` });
    expect(runResponse.body).not.toContain("dummy-user-key");
    expect(runResponse.body).not.toContain("session-test");
  });

  it("does not send again after an ambiguous submission failure and closes the subscription", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockRejectedValue(new Error("private-provider-diagnostic"));
    const clientRequestId = randomUUID();
    const first = await send(clientRequestId);
    expect(first.statusCode).toBe(202);
    const id = first.json().run.id;
    await vi.waitFor(() => expect(queue.close).toHaveBeenCalled());
    const retry = await send(clientRequestId);
    expect(retry.json().run.id).toBe(id);
    expect(runtime.sendInput).toHaveBeenCalledOnce();
    const row = (await app.inject({ method: "GET", url: `/runs/${id}` })).json().run;
    expect(row.active).toBe(true);
    expect(row.observation).toBe("reconciliation_required");
    expect(JSON.stringify(row)).not.toContain("private-provider-diagnostic");
  });

  it("fails before submission if subscription establishment fails", async () => {
    await setSandboxEnabled(true);
    runtime.events.mockRejectedValue(new Error("private subscription detail"));
    const response = await send();
    expect(response.statusCode).toBe(202);
    await waitStatus(response.json().run.id, "failed");
    expect(runtime.sendInput).not.toHaveBeenCalled();
  });

  it("requests cancellation at the persisted deadline", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(turn("running"));
    });
    runtime.cancel.mockImplementation(async () => {
      queue.emit(turn("cancelled"));
    });
    const response = await send();
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await vi.waitFor(() => expect(runtime.sendInput).toHaveBeenCalled());
    await app.db
      .update(conversationRuns)
      .set({ deadlineAt: new Date(0) })
      .where(eq(conversationRuns.id, id));
    await waitStatus(id, "cancelled");
    expect(runtime.cancel).toHaveBeenCalledOnce();
  });

  it("requests a stop when live output exceeds the supported buffer limit", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(turn("running"));
      queue.emit({
        type: "message.delta",
        externalId: randomUUID(),
        sessionExternalId: session.externalId,
        turnExternalId: "root-test",
        itemExternalId: "large-item",
        contentIndex: 0,
        text: "x".repeat(1_000_001),
      });
    });
    runtime.cancel.mockResolvedValue(undefined);
    expect((await send()).statusCode).toBe(202);
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledOnce());
    expect(runtime.destroySession).not.toHaveBeenCalled();
  });

  it("blocks bot deletion while a run is unresolved", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(turn("running"));
    });
    const response = await send();
    expect(response.statusCode).toBe(202);
    const deleted = await app.inject({ method: "DELETE", url: `/agents/${agentId}` });
    expect(deleted.statusCode).toBe(409);
    expect(await agentsService(app.db).get("dev-user", agentId)).not.toBeNull();
  });

  it("cancels explicitly without equating the request with a confirmed outcome", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(turn("running"));
    });
    runtime.cancel.mockImplementation(async () => {
      queue.emit(turn("cancelled"));
    });
    const response = await send();
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await vi.waitFor(() => expect(runtime.sendInput).toHaveBeenCalled());
    expect(
      (await app.inject({ method: "POST", url: `/runs/${id}/cancel`, headers })).statusCode,
    ).toBe(202);
    await waitStatus(id, "cancelled");
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(runtime.destroySession).not.toHaveBeenCalled();
  });

  it("recovers a disconnected run from saved messages and turns without resending input", async () => {
    await setSandboxEnabled(true);
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(turn("running"));
      queue.fail(new Error("Disconnect"));
    });
    const response = await send();
    expect(response.statusCode).toBe(202);
    const id = response.json().run.id;
    await vi.waitFor(() => expect(queue.close).toHaveBeenCalled());
    runtime.events.mockResolvedValue(new RuntimeQueue());
    runtime.listTurns.mockImplementation(async function* () {
      yield root("succeeded");
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield {
        externalId: "saved-command",
        turnExternalId: "root-test",
        role: "assistant",
        status: "completed",
        phase: null,
        content: [
          {
            type: "command",
            command: '/bin/bash -lc "cat /workspace/outputs/hello.txt"',
            cwd: "/workspace",
            exitCode: 0,
            durationMs: 0,
            output: "hi",
            outputTruncated: false,
          },
        ],
      };
      yield {
        externalId: "saved-item",
        turnExternalId: "root-test",
        role: "assistant",
        status: "completed",
        phase: "final",
        content: [{ type: "text", text: "Recovered reply" }],
      };
    });
    expect(
      (await app.inject({ method: "POST", url: `/runs/${id}/reconcile`, headers })).statusCode,
    ).toBe(202);
    await waitStatus(id, "succeeded");
    expect(runtime.sendInput).toHaveBeenCalledOnce();
    const history = (
      await app.inject({ method: "GET", url: `/conversations/${conversationId}/messages` })
    ).json().items;
    expect(
      history.some(
        (message: { content: Array<{ text: string }> }) =>
          message.content[0]?.text === "Recovered reply",
      ),
    ).toBe(true);
    expect(
      history
        .filter((message: { role: string }) => message.role === "assistant")
        .map((message: { content: Array<{ type: string }> }) => message.content[0]?.type),
    ).toEqual(["command", "text"]);
    expect((await app.inject({ method: "GET", url: `/runs/${id}` })).json().run.error).toBeNull();
  });
});
