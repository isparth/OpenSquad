import { describe, expect, it, vi } from "vitest";
import { createRuntimeCommands, type RuntimeCommands } from "../src/main/runtime-commands.js";
import type { RuntimeCredentialVault } from "../src/main/runtime-credentials.js";

const ORIGIN = "http://localhost:3000";
const KEY = "sk-test-runtime-key";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "77777777-7777-4777-8777-777777777777";
const CLIENT_REQUEST_ID = "33333333-3333-4333-8333-333333333333";

const run = {
  id: RUN_ID,
  conversationId: CONVERSATION_ID,
  agentParticipantId: "44444444-4444-4444-8444-444444444444",
  clientRequestId: CLIENT_REQUEST_ID,
  status: "pending",
  observation: "connected",
  active: true,
  cancelRequested: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  deadlineAt: "2026-01-01T00:10:00.000Z",
  usage: null,
  error: null,
};

const memoryUpdate = {
  id: RUN_ID,
  agentId: AGENT_ID,
  trigger: "auto",
  status: "running",
  changed: [],
  errorCode: null,
  usage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
};

const message = {
  id: "55555555-5555-4555-8555-555555555555",
  conversationId: CONVERSATION_ID,
  participantId: "66666666-6666-4666-8666-666666666666",
  runId: RUN_ID,
  sequence: "1",
  role: "user",
  content: [{ index: 0, completed: true, type: "text", text: "hi" }],
  phase: null,
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeVault(readKey: unknown = { ok: true, key: KEY }): RuntimeCredentialVault {
  return {
    origin: ORIGIN,
    status: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    readKey: vi.fn(async () => readKey),
  } as unknown as RuntimeCredentialVault;
}

function makeCommands(
  fetchImpl: typeof fetch,
  vault: RuntimeCredentialVault = makeVault(),
  now?: () => number,
  timeoutMs?: number,
): RuntimeCommands {
  return createRuntimeCommands({
    vault,
    fetch: fetchImpl,
    ...(now ? { now } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

const sendCommand = {
  conversationId: CONVERSATION_ID,
  text: "hello",
  clientRequestId: CLIENT_REQUEST_ID,
};

describe("request shape", () => {
  it("posts to the fixed routes with static headers and JSON body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message, run }));
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await commands.sendMessage(sendCommand);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/conversations/${CONVERSATION_ID}/messages`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-OpenSquad-Runtime-Key": KEY,
    });
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "hello",
      clientRequestId: CLIENT_REQUEST_ID,
    });
  });

  it("posts cancel and reconcile to the run routes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ run }));
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await commands.cancelRun({ runId: RUN_ID });
    await commands.reconcileRun({ runId: RUN_ID });
    const urls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
      (call) => call[0],
    );
    expect(urls).toEqual([`${ORIGIN}/runs/${RUN_ID}/cancel`, `${ORIGIN}/runs/${RUN_ID}/reconcile`]);
  });

  it("posts refreshMemory to the fixed route with the runtime key and empty body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ update: memoryUpdate }, {}, 202));
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.refreshMemory({ agentId: AGENT_ID })).resolves.toEqual({
      update: memoryUpdate,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/agents/${AGENT_ID}/memory/refresh`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-OpenSquad-Runtime-Key": KEY,
    });
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("parses both an accepted running update and no work to do", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ update: memoryUpdate }, {}, 200))
      .mockResolvedValueOnce(jsonResponse({ update: null }, {}, 200));
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.refreshMemory({ agentId: AGENT_ID })).resolves.toEqual({
      update: memoryUpdate,
    });
    await expect(commands.refreshMemory({ agentId: AGENT_ID })).resolves.toEqual({ update: null });
  });

  it("preserves clientRequestId exactly", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message, run }));
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await commands.sendMessage({ ...sendCommand, clientRequestId: CLIENT_REQUEST_ID });
    const init = (
      fetchMock.mock.calls as unknown as [string, RequestInit][]
    )[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string).clientRequestId).toBe(CLIENT_REQUEST_ID);
  });
});

