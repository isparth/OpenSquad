import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIAgentsProvider } from "./index.js";

const credentials = { apiKey: "synthetic-caller-key" };
const session = { provider: "openai-agents", externalId: "sess_transport" };
const remoteSession = {
  id: session.externalId,
  status: "idle",
  agent: { model: "gpt-6-luna" },
  environment: { type: "openai_hosted", id: "env_transport" },
};

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, runtime: new OpenAIAgentsProvider({ fetch }) };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pendingBody(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
    cancel,
  });
  return { body, cancel, fail: (error: Error) => controller.error(error) };
}

async function collect(items: AsyncIterable<unknown>) {
  const result = [];
  for await (const item of items) result.push(item);
  return result;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("OpenAI Agents transport isolation", () => {
  it("discards all ambient custom headers without changing the process environment", async () => {
    const customHeaders = [
      "Authorization: Bearer synthetic-ambient-key",
      "OpenAI-Organization: ambient-org",
      "OpenAI-Project: ambient-project",
      "OpenAI-Beta: wrong-api",
      "Host: other.example.com",
      "X-Forwarded-Host: other.example.com",
      "X-Ambient-Routing: other-tenant",
      "Content-Type: multipart/form-data",
    ].join("\n");
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", customHeaders);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-env-key");
    vi.stubEnv("OPENAI_ORG_ID", "ambient-org");
    vi.stubEnv("OPENAI_PROJECT_ID", "ambient-project");
    vi.stubEnv("OPENAI_BASE_URL", "https://other.example.com/v1");
    const { runtime, fetch } = setup();
    fetch.mockImplementation(async () => {
      expect(process.env.OPENAI_CUSTOM_HEADERS).toBe(customHeaders);
      return json(remoteSession);
    });
    await Promise.all([
      runtime.createSession({ instructions: "Hello" }, credentials),
      runtime.createSession({ instructions: "Hello" }, { apiKey: "synthetic-second-key" }),
    ]);
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
    ).toEqual(["Bearer synthetic-caller-key", "Bearer synthetic-second-key"]);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toBe("https://api.openai.com/v1/agents/sessions");
      const headers = new Headers(init?.headers);
      expect(headers.get("openai-beta")).toBe("agents=v1");
      expect(headers.get("content-type")).toBe("application/json");
      for (const name of [
        "openai-organization",
        "openai-project",
        "host",
        "x-forwarded-host",
        "x-ambient-routing",
      ]) {
        expect(headers.has(name)).toBe(false);
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({ agent: { instructions: "Hello" } });
    }
    expect(process.env.OPENAI_CUSTOM_HEADERS).toBe(customHeaders);
  });

  it("forbids redirects for credential-bearing JSON and never retries", async () => {
    const { runtime, fetch } = setup();
    fetch.mockImplementation(async (_url, init) => {
      if (init?.redirect === "error") throw new TypeError("synthetic redirect rejected");
      return json(remoteSession);
    });
    await expect(
      runtime.createSession(
        {
          instructions: "Hello",
          mcpServers: [
            { name: "tools", url: "https://tools.example.com/mcp", allowedTools: ["read"] },
          ],
        },
        {
          ...credentials,
          mcp: { tools: { authorization: "Bearer synthetic-mcp-secret" } },
        },
      ),
    ).rejects.toThrow(/^openai-agents: Request failed/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/agents/sessions");
  });
});

