import type { ConversationFile, MemoryReview } from "@opensquad/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentRecord, ApiClient, ApiError } from "@/lib/api/client.js";

const agent: AgentRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test",
  label: null,
  description: "",
  instructions: "",
  sandboxEnabled: false,
  toolGrants: [],
  avatarUrl: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};
const api = new ApiClient("http://localhost:3000/");
beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("bot HTTP client", () => {
  it("lists, reads, creates and updates validated bot records", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify([agent])));
    expect(await api.listAgents()).toEqual([agent]);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(agent)));
    expect(await api.getAgent(agent.id)).toEqual(agent);
    const input = {
      name: "Test",
      label: null,
      description: "",
      instructions: "",
      sandboxEnabled: false,
      toolGrants: [{ toolkit: "github", access: "read" as const }],
    };
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(agent)));
    await api.createAgent(input);
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/agents",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input), redirect: "error" }),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(agent)));
    await api.updateAgent(agent.id, { label: null });
    expect(fetch).toHaveBeenLastCalledWith(
      `http://localhost:3000/agents/${agent.id}`,
      expect.objectContaining({ method: "PATCH", body: '{"label":null}' }),
    );
  });

  it("rejects missing and non-boolean sandbox settings in bot responses", async () => {
    const missing: Record<string, unknown> = { ...agent };
    delete missing.sandboxEnabled;
    for (const value of [missing, { ...agent, sandboxEnabled: "true" }]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(value)));
      await expect(api.getAgent(agent.id)).rejects.toThrow("Invalid bot response");
    }
  });

  it("reads tool grants, treating a missing field as none and rejecting bad shapes", async () => {
    const granted = { ...agent, toolGrants: [{ toolkit: "github", access: "write" }] };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(granted)));
    expect((await api.getAgent(agent.id)).toolGrants).toEqual(granted.toolGrants);
    const missing: Record<string, unknown> = { ...agent };
    delete missing.toolGrants;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(missing)));
    expect((await api.getAgent(agent.id)).toolGrants).toEqual([]);
    for (const toolGrants of [
      null,
      {},
      [{ toolkit: "github" }],
      [{ toolkit: 1, access: "read" }],
    ]) {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ...agent, toolGrants })),
      );
      await expect(api.getAgent(agent.id)).rejects.toThrow("Invalid bot response");
    }
  });

  it("handles a bodyless 204 delete response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.deleteAgent(agent.id)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      `http://localhost:3000/agents/${agent.id}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("leaves multipart boundaries to fetch", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ avatarUrl: `/agents/${agent.id}/avatar/test.png` })),
    );
    const file = new File(["test"], "photo.png", { type: "image/png" });
    await api.uploadAvatar(agent.id, file);
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.headers).toBeUndefined();
    if (!(init?.body instanceof FormData)) throw new Error("Expected multipart FormData");
    expect(init.body.get("avatar")).toBe(file);
  });

  it("does not fetch arbitrary avatar URLs and rejects wrong response types", async () => {
    const signal = new AbortController().signal;
    for (const avatarUrl of [
      "https://outside.example/image.png",
      "/agents/other/avatar/a.png",
      `/agents/${agent.id}/avatar/../../secret`,
    ]) {
      await expect(api.getAvatar({ ...agent, avatarUrl }, signal)).rejects.toThrow(
        "Invalid avatar location",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("<html>", { headers: { "content-type": "text/html" } }),
    );
    await expect(
      api.getAvatar({ ...agent, avatarUrl: `/agents/${agent.id}/avatar/abcd.png` }, signal),
    ).rejects.toThrow("Invalid avatar type");
  });

  it("keeps abort signals and private avatar bytes intact", async () => {
    const signal = new AbortController().signal;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("image", { headers: { "content-type": "image/png" } }),
    );
    const blob = await api.getAvatar(
      { ...agent, avatarUrl: `/agents/${agent.id}/avatar/abcd.png` },
      signal,
    );
    expect(blob.size).toBe(5);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal, redirect: "error" }),
    );
  });

  it("rejects malformed records and preserves HTTP status without leaking response diagnostics", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: "missing-fields" }])),
    );
    await expect(api.listAgents()).rejects.toThrow("Invalid bot response");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("secret internal diagnostic", { status: 404 }),
    );
    await expect(api.getAgent(agent.id)).rejects.toEqual(
      new ApiError(404, "API returned status 404"),
    );
  });
});