describe("credential admission", () => {
  it.each(["not-configured", "corrupt-storage", "origin-changed", "authentication-required"])(
    "fails before fetch when the vault reports %s",
    async (reason) => {
      const fetchMock = vi.fn();
      const commands = makeCommands(
        fetchMock as unknown as typeof fetch,
        makeVault({ ok: false, reason }),
      );
      await expect(commands.sendMessage(sendCommand)).rejects.toThrow(
        "runtime credential unavailable",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("validation", () => {
  it.each([
    { ...sendCommand, conversationId: "not-a-uuid" },
    { ...sendCommand, clientRequestId: "nope" },
    { ...sendCommand, text: "   " },
    { ...sendCommand, text: "x".repeat(20_001) },
    { ...sendCommand, extra: true },
  ])("rejects malformed sendMessage commands", async (command) => {
    const fetchMock = vi.fn();
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.sendMessage(command as never)).rejects.toThrow("invalid request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid refreshMemory agentId before fetch", async () => {
    const fetchMock = vi.fn();
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.refreshMemory({ agentId: "invalid" })).rejects.toThrow("invalid request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed run commands", async () => {
    const commands = makeCommands(vi.fn() as unknown as typeof fetch);
    await expect(commands.cancelRun({ runId: "bad" })).rejects.toThrow("invalid request");
    await expect(commands.reconcileRun({} as never)).rejects.toThrow("invalid request");
  });
});

describe("response handling", () => {
  it("requires the exact application/json media type", async () => {
    for (const contentType of ["text/plain", "application/jsonx", "application/json2"]) {
      const fetchMock = vi.fn(
        async () => new Response("{}", { headers: { "content-type": contentType } }),
      );
      const commands = makeCommands(fetchMock as unknown as typeof fetch);
      await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow("invalid response");
    }
    const ok = vi.fn(
      async () =>
        new Response(JSON.stringify({ run }), {
          headers: { "content-type": "Application/JSON; charset=utf-8" },
        }),
    );
    const commands = makeCommands(ok as unknown as typeof fetch);
    await expect(commands.cancelRun({ runId: RUN_ID })).resolves.toEqual({ run });
  });

  it.each([
    [400, "request rejected"],
    [401, "authentication required"],
    [403, "authentication required"],
    [404, "resource not found"],
    [409, "request conflict"],
    [429, "rate limited"],
    [500, "service unavailable"],
    [503, "service unavailable"],
  ])("maps HTTP %i to %s without leaking response details", async (status, message) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ detail: `${KEY} ${ORIGIN} denied` })),
        );
      },
      cancel,
    });
    const fetchMock = vi.fn(
      async () => new Response(stream, { status, headers: { "content-type": "application/json" } }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    const error: Error = await commands.cancelRun({ runId: RUN_ID }).then(
      () => {
        throw new Error("should have failed");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe(message);
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(ORIGIN);
    expect(cancel).toHaveBeenCalled();
  });

  it("hides provider diagnostics on non-2xx responses", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ error: `provider says ${KEY} at ${ORIGIN}` })),
        );
      },
      cancel,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    const error: Error = await commands.cancelRun({ runId: RUN_ID }).then(
      () => {
        throw new Error("should have failed");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe("service unavailable");
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(ORIGIN);
    expect(error.message).not.toContain("provider says");
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels the body on a wrong content type", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel,
    });
    const fetchMock = vi.fn(
      async () => new Response(stream, { headers: { "content-type": "text/plain" } }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow("invalid response");
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    { ...message, id: "not-a-uuid" },
    { ...message, participantId: "nope" },
    { ...message, createdAt: "yesterday" },
    { ...message, sequence: "01" },
    { ...message, sequence: "1.5" },
    { ...message, sequence: "9223372036854775808" },
    { ...message, content: [{ index: 1.5, completed: true, type: "text", text: "x" }] },
    { ...message, content: [{ index: 100, completed: true, type: "text", text: "x" }] },
    { ...message, content: [{ index: 0, completed: true, type: "image", url: "not a url" }] },
    {
      ...message,
      content: Array.from({ length: 101 }, (_, i) => ({
        index: i % 100,
        completed: true,
        type: "text",
        text: "x",
      })),
    },
  ])("rejects semantically malformed message payloads", async (badMessage) => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: badMessage, run }));
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.sendMessage(sendCommand)).rejects.toThrow("invalid response");
  });

  it.each([
    { ...run, id: "not-a-uuid" },
    { ...run, clientRequestId: "not-a-uuid" },
    { ...run, createdAt: "not a date" },
    { ...run, usage: { inputTokens: -1, outputTokens: 0 } },
    { ...run, usage: { inputTokens: 1.5, outputTokens: 0 } },
    { ...run, error: { code: "x".repeat(65), message: "m" } },
    { ...run, error: { code: "c", message: "" } },
    { ...run, error: { code: "c", message: "m".repeat(513) } },
  ])("rejects semantically malformed run payloads", async (badRun) => {
    const fetchMock = vi.fn(async () => jsonResponse({ run: badRun }));
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow("invalid response");
  });

  it.each([
    { ...memoryUpdate, id: "not-a-uuid" },
    { ...memoryUpdate, createdAt: "yesterday" },
    { ...memoryUpdate, status: "unknown" },
    { ...memoryUpdate, changed: [{ name: "profile", fromVersion: -1, toVersion: 1 }] },
    {
      ...memoryUpdate,
      changed: Array.from({ length: 4 }, () => ({ name: "notes", fromVersion: 0, toVersion: 1 })),
    },
    { ...memoryUpdate, errorCode: "x".repeat(65) },
    { ...memoryUpdate, usage: { inputTokens: -1, outputTokens: 0 } },
  ])("rejects malformed memory update responses", async (update) => {
    const fetchMock = vi.fn(async () => jsonResponse({ update }));
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.refreshMemory({ agentId: AGENT_ID })).rejects.toThrow("invalid response");
  });

  it("rejects a declared content-length over 1 MiB and cancels the body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          headers: {
            "content-type": "application/json",
            "content-length": String(1024 * 1024 + 1),
          },
        }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow("response too large");
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a streamed body over 1 MiB", async () => {
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const fetchMock = vi.fn(
      async () => new Response(big, { headers: { "content-type": "application/json" } }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow("response too large");
  });

  it("rejects malformed JSON and schema mismatches", async () => {
    const badJson = vi.fn(
      async () => new Response("{not json", { headers: { "content-type": "application/json" } }),
    );
    const commands = makeCommands(badJson as unknown as typeof fetch);
    await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow("invalid response");

    const badSchema = vi.fn(async () => jsonResponse({ run: { id: RUN_ID } }));
    const commands2 = makeCommands(badSchema as unknown as typeof fetch);
    await expect(commands2.cancelRun({ runId: RUN_ID })).rejects.toThrow("invalid response");
  });
});

