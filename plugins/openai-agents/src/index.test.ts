import { describe, expect, it, vi } from "vitest";
import { OpenAIAgentsProvider } from "./index.js";

const credentials = { apiKey: "test-key" };
const session = { provider: "openai-agents", externalId: "sess_123" };
const remoteSession = {
  id: session.externalId,
  agent: { model: "gpt-6-luna" },
  status: "idle",
  environment: { type: "openai_hosted", id: "env_123" },
};
const turn = {
  id: "turn_123",
  subagent_id: null as string | null,
  status: "completed",
  error: null as { code: string; message: string } | null,
  usage: { input_tokens: 10, output_tokens: 20 },
};
const message = {
  id: "msg_123",
  type: "message",
  turn_id: turn.id,
  role: "assistant",
  phase: "final_answer",
  status: "completed",
  content: [{ type: "output_text", text: "Done" }],
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sessionEvent(type: string, value = remoteSession) {
  return { type, event_id: `event_${type}`, session: value };
}

function turnEvent(type: string, value = turn) {
  return {
    type,
    event_id: `event_${type}_${value.id}`,
    session_id: session.externalId,
    turn_id: value.id,
    turn: value,
  };
}

function outputEvent(type: string, payload: Record<string, unknown>) {
  return {
    type,
    event_id: `event_${type}`,
    session_id: session.externalId,
    turn_id: turn.id,
    output_index: 0,
    ...payload,
  };
}

function sse(events: unknown[]) {
  return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, runtime: new OpenAIAgentsProvider({ fetch }) };
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

describe("OpenAIAgentsProvider", () => {
  it("creates an idle hosted session without starting work or storing the caller's key", async () => {
    const { runtime, fetch } = setup();
    expect(runtime.features.environmentless).toBe(true);
    fetch.mockResolvedValue(json(remoteSession));
    expect(await runtime.createSession({ instructions: "Be helpful" }, credentials)).toEqual({
      ...session,
      model: "gpt-6-luna",
      status: "idle",
      environmentExternalId: "env_123",
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.openai.com/v1/agents/sessions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(new Headers(init?.headers).get("openai-beta")).toBe("agents=v1");
    expect(JSON.parse(String(init?.body))).toEqual({
      agent: { model: "gpt-6-luna", instructions: "Be helpful" },
      environment: { type: "openai_hosted" },
    });
    expect(JSON.stringify(runtime)).not.toContain(credentials.apiKey);
  });

  it("creates an environmentless session with its first user input", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      json({ ...remoteSession, environment: { type: "none" } }),
    );

    expect(
      await runtime.createSession(
        { instructions: "Be helpful", environment: "none", input: "Hi" },
        credentials,
      ),
    ).toMatchObject({ environmentExternalId: null });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      agent: { model: "gpt-6-luna", instructions: "Be helpful" },
      environment: { type: "none" },
      input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
    });
  });

  it.each([
    { instructions: "Be helpful", environment: "none" as const },
    { instructions: "Be helpful", environment: "none" as const, input: "  " },
    { instructions: "Be helpful", environment: "hosted" as const, input: "Hi" },
  ])("rejects invalid environment input before making a request: %j", async (options) => {
    const { runtime, fetch } = setup();
    await expect(runtime.createSession(options, credentials)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps explicit model, bounded subagents, and authorized MCP tool allowlists", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(json(remoteSession));
    await runtime.createSession(
      {
        model: "another-openai-model",
        instructions: "Research",
        maxConcurrentSubagents: 2,
        mcpServers: [
          { name: "docs", url: "https://developers.openai.com/mcp", allowedTools: ["search"] },
        ],
      },
      { ...credentials, mcp: { docs: { authorization: "Bearer mcp-test" } } },
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      agent: {
        model: "another-openai-model",
        instructions: "Research",
        multi_agent: { enabled: true, max_concurrent_subagents: 2 },
        tools: [
          {
            type: "mcp",
            server_label: "docs",
            transport: {
              type: "http",
              server_url: "https://developers.openai.com/mcp",
              authorization: "Bearer mcp-test",
            },
            allowed_tools: ["search"],
            required: true,
          },
        ],
      },
      environment: { type: "openai_hosted" },
    });
  });

  it("uses fresh credentials on each request and never falls back to an environment key", async () => {
    const { runtime, fetch } = setup();
    fetch.mockImplementation(async () => json(remoteSession));
    await runtime.retrieveSession(session, { apiKey: "user-a" });
    await runtime.retrieveSession(session, { apiKey: "user-b" });
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
    ).toEqual(["Bearer user-a", "Bearer user-b"]);
    await expect(runtime.retrieveSession(session, { apiKey: " " })).rejects.toThrow("API key");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("subscribes before returning, then sends input and normalizes root and subagent outcomes", async () => {
    const { runtime, fetch } = setup();
    fetch
      .mockResolvedValueOnce(
        sse([
          sessionEvent("agent.session.idle"),
          turnEvent("agent.session.turn.completed", {
            ...turn,
            id: "turn_child",
            subagent_id: "sub_123",
          }),
          outputEvent("agent.session.turn.output_text.delta", {
            item_id: message.id,
            content_index: 0,
            delta: "Do",
          }),
          outputEvent("agent.session.turn.output_text.done", {
            item_id: message.id,
            content_index: 0,
            text: "Done",
          }),
          outputEvent("agent.session.turn.item.done", { item: message }),
          turnEvent("agent.session.turn.completed"),
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const stream = await runtime.events(session, credentials);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.openai.com/v1/agents/sessions/sess_123/events?stream=true",
    );
    await runtime.sendInput(session, "Hello", credentials);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      events: [
        {
          type: "agent.session.input.message",
          input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
        },
      ],
    });
    const events = await collect(stream);
    expect(events.map((e) => e.type)).toEqual([
      "session.status",
      "turn.status",
      "message.delta",
      "message.text.completed",
      "message.completed",
      "turn.status",
    ]);
    expect(events[1]).toMatchObject({
      turn: { subagentExternalId: "sub_123", status: "succeeded" },
    });
    expect(events[3]).toMatchObject({ itemExternalId: message.id, contentIndex: 0, text: "Done" });
    expect(events[4]).toMatchObject({
      message: { phase: "final", content: [{ type: "text", text: "Done" }] },
    });
    expect(events[5]).toMatchObject({
      turn: {
        subagentExternalId: null,
        status: "succeeded",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    });
  });

  it.each(["failed", "cancelled"])(
    "preserves %s turn outcomes rather than reporting success",
    async (status) => {
      const { runtime, fetch } = setup();
      fetch.mockResolvedValue(
        sse([turnEvent(`agent.session.turn.${status}`, { ...turn, status })]),
      );
      const events = await collect(await runtime.events(session, credentials));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "turn.status", turn: { status } });
    },
  );

  it("does not mistake idle, unknown events, or a disconnected stream for completion", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      sse([
        { type: "agent.session.future_event", event_id: "event_future" },
        sessionEvent("agent.session.idle"),
      ]),
    );
    await expect(collect(await runtime.events(session, credentials))).rejects.toThrow(
      "Stream closed",
    );
  });

  it("reports environment failure without waiting forever", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      sse([
        {
          type: "agent.session.environment.failed",
          event_id: "event_environment_failed",
          session_id: session.externalId,
          turn_id: null,
          environment: {
            id: "env_123",
            type: "openai_hosted",
            status: "failed",
            error: {
              type: "environment_error",
              code: "sandbox_error",
              message: "synthetic-secret-marker",
            },
          },
        },
      ]),
    );
    expect(await collect(await runtime.events(session, credentials))).toEqual([
      expect.objectContaining({
        type: "runtime.error",
        code: "sandbox_error",
        message: "Environment failed",
      }),
    ]);
  });

  it("closes the HTTP stream when the consumer stops without cancelling remote work", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(sse([sessionEvent("agent.session.idle")]));
    const stream = await runtime.events(session, credentials);
    for await (const _event of stream) break;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("can close a subscription before iteration starts", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(sse([]));
    const stream = await runtime.events(session, credentials);
    stream.close();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("retrieves all message pages and ignores non-message items", async () => {
    const { runtime, fetch } = setup();
    fetch
      .mockResolvedValueOnce(
        json({
          data: [message, { id: "tool_123", type: "mcp_call" }],
          has_more: true,
          last_id: "tool_123",
        }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ ...message, id: "msg_456" }], has_more: false, last_id: "msg_456" }),
      );
    const messages = await collect(runtime.listMessages(session, credentials));
    expect(messages.map((m) => m.externalId)).toEqual(["msg_123", "msg_456"]);
    const url = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(url.searchParams.get("after")).toBe("tool_123");
    expect(url.searchParams.get("order")).toBe("asc");
  });

  it("retrieves saved turn outcomes for recovery", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(json({ data: [turn], has_more: false, last_id: turn.id }));
    expect(await collect(runtime.listTurns(session, credentials))).toEqual([
      {
        externalId: turn.id,
        subagentExternalId: null,
        status: "succeeded",
        usage: { inputTokens: 10, outputTokens: 20 },
        error: null,
      },
    ]);
  });

  it("rejects a broken pagination cursor rather than looping or silently losing history", async () => {
    const { runtime, fetch } = setup();
    fetch.mockImplementation(async () =>
      json({ data: [message], has_more: true, last_id: message.id }),
    );
    await expect(collect(runtime.listMessages(session, credentials))).rejects.toThrow("pagination");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("separates cancellation from session deletion", async () => {
    const { runtime, fetch } = setup();
    fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json({ id: session.externalId, deleted: true, object: "agent.session.deleted" }),
      );
    await runtime.cancel(session, credentials);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      events: [{ type: "agent.session.input.cancel" }],
    });
    await runtime.destroySession(session, credentials);
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("rejects provider mismatch and invalid configuration before making requests", async () => {
    const { runtime, fetch } = setup();
    await expect(
      runtime.retrieveSession({ ...session, provider: "other" }, credentials),
    ).rejects.toThrow("provider");
    await expect(
      runtime.createSession({ instructions: "", maxConcurrentSubagents: 0 }, credentials),
    ).rejects.toThrow();
    await expect(
      runtime.createSession(
        {
          instructions: "",
          mcpServers: [{ name: "tools", url: "http://localhost/mcp", allowedTools: ["read"] }],
        },
        credentials,
      ),
    ).rejects.toThrow();
    await expect(
      runtime.createSession(
        {
          instructions: "",
          mcpServers: [{ name: "tools", url: "https://example.com/mcp", allowedTools: [] }],
        },
        credentials,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry a failed mutation or expose the provider response body", async () => {
    const { runtime, fetch } = setup();
    fetch.mockImplementation(async () =>
      json({ error: { message: "sensitive upstream detail" } }, 500),
    );
    await expect(runtime.sendInput(session, "Hello", credentials)).rejects.toThrow("HTTP 500");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors a configured default model", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(remoteSession));
    const runtime = new OpenAIAgentsProvider({ fetch, defaultModel: "configured-model" });
    await runtime.createSession({ instructions: "" }, credentials);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).agent.model).toBe("configured-model");
  });

  it("keeps MCP credentials from overriding the validated destination", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(json(remoteSession));
    const mcpCredentials = {
      authorization: "Bearer test-mcp",
      server_url: "https://other.example.com",
    };
    await runtime.createSession(
      {
        instructions: "",
        mcpServers: [
          { name: "docs", url: "https://developers.openai.com/mcp", allowedTools: ["search"] },
        ],
      },
      { ...credentials, mcp: { docs: mcpCredentials } },
    );
    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).agent.tools[0].transport.server_url,
    ).toBe("https://developers.openai.com/mcp");
  });

  it.each([".", "..", "../other", "", "sess_123?query"])(
    "rejects unsafe session ID %s",
    async (externalId) => {
      const { runtime, fetch } = setup();
      fetch.mockResolvedValue(new Response(null, { status: 204 }));
      await expect(runtime.destroySession({ ...session, externalId }, credentials)).rejects.toThrow(
        "Session ID",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a session response belonging to a different session", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(json({ ...remoteSession, id: "other_session" }));
    await expect(runtime.retrieveSession(session, credentials)).rejects.toThrow(
      "Session ID mismatch",
    );
  });

  it("rejects events for a different session and closes the subscription", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      sse([{ ...turnEvent("agent.session.turn.completed"), session_id: "other_session" }]),
    );
    await expect(collect(await runtime.events(session, credentials))).rejects.toThrow(
      "Event session mismatch",
    );
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("surfaces stream API errors without exposing the response body", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      sse([
        {
          type: "error",
          event_id: "event_error",
          session_id: session.externalId,
          error: {
            code: "server_error",
            message: "sensitive upstream detail",
            param: null,
            type: "server_error",
          },
        },
      ]),
    );
    await expect(collect(await runtime.events(session, credentials))).rejects.toThrow(
      /^openai-agents: Request failed$/,
    );
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("forwards caller cancellation to the subscription", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(sse([]));
    const controller = new AbortController();
    const stream = await runtime.events(session, credentials, { signal: controller.signal });
    controller.abort();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    stream.close();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes documented session lifecycle envelopes and stops on failure", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      sse([
        sessionEvent("agent.session.created"),
        sessionEvent("agent.session.in_progress", { ...remoteSession, status: "in_progress" }),
        sessionEvent("agent.session.requires_action", {
          ...remoteSession,
          status: "requires_action",
        }),
        sessionEvent("agent.session.idle"),
        sessionEvent("agent.session.failed", { ...remoteSession, status: "failed" }),
      ]),
    );
    expect(await collect(await runtime.events(session, credentials))).toEqual(
      ["idle", "running", "waiting", "idle", "failed"].map((status) =>
        expect.objectContaining({
          type: "session.status",
          status,
          sessionExternalId: session.externalId,
        }),
      ),
    );
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("ignores subagent lifecycle events without top-level session IDs until the root ends", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      sse([
        ...["created", "active", "closed"].map((state) => ({
          type: `agent.session.subagent.${state}`,
          event_id: `event_subagent_${state}`,
          subagent: {
            id: "sub_123",
            object: "agent.session.subagent",
            session_id: session.externalId,
            parent_agent_id: "agent_123",
            name: null,
            instructions: null,
            opened_at: 0,
            closed_at: state === "closed" ? 1 : null,
            status: state === "closed" ? "closed" : "active",
          },
        })),
        turnEvent("agent.session.turn.completed"),
      ]),
    );
    expect(await collect(await runtime.events(session, credentials))).toEqual([
      expect.objectContaining({ type: "turn.status", turnExternalId: turn.id }),
    ]);
  });

  it("checks the nested session ID on lifecycle events", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(
      sse([sessionEvent("agent.session.idle", { ...remoteSession, id: "other_session" })]),
    );
    await expect(collect(await runtime.events(session, credentials))).rejects.toThrow(
      "Event session mismatch",
    );
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each(["rate_limit_exceeded", "synthetic-secret-marker"])(
    "sanitizes diagnostic code %s in both streamed and saved failed turns",
    async (code) => {
      const { runtime, fetch } = setup();
      const failedTurn = {
        ...turn,
        status: "failed",
        error: { code, message: "synthetic-secret-marker" },
      };
      fetch
        .mockResolvedValueOnce(sse([turnEvent("agent.session.turn.failed", failedTurn)]))
        .mockResolvedValueOnce(json({ data: [failedTurn], has_more: false, last_id: turn.id }));
      const events = await collect(await runtime.events(session, credentials));
      const turns = await collect(runtime.listTurns(session, credentials));
      const error =
        code === "rate_limit_exceeded"
          ? { code, message: "The request rate limit was exceeded" }
          : { code: null, message: "Agent runtime failed" };
      expect(events).toEqual([
        expect.objectContaining({ turn: expect.objectContaining({ error }) }),
      ]);
      expect(turns).toEqual([expect.objectContaining({ error })]);
      expect(JSON.stringify({ events, turns })).not.toContain("synthetic-secret-marker");
    },
  );

  it("rejects malformed provider responses", async () => {
    const { runtime, fetch } = setup();
    fetch.mockResolvedValue(json({ id: "sess_bad" }));
    await expect(runtime.createSession({ instructions: "" }, credentials)).rejects.toThrow(
      "Invalid Agents API response",
    );
  });
});