describe("OpenAI Agents stream transport", () => {
  it("requests the SSE representation explicitly", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(new Response("", { headers: { "content-type": "text/event-stream" } }));
    const stream = await runtime.events(session, credentials);
    try {
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("accept")).toBe(
        "text/event-stream",
      );
    } finally {
      stream.close();
    }
  });

  it.each([
    ["JSON", () => json({ events: [] })],
    [
      "HTML",
      () => new Response("<html>synthetic</html>", { headers: { "content-type": "text/html" } }),
    ],
    ["missing content type", () => new Response(new Uint8Array())],
    [
      "bodyless SSE",
      () => new Response(null, { headers: { "content-type": "text/event-stream" } }),
    ],
    [
      "204 SSE",
      () => new Response(null, { status: 204, headers: { "content-type": "text/event-stream" } }),
    ],
  ] as const)("rejects %s before resolving the subscription", async (_name, response) => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(response());
    await expect(runtime.events(session, credentials)).rejects.toThrow(
      "Invalid event stream response",
    );
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an invalid response body without waiting for its contents", async () => {
    const { runtime, fetch } = setup();
    const pending = pendingBody();
    fetch.mockResolvedValue(
      new Response(pending.body, { headers: { "content-type": "text/html" } }),
    );
    await expect(runtime.events(session, credentials)).rejects.toThrow(
      "Invalid event stream response",
    );
    expect(pending.cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts SSE media type parameters and nested session events", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      new Response(
        `data: ${JSON.stringify({
          type: "agent.session.failed",
          event_id: "evt_failed",
          session: { id: session.externalId, status: "failed" },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      ),
    );
    expect(await collect(await runtime.events(session, credentials))).toEqual([
      expect.objectContaining({ type: "session.status", status: "failed" }),
    ]);
  });

  it("rejects malformed SSE JSON with a sanitized error", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      new Response("data: synthetic-secret-invalid-json\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await expect(collect(await runtime.events(session, credentials))).rejects.toThrow(
      /^openai-agents: Request failed or was aborted$/,
    );
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("reports an unexpected response-body AbortError as disconnection", async () => {
    const { runtime, fetch } = setup();
    const pending = pendingBody();
    fetch.mockResolvedValue(
      new Response(pending.body, { headers: { "content-type": "text/event-stream" } }),
    );
    const stream = await runtime.events(session, credentials);
    pending.fail(new DOMException("synthetic body failure", "AbortError"));
    await expect(collect(stream)).rejects.toThrow("Stream closed before a root turn ended");
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "caller abort"])(
    "treats explicit %s as local shutdown only",
    async (action) => {
      const { runtime, fetch } = setup();
      fetch.mockImplementation(
        async (_url, init) =>
          new Response(pendingBody(init?.signal).body, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const caller = new AbortController();
      const stream = await runtime.events(session, credentials, { signal: caller.signal });
      const result = collect(stream);
      if (action === "close") stream.close();
      else caller.abort();
      await expect(result).resolves.toEqual([]);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("OpenAI Agents complete-operation deadline", () => {
  it.each([200, 500])(
    "bounds a stalled HTTP %s body and cleans up the deadline",
    async (status) => {
      vi.useFakeTimers();
      const { runtime, fetch } = setup();
      fetch.mockImplementation(
        async (_url, init) =>
          new Response(pendingBody(init?.signal).body, {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      let outcome: unknown;
      const result = runtime.retrieveSession(session, credentials).then(
        () => {
          outcome = "resolved";
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toContain("openai-agents:");
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a stalled error body while opening a subscription", async () => {
    vi.useFakeTimers();
    const { runtime, fetch } = setup();
    fetch.mockImplementation(
      async (_url, init) =>
        new Response(pendingBody(init?.signal).body, {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = expect(runtime.events(session, credentials)).rejects.toThrow(/^openai-agents:/);
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one deadline across response headers and the complete body", async () => {
    vi.useFakeTimers();
    const { runtime, fetch } = setup();
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(pendingBody(init?.signal).body, {
                  status: 500,
                  headers: { "content-type": "application/json" },
                }),
              ),
            45_000,
          );
        }),
    );
    let failed = false;
    const result = runtime.retrieveSession(session, credentials).catch(() => {
      failed = true;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(failed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toBe(true);
    await result;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already-cancelled call without a request or leaked timer", async () => {
    vi.useFakeTimers();
    const { runtime, fetch } = setup();
    const caller = new AbortController();
    caller.abort(new Error("openai-agents: synthetic-private-abort-reason"));
    await expect(
      runtime.retrieveSession(session, credentials, { signal: caller.signal }),
    ).rejects.toThrow(/^openai-agents: Request failed or was aborted$/);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps concurrent callers' cancellation signals independent", async () => {
    vi.useFakeTimers();
    const { runtime, fetch } = setup();
    fetch.mockImplementation(
      async (_url, init) =>
        new Response(pendingBody(init?.signal).body, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const first = new AbortController();
    const second = new AbortController();
    const firstResult = expect(
      runtime.retrieveSession(session, credentials, { signal: first.signal }),
    ).rejects.toThrow(/^openai-agents:/);
    const secondResult = expect(
      runtime.retrieveSession(session, credentials, { signal: second.signal }),
    ).rejects.toThrow(/^openai-agents:/);
    await vi.advanceTimersByTimeAsync(0);
    first.abort();
    await firstResult;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    second.abort();
    await secondResult;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation while reading an error body", async () => {
    vi.useFakeTimers();
    const { runtime, fetch } = setup();
    fetch.mockImplementation(
      async (_url, init) =>
        new Response(pendingBody(init?.signal).body, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const caller = new AbortController();
    const result = expect(
      runtime.retrieveSession(session, credentials, { signal: caller.signal }),
    ).rejects.toThrow(/^openai-agents:/);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(new Error("synthetic-private-abort-reason"));
    await result;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after success without expiring an open subscription", async () => {
    vi.useFakeTimers();
    const { runtime, fetch } = setup();
    fetch.mockResolvedValueOnce(json(remoteSession));
    await runtime.retrieveSession(session, credentials);
    expect(vi.getTimerCount()).toBe(0);
    fetch.mockImplementation(
      async (_url, init) =>
        new Response(pendingBody(init?.signal).body, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const stream = await runtime.events(session, credentials);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    stream.close();
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe("OpenAI Agents artifact downloads", () => {
  it("reads raw bytes through the isolated SDK request", async () => {
    const { runtime, fetch } = setup();
    const bytes = Buffer.from("fruit,price\napple,1\n");
    fetch.mockResolvedValueOnce(
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
    );

    const result = await runtime.readArtifact(session, "artifact_123", credentials, {
      maxBytes: 1024,
    });

    expect(Buffer.from(result)).toEqual(bytes);
    const [url, init] = fetch.mock.calls[0] ?? [];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe(
      "/v1/agents/sessions/sess_transport/artifacts/artifact_123/content",
    );
    expect(parsed.searchParams.get("session_id")).toBe(session.externalId);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-caller-key");
    expect(init?.redirect).toBe("error");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an advertised content length over maxBytes before reading", async () => {
    const { runtime, fetch } = setup();
    let cancelled: ReturnType<typeof vi.fn> | undefined;
    fetch.mockImplementationOnce(async (_url, init) => {
      const body = pendingBody(init?.signal);
      cancelled = body.cancel;
      return new Response(body.body, { headers: { "content-length": "11" } });
    });

    await expect(
      runtime.readArtifact(session, "artifact_123", credentials, { maxBytes: 10 }),
    ).rejects.toThrow("openai-agents: Artifact exceeds size limit");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("aborts a streamed artifact once its bytes exceed maxBytes", async () => {
    const { runtime, fetch } = setup();
    const cancelled = vi.fn();
    fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(6));
            controller.enqueue(new Uint8Array(6));
          },
          cancel: cancelled,
        }),
      ),
    );

    await expect(
      runtime.readArtifact(session, "artifact_123", credentials, { maxBytes: 10 }),
    ).rejects.toThrow("openai-agents: Artifact exceeds size limit");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("uses only explicit credentials, rejects redirects, and validates artifact IDs", async () => {
    const ambient = [
      "Authorization: Bearer ambient-key",
      "OpenAI-Organization: ambient-org",
      "X-Tenant: ambient",
    ].join("\n");
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", ambient);
    vi.stubEnv("OPENAI_API_KEY", "ambient-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://outside.example/v1");
    const { runtime, fetch } = setup();
    fetch.mockImplementation(async (_url, init) => {
      if (init?.redirect === "error") throw new TypeError("synthetic redirect rejected");
      return new Response("bytes");
    });
    await expect(
      runtime.readArtifact(session, "../artifact", credentials, { maxBytes: 100 }),
    ).rejects.toThrow("openai-agents: Invalid Artifact ID");
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      runtime.readArtifact(session, "artifact_123", credentials, { maxBytes: 100 }),
    ).rejects.toThrow(/^openai-agents: Request failed/);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.openai.com/v1/");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-caller-key");
    expect(headers.has("openai-organization")).toBe(false);
    expect(headers.has("x-tenant")).toBe(false);
    expect(init?.redirect).toBe("error");
  });

  it("bounds the complete artifact body download at 120 seconds", async () => {
    vi.useFakeTimers();
    const { runtime, fetch } = setup();
    fetch.mockImplementation(
      async (_url, init) =>
        new Response(pendingBody(init?.signal).body, {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const result = runtime.readArtifact(session, "artifact_123", credentials, { maxBytes: 100 });
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toThrow(/^openai-agents:/);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