describe("limits and aborts", () => {
  it("fails fast on a fifth concurrent command", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (init.signal?.aborted) return fail();
          init.signal?.addEventListener("abort", fail);
        }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    const pending = [
      commands.cancelRun({ runId: RUN_ID }),
      commands.cancelRun({ runId: RUN_ID }),
      commands.cancelRun({ runId: RUN_ID }),
      commands.cancelRun({ runId: RUN_ID }),
    ];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow(
      "too many active runtime commands",
    );
    commands.abortAll();
    for (const p of pending) await expect(p).rejects.toThrow("request aborted");
  });

  it("allows 60 commands per minute and rejects the 61st", async () => {
    let tick = 0;
    const fetchMock = vi.fn(async () => jsonResponse({ run }));
    const commands = makeCommands(fetchMock as unknown as typeof fetch, makeVault(), () => tick);
    for (let i = 0; i < 60; i += 1) {
      await commands.cancelRun({ runId: RUN_ID });
    }
    await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow(
      "runtime command rate limit exceeded",
    );
    tick += 61_000;
    await commands.cancelRun({ runId: RUN_ID });
  });

  it("aborts an in-flight request on the caller signal", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (init.signal?.aborted) return fail();
          init.signal?.addEventListener("abort", fail);
        }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    const caller = new AbortController();
    const pending = commands.cancelRun({ runId: RUN_ID }, caller.signal);
    caller.abort();
    await expect(pending).rejects.toThrow("request aborted");
  });

  it("abortAll aborts in-flight requests", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (init.signal?.aborted) return fail();
          init.signal?.addEventListener("abort", fail);
        }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    const pending = commands.cancelRun({ runId: RUN_ID });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    commands.abortAll();
    await expect(pending).rejects.toThrow("request aborted");
  });

  it("classifies a merged-signal timeout without retrying", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const fail = () => reject(new DOMException("timed out", "TimeoutError"));
          if (init.signal?.aborted) return fail();
          init.signal?.addEventListener("abort", fail);
        }),
    );
    const commands = makeCommands(fetchMock as unknown as typeof fetch, makeVault(), undefined, 5);
    await expect(commands.cancelRun({ runId: RUN_ID })).rejects.toThrow("request timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an explicit retry after timeout forwards the same clientRequestId", async () => {
    let calls = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_, reject) => {
          const fail = () => reject(new DOMException("timed out", "TimeoutError"));
          if (init.signal?.aborted) return fail();
          init.signal?.addEventListener("abort", fail);
        });
      }
      return Promise.resolve(jsonResponse({ message, run }));
    });
    const commands = makeCommands(fetchMock as unknown as typeof fetch, makeVault(), undefined, 5);
    await expect(commands.sendMessage(sendCommand)).rejects.toThrow("request timed out");
    await expect(commands.sendMessage(sendCommand)).resolves.toEqual({ message, run });
    const bodies = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map((call) =>
      JSON.parse(call[1].body as string),
    );
    expect(bodies).toEqual([
      { text: "hello", clientRequestId: CLIENT_REQUEST_ID },
      { text: "hello", clientRequestId: CLIENT_REQUEST_ID },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("error hygiene", () => {
  it("errors contain no key, body, url, or provider diagnostics", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`provider exploded: ${KEY} sent to ${ORIGIN}/runs`);
    });
    const commands = makeCommands(fetchMock as unknown as typeof fetch);
    const error: Error = await commands.cancelRun({ runId: RUN_ID }).then(
      () => {
        throw new Error("should have failed");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(ORIGIN);
    expect(error.message).not.toContain("provider exploded");
  });
});
