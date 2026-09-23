import { randomUUID } from "node:crypto";
import { Agent, get } from "node:http";
import { Readable } from "node:stream";
import { agents, conversationEvents, conversations, createDatabase } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { runAdmission } from "../src/modules/conversations/admission.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import { FakeRuntimeProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";

function frames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let buffer = "";
  const decoder = new TextDecoder();
  return async () => {
    while (!buffer.includes("\n\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("Stream ended before an event");
      buffer += decoder.decode(next.value, { stream: true });
    }
    const end = buffer.indexOf("\n\n");
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return frame;
  };
}

describe("product event streams over HTTP", () => {
  let app: App;
  let runtime: FakeRuntimeProvider;
  let address: string;
  let conversationId: string;
  let agentId: string;
  let httpAgent: Agent;
  function fetchStream(
    url: string,
    options: { signal: AbortSignal; headers?: Record<string, string> },
  ) {
    return new Promise<Response>((resolve, reject) => {
      const request = get(url, { ...options, agent: httpAgent }, (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode ?? 500,
            headers,
          }),
        );
      });
      request.on("error", reject);
    });
  }
  const pendingRequests = new Set<AbortController>();
  beforeEach(async () => {
    httpAgent = new Agent({ keepAlive: true });
    runtime = new FakeRuntimeProvider();
    app = await createTestApp({ capabilities: { runtime } });
    agentId = (await agentsService(app.db).create({ ownerId: "dev-user", name: "Stream test" })).id;
    conversationId = (await conversationsService(app.db).create("dev-user", agentId, null))
      .conversation.id;
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterEach(async () => {
    for (const controller of pendingRequests) controller.abort();
    pendingRequests.clear();
    httpAgent.destroy();
    await app.close();
    const db = createDatabase("postgres://opensquad:opensquad@localhost:5432/opensquad");
    try {
      await db.db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.db.delete(agents).where(eq(agents.id, agentId));
    } finally {
      await db.close();
    }
  });

  it("sends a consistent snapshot then tails committed events without runtime credentials", async () => {
    const controller = new AbortController();
    pendingRequests.add(controller);
    const response = await fetchStream(`${address}/conversations/${conversationId}/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    try {
      const next = frames(reader);
      const snapshot = await next();
      expect(snapshot).toContain("event: conversation.snapshot");
      expect(snapshot).toContain("id: 0");
      await runAdmission(app.db, {
        provider: "fake-runtime",
        model: "test-model",
        features: runtime.features,
      })("dev-user", conversationId, { text: "New message", clientRequestId: randomUUID() });
      const created = await next();
      expect(created).toContain("event: message.created");
      expect(created).toContain("New message");
      expect(created).not.toContain("sessionId");
      expect(created).not.toContain("leaseToken");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(runtime.events).not.toHaveBeenCalled();
  });

  it("replays only events after Last-Event-ID and rejects future/malformed cursors", async () => {
    await runAdmission(app.db, {
      provider: "fake-runtime",
      model: "test-model",
      features: runtime.features,
    })("dev-user", conversationId, { text: "Saved", clientRequestId: randomUUID() });
    const controller = new AbortController();
    pendingRequests.add(controller);
    const response = await fetchStream(`${address}/conversations/${conversationId}/events`, {
      headers: { "Last-Event-ID": "1" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    try {
      const frame = await frames(reader)();
      expect(frame).toContain("id: 2");
      expect(frame).toContain("event: run.updated");
      expect(frame).not.toContain("event: message.created");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    for (const cursor of ["999999", "-1", "invalid"]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/conversations/${conversationId}/events`,
            headers: { "last-event-id": cursor },
          })
        ).statusCode,
      ).toBe(400);
    }
  });

  it("acknowledges a caught-up replay cursor without waiting for a new event", async () => {
    const controller = new AbortController();
    pendingRequests.add(controller);
    const response = await fetchStream(`${address}/conversations/${conversationId}/events`, {
      headers: { "Last-Event-ID": "0" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    expect(await frames(reader)()).toContain(": keep-alive");
  });

  it("resets an expired cursor even when the retained event log is entirely empty", async () => {
    await runAdmission(app.db, {
      provider: "fake-runtime",
      model: "test-model",
      features: runtime.features,
    })("dev-user", conversationId, { text: "Retained history", clientRequestId: randomUUID() });
    await app.db
      .delete(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversationId));
    const controller = new AbortController();
    pendingRequests.add(controller);
    const response = await fetchStream(`${address}/conversations/${conversationId}/events`, {
      headers: { "Last-Event-ID": "0" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    const next = frames(reader);
    expect(await next()).toContain("event: stream.reset");
    const snapshot = await next();
    expect(snapshot).toContain("event: conversation.snapshot");
    expect(snapshot).toContain("Retained history");
  });

  it("closes live streams when the API shuts down without cancelling remote work", async () => {
    const controller = new AbortController();
    pendingRequests.add(controller);
    const response = await fetchStream(`${address}/conversations/${conversationId}/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    await frames(reader)();
    await app.close();
    await reader.cancel().catch(() => {});
    expect(runtime.cancel).not.toHaveBeenCalled();
  });
});