const conversation = { id: "c-1", title: null, createdAt: "2026-09-15T00:00:00.000Z" };
const message = {
  id: "m-1",
  conversationId: "c-1",
  participantId: "p-1",
  runId: "r-1",
  sequence: "2",
  role: "assistant",
  content: [{ index: 0, type: "text", text: "hi", completed: false }],
  phase: null,
  status: "running",
  createdAt: "2026-09-15T00:00:00.000Z",
};
const conversationFile: ConversationFile = {
  id: "f-1",
  conversationId: "c-1",
  runId: "r-1",
  name: "reports/fruit.csv",
  sizeBytes: 14,
  contentType: "text/csv",
  status: "stored",
  createdAt: "2026-09-15T00:00:01.000Z",
};

describe("conversation client", () => {
  it("lists conversations for an agent with an encoded query", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [conversation], nextCursor: "next-1" })),
    );
    expect(await api.listConversations("bot id")).toEqual({
      items: [conversation],
      nextCursor: "next-1",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/conversations?agentId=bot%20id&limit=100",
      expect.objectContaining({ redirect: "error" }),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null })));
    expect(await api.listConversations("bot id", "cur sor")).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/conversations?agentId=bot%20id&limit=100&cursor=cur%20sor",
      expect.anything(),
    );
  });

  it("refetches /me after a failed lookup instead of caching the rejection", async () => {
    const client = new ApiClient("http://localhost:3000/");
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(client.createConversation("agent-1")).rejects.toEqual(
      new ApiError(500, "API returned status 500"),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ userId: "dev-user" })));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ conversation })));
    await client.createConversation("agent-1");
    expect(fetch).toHaveBeenNthCalledWith(2, "http://localhost:3000/me", expect.anything());
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3000/conversations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("creates a conversation with the cached /me user id", async () => {
    const client = new ApiClient("http://localhost:3000/");
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ userId: "dev-user" })));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ conversation })));
    await client.createConversation("agent-1");
    expect(fetch).toHaveBeenNthCalledWith(1, "http://localhost:3000/me", expect.anything());
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3000/conversations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          participants: [
            { kind: "user", refId: "dev-user" },
            { kind: "agent", refId: "agent-1" },
          ],
        }),
      }),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ conversation })));
    await client.createConversation("agent-2");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3000/conversations",
      expect.objectContaining({
        body: JSON.stringify({
          participants: [
            { kind: "user", refId: "dev-user" },
            { kind: "agent", refId: "agent-2" },
          ],
        }),
      }),
    );
  });

  it("lists messages with an optional encoded cursor", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [message], nextCursor: null })),
    );
    expect(await api.listMessages("c 1", null)).toEqual({ items: [message], nextCursor: null });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/conversations/c%201/messages?limit=50",
      expect.anything(),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: "older" })));
    expect(await api.listMessages("c-1", "cur sor")).toEqual({ items: [], nextCursor: "older" });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/conversations/c-1/messages?limit=50&cursor=cur%20sor",
      expect.anything(),
    );
  });

  it("lists validated conversation files with an optional encoded cursor", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(
      Response.json({
        items: [
          {
            ...conversationFile,
            path: "/workspace/outputs/reports/fruit.csv",
            storageKey: "private",
          },
        ],
        nextCursor: "next-file",
      }),
    );
    expect(await api.listConversationFiles("c 1", null)).toEqual({
      items: [conversationFile],
      nextCursor: "next-file",
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/conversations/c%201/files?limit=50",
      expect.objectContaining({ redirect: "error" }),
    );

    fetch.mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
    expect(await api.listConversationFiles("c-1", "next file")).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/conversations/c-1/files?limit=50&cursor=next%20file",
      expect.anything(),
    );
  });

  it("rejects malformed conversation-file fields", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ items: [{ ...conversationFile, sizeBytes: "14" }], nextCursor: null }),
    );
    await expect(api.listConversationFiles("c-1", null)).rejects.toThrow(
      "Invalid conversation response",
    );
  });

  it("downloads file bytes through a temporary named blob link", async () => {
    const NativeURL = globalThis.URL;
    const createObjectURL = vi.fn((_blob: Blob) => "blob:opensquad-file");
    const revokeObjectURL = vi.fn();
    class URLWithObjectUrls extends NativeURL {}
    Object.defineProperties(URLWithObjectUrls, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    vi.stubGlobal("URL", URLWithObjectUrls);
    let clicked: { href: string; download: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked = { href: this.href, download: this.download };
    });
    const bytes = new Uint8Array([102, 114, 117, 105, 116]);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
    );

    await api.downloadConversationFile("c-1", conversationFile);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/conversations/c-1/files/f-1/content",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0]?.[0]).toMatchObject({
      size: bytes.byteLength,
      type: "application/octet-stream",
    });
    expect(clicked).toEqual({ href: "blob:opensquad-file", download: "fruit.csv" });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:opensquad-file");
  });

  it("accepts valid command content and rejects malformed command fields", async () => {
    const commandPart = {
      index: 0,
      completed: true,
      type: "command",
      command: '/bin/bash -lc "cat file"',
      cwd: "/workspace",
      exitCode: 0,
      durationMs: 400,
      output: "hi",
      outputTruncated: false,
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ items: [{ ...message, content: [commandPart] }], nextCursor: null }),
      ),
    );
    expect(await api.listMessages("c-1", null)).toMatchObject({
      items: [{ content: [commandPart] }],
      nextCursor: null,
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              ...message,
              content: [{ ...commandPart, exitCode: "0" }],
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    await expect(api.listMessages("c-1", null)).rejects.toThrow("Invalid conversation response");
  });

  it("accepts command content and rejects malformed command parts", async () => {
    const command = {
      index: 0,
      completed: true,
      type: "command",
      command: '/bin/bash -lc "cat file"',
      cwd: "/workspace",
      exitCode: 0,
      durationMs: 400,
      output: "hi",
      outputTruncated: false,
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ items: [{ ...message, content: [command] }], nextCursor: null }),
      ),
    );
    expect(await api.listMessages("c-1", null)).toMatchObject({
      items: [{ content: [command] }],
      nextCursor: null,
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [{ ...message, content: [{ ...command, durationMs: "400" }] }],
          nextCursor: null,
        }),
      ),
    );
    await expect(api.listMessages("c-1", null)).rejects.toThrow("Invalid conversation response");
  });

  it("rejects malformed conversation payloads and preserves HTTP status", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    for (const body of [
      { items: [{ id: "c-1" }], nextCursor: null },
      { items: [{ ...message, role: "system" }], nextCursor: null },
      { items: [{ ...message, content: [{ index: 0, type: "text", text: 1 }] }], nextCursor: null },
      { items: [{ ...message, status: "queued" }], nextCursor: null },
      { items: [{ ...message, phase: "draft" }], nextCursor: null },
      { items: [{ ...message, sequence: 2 }], nextCursor: null },
      { items: [{ ...message, sequence: "abc" }], nextCursor: null },
      { items: [{ ...message, sequence: "2.5" }], nextCursor: null },
    ]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify(body)));
      await expect(api.listMessages("c-1", null)).rejects.toThrow("Invalid conversation response");
    }
    fetch.mockResolvedValueOnce(new Response("nope", { status: 502 }));
    await expect(api.listConversations("a")).rejects.toEqual(
      new ApiError(502, "API returned status 502"),
    );
  });
});

