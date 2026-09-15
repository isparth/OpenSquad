import { randomUUID } from "node:crypto";
import type { RuntimeEvent, RuntimeTurn } from "@opensquad/core";
import { agents, conversationRuns, conversations } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { conversationsService } from "../src/modules/conversations/service.js";
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
  const session = {
    provider: "fake-runtime",
    externalId: "session-test",
    model: "gpt-6-astra",
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
  const turn = (status: RuntimeTurn["status"]): RuntimeEvent => ({
    externalId: randomUUID(),
    sessionExternalId: session.externalId,
    turnExternalId: "root-test",
    type: "turn.status",
    turn: root(status),
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
    const database = createDatabase("postgres://opensquad:opensquad@localhost:5432/opensquad");
    try {
      await database.db.delete(conversations).where(eq(conversations.id, conversationId));
      await database.db.delete(agents).where(eq(agents.id, agentId));
    } finally {
      await database.close();
    }
  });
  const send = (clientRequestId = randomUUID()) =>
    app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      headers,
      payload: { text: "Hello", clientRequestId },
    });
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
    runtime.events.mockRejectedValue(new Error("private subscription detail"));
    const response = await send();
    expect(response.statusCode).toBe(202);
    await waitStatus(response.json().run.id, "failed");
    expect(runtime.sendInput).not.toHaveBeenCalled();
  });

  it("requests cancellation at the persisted deadline", async () => {
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
