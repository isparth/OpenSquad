import { randomUUID } from "node:crypto";
import type {
  ConversationFile,
  RuntimeArtifact,
  RuntimeSession,
  RuntimeTurn,
  StorageProvider,
} from "@opensquad/core";
import {
  agents,
  conversationEvents,
  conversationFiles,
  conversationRuns,
  conversations,
  createDatabase,
} from "@opensquad/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { collectRunFiles } from "../src/modules/conversations/file-collection.js";
import { conversationsService } from "../src/modules/conversations/service.js";
import { testDatabaseUrl } from "./database-url.js";
import { FakeRuntimeProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import { RuntimeQueue } from "./runtime-queue.js";

const ownerId = "dev-user";
const rootTurnId = "file-root";
const maxFileBytes = 25 * 1024 * 1024;
const maxRunBytes = 100 * 1024 * 1024;
const credentials = { apiKey: "dummy-file-key" };

class MemoryStorage implements StorageProvider {
  readonly name = "memory-test";
  readonly objects = new Map<string, Uint8Array>();
  readonly put = vi.fn<StorageProvider["put"]>(async (key, data, contentType) => {
    const bytes = new Uint8Array(data);
    this.objects.set(key, bytes);
    return contentType
      ? { key, size: bytes.byteLength, contentType }
      : { key, size: bytes.byteLength };
  });
  readonly get = vi.fn<StorageProvider["get"]>(async (key) => {
    const bytes = this.objects.get(key);
    return bytes ? new Uint8Array(bytes) : null;
  });
  readonly delete = vi.fn<StorageProvider["delete"]>(async (key) => {
    this.objects.delete(key);
  });
  readonly getSignedUrl = vi.fn<StorageProvider["getSignedUrl"]>(
    async (key) => `https://storage.invalid/${encodeURIComponent(key)}`,
  );
}

function artifact(
  externalId: string,
  path: string,
  sizeBytes: number,
  createdAt: string,
  turnExternalId = rootTurnId,
): RuntimeArtifact {
  return { externalId, turnExternalId, path, sizeBytes, createdAt };
}

function runtimeTurn(status: RuntimeTurn["status"]): RuntimeTurn {
  return {
    externalId: rootTurnId,
    subagentExternalId: null,
    status,
    usage: { inputTokens: 3, outputTokens: 4 },
    error: null,
  };
}

function runtimeEvent(status: RuntimeTurn["status"], sessionExternalId: string) {
  return {
    type: "turn.status" as const,
    externalId: `event-${status}-${randomUUID()}`,
    sessionExternalId,
    turnExternalId: rootTurnId,
    turn: runtimeTurn(status),
  };
}

describe("conversation output-file collection", () => {
  let app: App;
  let runtime: FakeRuntimeProvider;
  let storage: MemoryStorage;
  let queue: RuntimeQueue;
  let agentId: string;
  let conversationId: string;
  let session: RuntimeSession;
  const extraAgents: string[] = [];
  const extraConversations: string[] = [];

  beforeEach(async () => {
    runtime = new FakeRuntimeProvider();
    runtime.features.artifacts = true;
    storage = new MemoryStorage();
    queue = new RuntimeQueue();
    session = {
      provider: runtime.name,
      externalId: `file-session-${randomUUID().replaceAll("-", "")}`,
      model: "gpt-6-luna",
      status: "idle",
      environmentExternalId: "file-environment",
    };
    runtime.createSession.mockResolvedValue(session);
    runtime.events.mockResolvedValue(queue);
    runtime.listTurns.mockImplementation(async function* () {});
    runtime.listMessages.mockImplementation(async function* () {});
    runtime.sendInput.mockImplementation(async () => {
      queue.emit(runtimeEvent("running", session.externalId));
      queue.emit(runtimeEvent("succeeded", session.externalId));
    });
    runtime.listArtifacts.mockImplementation(async function* () {});
    runtime.readArtifact.mockImplementation(async () => new Uint8Array());
    app = await createTestApp({
      capabilities: { runtime, storage },
      fileCollection: { retryDelayMs: 5 },
    });
    const agent = await agentsService(app.db).create({
      ownerId,
      name: "File collection bot",
      sandboxEnabled: true,
    });
    agentId = agent.id;
    conversationId = (await conversationsService(app.db).create(ownerId, agentId, null))
      .conversation.id;
  });

  afterEach(async () => {
    await app.close();
    const database = createDatabase(testDatabaseUrl);
    try {
      for (const id of extraConversations.splice(0))
        await database.db.delete(conversations).where(eq(conversations.id, id));
      await database.db.delete(conversations).where(eq(conversations.id, conversationId));
      for (const id of extraAgents.splice(0))
        await database.db.delete(agents).where(eq(agents.id, id));
      await database.db.delete(agents).where(eq(agents.id, agentId));
    } finally {
      await database.close();
    }
  });

  async function sendRun() {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      headers: { "x-opensquad-runtime-key": credentials.apiKey },
      payload: { text: "Create an output file.", clientRequestId: randomUUID() },
    });
    expect(response.statusCode).toBe(202);
    const runId = response.json().run.id as string;
    await vi.waitFor(
      async () => {
        const [run] = await app.db
          .select()
          .from(conversationRuns)
          .where(eq(conversationRuns.id, runId));
        expect(run?.status).toBe("succeeded");
        expect(run?.active).toBe(false);
      },
      { timeout: 5_000, interval: 20 },
    );
    return runId;
  }

  async function waitForFiles(runId: string, count: number) {
    await vi.waitFor(
      async () => {
        const rows = await app.db
          .select()
          .from(conversationFiles)
          .where(eq(conversationFiles.runId, runId));
        expect(rows).toHaveLength(count);
      },
      { timeout: 5_000, interval: 20 },
    );
    return app.db
      .select()
      .from(conversationFiles)
      .where(eq(conversationFiles.runId, runId))
      .orderBy(asc(conversationFiles.createdAt));
  }

  it("stores root-turn artifacts and exposes paged attachment-only DTOs", async () => {
    const firstBytes = new TextEncoder().encode("fruit,price\napple,1\n");
    const secondBytes = new TextEncoder().encode("notes\n");
    const first = artifact(
      "artifact-fruit",
      "/workspace/outputs/reports/\u0007früit.csv",
      firstBytes.byteLength,
      "2026-09-24T10:00:00.000Z",
    );
    const second = artifact(
      "artifact-notes",
      "/workspace/outputs/notes.md",
      secondBytes.byteLength,
      "2026-09-24T10:00:01.000Z",
    );
    const otherTurn = artifact(
      "artifact-other-turn",
      "/workspace/outputs/other.txt",
      5,
      "2026-09-24T10:00:02.000Z",
      "another-turn",
    );
    const contents = new Map([
      [first.externalId, firstBytes],
      [second.externalId, secondBytes],
    ]);
    runtime.listArtifacts.mockImplementation(async function* () {
      yield second;
      yield otherTurn;
      yield first;
    });
    runtime.readArtifact.mockImplementation(async (_ref, externalId) => {
      const bytes = contents.get(externalId);
      if (!bytes) throw new Error("Unexpected artifact read");
      return bytes;
    });

    const runId = await sendRun();
    const rows = await waitForFiles(runId, 2);
    expect(rows.map((file) => file.name)).toEqual(["reports/früit.csv", "notes.md"]);
    expect(rows.map((file) => file.status)).toEqual(["stored", "stored"]);
    expect(rows.map((file) => file.contentType)).toEqual(["text/csv", "text/markdown"]);
    expect(rows[0]?.storageKey).toBe(`conversations/${conversationId}/files/${rows[0]?.id}`);
    expect(storage.objects.get(rows[0]?.storageKey ?? "")).toEqual(firstBytes);
    expect(storage.objects.get(rows[1]?.storageKey ?? "")).toEqual(secondBytes);
    expect(runtime.readArtifact).toHaveBeenCalledTimes(2);

    const events = await app.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversationId));
    const fileEvents = events.filter((event) => event.type === "files.updated");
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]?.runId).toBe(runId);
    expect(fileEvents[0]?.payload.runId).toBe(runId);
    expect(JSON.stringify(fileEvents[0]?.payload)).not.toContain("/workspace/outputs");
    expect(JSON.stringify(fileEvents[0]?.payload)).not.toContain("storageKey");

    const pageOne = await app.inject({
      method: "GET",
      url: `/conversations/${conversationId}/files?limit=1`,
    });
    expect(pageOne.statusCode).toBe(200);
    expect(pageOne.json().items).toHaveLength(1);
    expect(pageOne.json().items[0]).toMatchObject({
      id: rows[1]?.id,
      name: "notes.md",
      sizeBytes: secondBytes.byteLength,
      contentType: "text/markdown",
      status: "stored",
    });
    expect(pageOne.json().items[0]).not.toHaveProperty("path");
    expect(pageOne.json().items[0]).not.toHaveProperty("storageKey");
    const cursorFile = rows[1];
    if (!cursorFile) throw new Error("Expected a second stored file");
    const directPage = await conversationsService(app.db).files(ownerId, conversationId, 1, {
      createdAt: cursorFile.createdAt,
      id: cursorFile.id,
    });
    expect(directPage.items.map((file) => file.id)).toEqual([rows[0]?.id]);
    const pageTwo = await app.inject({
      method: "GET",
      url: `/conversations/${conversationId}/files?limit=1&cursor=${encodeURIComponent(pageOne.json().nextCursor)}`,
    });
    expect(pageTwo.statusCode).toBe(200);
    expect(pageTwo.json().items.map((file: ConversationFile) => file.id)).toEqual([rows[0]?.id]);
    expect(pageTwo.json().nextCursor).toBeNull();

    const content = await app.inject({
      method: "GET",
      url: `/conversations/${conversationId}/files/${rows[0]?.id}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(Buffer.from(firstBytes));
    expect(content.headers["content-type"]).toBe("application/octet-stream");
    expect(content.headers["content-disposition"]).toContain('filename="fr_it.csv"');
    expect(content.headers["content-disposition"]).toContain("filename*=UTF-8''fr%C3%BCit.csv");
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.headers["cache-control"]).toBe("private, no-store");

    const foreignAgent = await agentsService(app.db).create({
      ownerId: "other-owner",
      name: "Other",
    });
    extraAgents.push(foreignAgent.id);
    const foreignConversation = (
      await conversationsService(app.db).create("other-owner", foreignAgent.id, null)
    ).conversation;
    extraConversations.push(foreignConversation.id);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/conversations/${foreignConversation.id}/files`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/conversations/${foreignConversation.id}/files/${rows[0]?.id}/content`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("strips bidi controls from output names and content dispositions", async () => {
    runtime.listArtifacts.mockImplementation(async function* () {
      yield artifact(
        "artifact-bidi-name",
        "/workspace/outputs/invoice\u202Efdp.exe",
        1,
        "2026-09-24T10:00:00.000Z",
      );
    });
    runtime.readArtifact.mockResolvedValue(new Uint8Array([1]));
    const runId = await sendRun();
    const [file] = await waitForFiles(runId, 1);

    expect(file?.name).toBe("invoicefdp.exe");
    const content = await app.inject({
      method: "GET",
      url: `/conversations/${conversationId}/files/${file?.id}/content`,
    });
    expect(content.headers["content-disposition"]).toContain('filename="invoicefdp.exe"');
    expect(content.headers["content-disposition"]).toContain("filename*=UTF-8''invoicefdp.exe");
  });

  it("records an artifact over 25 MiB as too_large without reading it", async () => {
    runtime.listArtifacts.mockImplementation(async function* () {
      yield artifact(
        "artifact-too-large",
        "/workspace/outputs/large.zip",
        maxFileBytes + 1,
        "2026-09-24T10:00:00.000Z",
      );
    });
    const runId = await sendRun();
    const [file] = await waitForFiles(runId, 1);
    expect(file).toMatchObject({
      status: "too_large",
      storageKey: null,
      sizeBytes: maxFileBytes + 1,
    });
    expect(runtime.readArtifact).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/conversations/${conversationId}/files/${file?.id}/content`,
        })
      ).statusCode,
    ).toBe(404);
    const [run] = await app.db
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, runId));
    expect(run?.status).toBe("succeeded");
  });

  it("enforces the 100 MiB per-run total", async () => {
    const sharedBytes = new Uint8Array(maxFileBytes);
    const artifacts = Array.from({ length: 5 }, (_, index) =>
      artifact(
        `artifact-total-${index}`,
        `/workspace/outputs/total-${index}.bin`,
        index < 4 ? maxFileBytes : 1,
        new Date(Date.parse("2026-09-24T10:00:00.000Z") + index * 1_000).toISOString(),
      ),
    );
    runtime.listArtifacts.mockImplementation(async function* () {
      yield* artifacts;
    });
    runtime.readArtifact.mockResolvedValue(sharedBytes);
    const runId = await sendRun();
    const rows = await waitForFiles(runId, 5);
    expect(rows.slice(0, 4).every((file) => file.status === "stored")).toBe(true);
    expect(rows.slice(0, 4).reduce((sum, file) => sum + file.sizeBytes, 0)).toBe(maxRunBytes);
    expect(rows[4]).toMatchObject({ status: "too_large", sizeBytes: 1, storageKey: null });
    expect(runtime.readArtifact).toHaveBeenCalledTimes(4);
    expect(runtime.readArtifact.mock.calls.map((call) => call[3].maxBytes)).toEqual(
      Array(4).fill(maxFileBytes),
    );
  });

  it("accounts actual bytes against the per-run limit", async () => {
    const sharedBytes = new Uint8Array(maxFileBytes);
    const artifacts = Array.from({ length: 5 }, (_, index) =>
      artifact(
        `artifact-underreported-${index}`,
        `/workspace/outputs/underreported-${index}.bin`,
        1,
        new Date(Date.parse("2026-09-24T10:00:00.000Z") + index * 1_000).toISOString(),
      ),
    );
    runtime.listArtifacts.mockImplementation(async function* () {
      yield* artifacts;
    });
    runtime.readArtifact.mockResolvedValue(sharedBytes);
    const runId = await sendRun();
    const rows = await waitForFiles(runId, 5);
    expect(rows.slice(0, 4).every((file) => file.status === "stored")).toBe(true);
    expect(rows.slice(0, 4).map((file) => file.sizeBytes)).toEqual(Array(4).fill(maxFileBytes));
    expect(rows[4]).toMatchObject({ status: "too_large", sizeBytes: 1, storageKey: null });
    expect(runtime.readArtifact).toHaveBeenCalledTimes(4);
  });

  it("collects at most 20 files for one run", async () => {
    const artifacts = Array.from({ length: 21 }, (_, index) =>
      artifact(
        `artifact-count-${index}`,
        `/workspace/outputs/file-${index}.txt`,
        1,
        new Date(Date.parse("2026-09-24T10:00:00.000Z") + index * 1_000).toISOString(),
      ),
    );
    runtime.listArtifacts.mockImplementation(async function* () {
      yield* artifacts;
    });
    runtime.readArtifact.mockImplementation(async () => new Uint8Array([1]));
    const runId = await sendRun();
    const rows = await waitForFiles(runId, 20);
    expect(rows).toHaveLength(20);
    expect(rows.some((file) => file.externalArtifactId === "artifact-count-20")).toBe(false);
    expect(runtime.readArtifact).toHaveBeenCalledTimes(20);
  });

  it("records a read failure without changing the successful run", async () => {
    runtime.listArtifacts.mockImplementation(async function* () {
      yield artifact(
        "artifact-failed",
        "/workspace/outputs/fail.txt",
        3,
        "2026-09-24T10:00:00.000Z",
      );
    });
    runtime.readArtifact.mockRejectedValueOnce(new Error("private runtime diagnostic"));
    const runId = await sendRun();
    const [file] = await waitForFiles(runId, 1);
    expect(file).toMatchObject({ status: "failed", storageKey: null, sizeBytes: 3 });
    expect(storage.put).not.toHaveBeenCalled();
    const [run] = await app.db
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, runId));
    expect(run?.status).toBe("succeeded");
  });

  it("waits once for delayed artifacts and remains idempotent on collection replay", async () => {
    const delayed = artifact(
      "artifact-delayed",
      "/workspace/outputs/delayed.txt",
      1,
      "2026-09-24T10:00:00.000Z",
    );
    runtime.listArtifacts
      .mockImplementationOnce(async function* () {})
      .mockImplementationOnce(async function* () {
        yield delayed;
      });
    runtime.readArtifact.mockResolvedValue(new Uint8Array([1]));
    const runId = await sendRun();
    await waitForFiles(runId, 1);
    expect(runtime.listArtifacts).toHaveBeenCalledTimes(2);
    expect(runtime.readArtifact).toHaveBeenCalledOnce();

    runtime.listArtifacts.mockImplementation(async function* () {
      yield delayed;
    });
    await collectRunFiles(
      app.db,
      runtime,
      storage,
      ownerId,
      runId,
      credentials,
      new AbortController().signal,
      { retryDelayMs: 5 },
    );
    expect(
      await app.db.select().from(conversationFiles).where(eq(conversationFiles.runId, runId)),
    ).toHaveLength(1);
    expect(runtime.readArtifact).toHaveBeenCalledOnce();
    const events = await app.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversationId));
    expect(events.filter((event) => event.type === "files.updated")).toHaveLength(1);
  });

  it("does not list artifacts for environmentless sessions", async () => {
    await agentsService(app.db).update(ownerId, agentId, { sandboxEnabled: false });
    runtime.createSession.mockResolvedValueOnce({ ...session, environmentExternalId: null });
    runtime.listTurns.mockImplementationOnce(async function* () {
      yield runtimeTurn("succeeded");
    });
    const runId = await sendRun();
    await vi.waitFor(async () => {
      const [run] = await app.db
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.id, runId));
      expect(run?.active).toBe(false);
    });
    expect(runtime.listArtifacts).not.toHaveBeenCalled();
  });

  it("does not list artifacts when the runtime feature is disabled", async () => {
    runtime.features.artifacts = false;
    const runId = await sendRun();
    const [run] = await app.db
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, runId));
    expect(run?.status).toBe("succeeded");
    expect(runtime.listArtifacts).not.toHaveBeenCalled();
  });
});