const memoryDocument = {
  name: "profile",
  scope: "shared",
  content: "Name: Parth",
  version: 2,
  limit: 4000,
  updatedAt: "2026-09-15T00:00:00.000Z",
};
const memoryRevision = {
  version: 2,
  author: "user",
  content: "Name: Parth",
  createdAt: "2026-09-15T00:00:00.000Z",
};
const memoryUpdate = {
  id: "77777777-7777-4777-8777-777777777777",
  agentId: "11111111-1111-4111-8111-111111111111",
  trigger: "auto",
  status: "succeeded",
  changed: [{ name: "profile", fromVersion: 0, toVersion: 1 }],
  errorCode: null,
  usage: { inputTokens: 10, outputTokens: 5 },
  createdAt: "2026-09-15T00:00:00.000Z",
  finishedAt: "2026-09-15T00:00:05.000Z",
};
const memoryReview: MemoryReview = {
  updateId: memoryUpdate.id,
  agentId: memoryUpdate.agentId,
  agentName: "Test bot",
  trigger: "auto",
  createdAt: memoryUpdate.createdAt,
  finishedAt: memoryUpdate.finishedAt,
  sources: [
    {
      conversationId: "88888888-8888-4888-8888-888888888888",
      title: "Earlier context",
      startedAt: "2026-09-14T00:00:00.000Z",
    },
  ],
  changes: [
    {
      name: "profile",
      fromVersion: 0,
      toVersion: 1,
      before: "",
      after: "- Name: Test",
      current: true,
    },
  ],
};

