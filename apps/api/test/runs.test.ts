import { randomUUID } from "node:crypto";
import type { RuntimeEvent, RuntimeMessage, RuntimeTurn } from "@opensquad/core";
import { agents, conversationRuns, conversations } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import { testDatabaseUrl } from "./database-url.js";
import { FakeRuntimeProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import { RuntimeQueue } from "./runtime-queue.js";

describe("runtime HTTP execution", () => {
  let app: App;
  let runtime: FakeRuntimeProvider;
  let queue: RuntimeQueue;
  let conversationId: string;
  let agentId: string;
  const headers = { "x-opensquad-runtime-key": "dummy-user-key" };
  const expectedAutoMemoryInstructions = `## Memory
Nothing is saved about this user yet. If the user asks you to remember or forget something, acknowledge it briefly. Saved memory is updated in the background after conversations and applies to later ones.`;
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
    queue = new RuntimeQueue();
    runtime.createSession.mockResolvedValue(session);
    runtime.events.mockResolvedValue(queue);
    runtime.listTurns.mockImplementation(async function* () {
      yield* [];
    });
    runtime.listMessages.mockImplementation(async function* () {
      yield* [];
    });
    app = await createTestApp({ capabilities: { runtime } });
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
  const send = (clientRequestId = randomUUID(), text = "Hello") =>
    app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      headers,
      payload: { text, clientRequestId },
    });
  async function setSandboxEnabled(sandboxEnabled: boolean) {
    const response = await app.inject({
      method: "PATCH",
      url: `/agents/${agentId}`,
      payload: { sandboxEnabled },
    });
    expect(response.statusCode).toBe(200);
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
      instructions: expectedAutoMemoryInstructions,
      model: "gpt-6-luna",
      environment: "hosted",
    });
    expect(runtime.sendInput.mock.calls[0]?.[1]).toBe("Hello");
    expect(runtime.sendInput.mock.invocationCallOrder[0]).toBeGreaterThan(
      runtime.events.mock.invocationCallOrder[0] ?? 0,
    );
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
    expect((await app.inject({ method: "GET", url: `/runs/${id}` })).json().run.error).toBeNull();
  });
});