describe("memory client", () => {
  it("parses memory documents and revision pages into checked fields", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          documents: [{ ...memoryDocument, extra: "ignored" }],
          autoUpdate: true,
          lastUpdate: memoryUpdate,
          pendingReviewCount: 1,
          reviewList: [],
        }),
      ),
    );
    expect(await api.getMemory("agent-1")).toEqual({
      documents: [memoryDocument],
      autoUpdate: true,
      lastUpdate: memoryUpdate,
      pendingReviewCount: 1,
    });
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [memoryRevision], nextCursor: "2" })),
    );
    expect(await api.listMemoryRevisions("agent-1", "profile", null)).toEqual({
      items: [memoryRevision],
      nextCursor: "2",
    });
  });

  it("rejects a missing or invalid pending review count", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    for (const pendingReviewCount of [-1, 1.5, "1", null]) {
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            documents: [],
            autoUpdate: true,
            lastUpdate: null,
            pendingReviewCount,
          }),
        ),
      );
      await expect(api.getMemory("agent-1")).rejects.toThrow("Invalid memory response");
    }
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ documents: [], autoUpdate: true, lastUpdate: null })),
    );
    await expect(api.getMemory("agent-1")).rejects.toThrow("Invalid memory response");
  });

  it("rejects malformed memory documents and revisions", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    for (const document of [
      { ...memoryDocument, name: "secrets" },
      { ...memoryDocument, version: -1 },
      { name: "profile", scope: "shared", content: "", version: 0, updatedAt: null },
    ]) {
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            documents: [document],
            autoUpdate: true,
            lastUpdate: null,
            pendingReviewCount: 0,
          }),
        ),
      );
      await expect(api.getMemory("agent-1")).rejects.toThrow("Invalid memory response");
    }
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ items: [{ ...memoryRevision, author: "system" }], nextCursor: null }),
      ),
    );
    await expect(api.listMemoryRevisions("agent-1", "profile", null)).rejects.toThrow(
      "Invalid memory response",
    );
  });

  it.each([
    { ...memoryUpdate, status: "queued" },
    {
      ...memoryUpdate,
      changed: Array.from({ length: 4 }, () => ({ name: "notes", fromVersion: 0, toVersion: 1 })),
    },
    { ...memoryUpdate, changed: [{ name: "profile", fromVersion: -1, toVersion: 1 }] },
    { ...memoryUpdate, usage: { inputTokens: 1, outputTokens: -1 } },
    { ...memoryUpdate, finishedAt: 42 },
  ])("rejects malformed lastUpdate records", async (lastUpdate) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ documents: [], autoUpdate: true, lastUpdate, pendingReviewCount: 0 }),
      ),
    );
    await expect(api.getMemory("agent-1")).rejects.toThrow("Invalid memory response");
  });

  it("ignores additive fields in update records and their containers", async () => {
    const futureUpdate = {
      ...memoryUpdate,
      reviewList: [],
      changed: [{ ...memoryUpdate.changed[0], reviewedAt: memoryUpdate.createdAt }],
      usage: { ...memoryUpdate.usage, cachedTokens: 2 },
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          documents: [],
          autoUpdate: true,
          lastUpdate: futureUpdate,
          pendingReviewCount: 0,
          reviewList: [],
        }),
      ),
    );
    expect(await api.getMemory("agent-1")).toEqual({
      documents: [],
      autoUpdate: true,
      lastUpdate: memoryUpdate,
      pendingReviewCount: 0,
    });
  });

  it("updates the owner-wide auto-update setting", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ autoUpdate: false, futureField: true })),
    );
    await expect(api.setMemoryAutoUpdate(false)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/memory/settings",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoUpdate: false }),
        redirect: "error",
      }),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ autoUpdate: "false" })));
    await expect(api.setMemoryAutoUpdate(false)).rejects.toThrow("Invalid memory response");
  });

  it("lists validated memory reviews with cursors and an abort signal", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    const controller = new AbortController();
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [memoryReview], nextCursor: "next" })),
    );
    await expect(api.listMemoryReviews("agent id", null, controller.signal)).resolves.toEqual({
      items: [memoryReview],
      nextCursor: "next",
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/agents/agent%20id/memory/reviews?limit=10",
      expect.objectContaining({ signal: controller.signal, redirect: "error" }),
    );

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null })));
    await expect(api.listMemoryReviews("agent id", "cursor 2")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/agents/agent%20id/memory/reviews?limit=10&cursor=cursor%202",
      expect.anything(),
    );
  });

  it("rejects malformed review changes and sources", async () => {
    const firstChange = memoryReview.changes[0];
    if (!firstChange) throw new Error("Expected review change");
    const malformed = [
      { ...memoryReview, changes: [{ ...firstChange, before: 1 }] },
      { ...memoryReview, changes: [] },
      { ...memoryReview, sources: [{ conversationId: "conversation", title: null }] },
    ];
    for (const item of malformed) {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [item], nextCursor: null })),
      );
      await expect(api.listMemoryReviews("agent-1", null)).rejects.toThrow(
        "Invalid memory response",
      );
    }
  });

  it("keeps and undoes reviews with empty JSON bodies and preserves 409 status", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.keepMemoryUpdate(memoryReview.updateId)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenLastCalledWith(
      `http://localhost:3000/memory/updates/${memoryReview.updateId}/keep`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        redirect: "error",
      }),
    );

    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.undoMemoryUpdate(memoryReview.updateId)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenLastCalledWith(
      `http://localhost:3000/memory/updates/${memoryReview.updateId}/undo`,
      expect.objectContaining({ method: "POST", body: "{}" }),
    );

    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "conflict" }), { status: 409 }),
    );
    await expect(api.undoMemoryUpdate(memoryReview.updateId)).rejects.toEqual(
      new ApiError(409, "API returned status 409"),
    );

    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "This memory update was already reviewed" }), {
        status: 409,
      }),
    );
    await expect(api.undoMemoryUpdate(memoryReview.updateId)).rejects.toEqual(
      new ApiError(409, "This memory update was already reviewed"),
    );
  });

  it("saves, reverts and forgets memory with the documented methods and payloads", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ document: memoryDocument })));
    expect(await api.saveMemory("agent id", "profile", "New name", 2)).toEqual(memoryDocument);
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/agents/agent%20id/memory/profile",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "New name", expectedVersion: 2 }),
      }),
    );

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ document: memoryDocument })));
    await api.revertMemory("agent id", "notes", 1, 2);
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/agents/agent%20id/memory/notes/revert",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, expectedVersion: 2 }),
      }),
    );

    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.forgetMemory()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/memory",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("encodes the revisions cursor and preserves conflict status", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [memoryRevision], nextCursor: null })),
    );
    await api.listMemoryRevisions("agent id", "preferences", "cursor 2");
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3000/agents/agent%20id/memory/preferences/revisions?limit=20&cursor=cursor%202",
      expect.anything(),
    );
    fetch.mockResolvedValueOnce(new Response("conflict", { status: 409 }));
    await expect(api.saveMemory("agent-1", "profile", "new", 2)).rejects.toEqual(
      new ApiError(409, "API returned status 409"),
    );
  });
});
