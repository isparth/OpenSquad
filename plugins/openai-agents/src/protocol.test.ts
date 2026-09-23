import { describe, expect, it } from "vitest";
import {
  isTerminal,
  normalizeEvent,
  normalizeMessage,
  normalizeSession,
  normalizeTurn,
} from "./protocol.js";

const session = {
  id: "sess_123",
  agent: { model: "gpt-6-luna" },
  status: "idle",
  environment: { type: "openai_hosted", id: "env_123" },
};
const turn = {
  id: "turn_root",
  agent_id: "agent_123",
  session_id: session.id,
  object: "agent.session.turn",
  created_at: 1,
  started_at: null,
  completed_at: null,
  subagent_id: null,
  status: "queued",
  error: null,
  usage: null,
};
const secret = "synthetic-secret-marker";

function turnEvent(value: Record<string, unknown>, type = "agent.session.turn.failed") {
  return { type, event_id: "event_turn", session_id: session.id, turn_id: value.id, turn: value };
}

function environmentEvent(error: unknown) {
  return {
    type: "agent.session.environment.failed",
    event_id: "event_environment",
    session_id: session.id,
    turn_id: null,
    environment: { id: "env_123", type: "openai_hosted", status: "failed", error },
  };
}

function invalid(action: () => unknown) {
  expect(action).toThrow(/^openai-agents: Invalid Agents API response$/);
}

describe("Agents protocol", () => {
  it.each([
    ["created", "idle", "idle"],
    ["idle", "idle", "idle"],
    ["in_progress", "in_progress", "running"],
    ["requires_action", "requires_action", "waiting"],
    ["failed", "failed", "failed"],
  ])("normalizes session %s using only its documented nested ID", (suffix, status, normalized) => {
    const event = normalizeEvent({
      type: `agent.session.${suffix}`,
      event_id: "event_session",
      session: { ...session, status, error: secret },
    });
    expect(event).toEqual({
      type: "session.status",
      externalId: "event_session",
      sessionExternalId: session.id,
      turnExternalId: null,
      status: normalized,
    });
    expect(event && isTerminal(event)).toBe(status === "failed");
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("does not trust extraneous top-level IDs over a lifecycle session ID", () => {
    expect(
      normalizeEvent({
        type: "agent.session.idle",
        event_id: "event_session",
        session_id: "wrong_session",
        turn_id: "wrong_turn",
        session,
      }),
    ).toMatchObject({ sessionExternalId: session.id, turnExternalId: null });
  });

  it.each(["created", "active", "closed"])(
    "ignores unsupported subagent %s envelopes",
    (suffix) => {
      expect(
        normalizeEvent({
          type: `agent.session.subagent.${suffix}`,
          event_id: "event_subagent",
          subagent: {
            id: "sub_123",
            object: "agent.session.subagent",
            session_id: session.id,
            parent_agent_id: "agent_123",
            name: null,
            instructions: null,
            opened_at: 0,
            closed_at: suffix === "closed" ? 1 : null,
            status: suffix === "closed" ? "closed" : "active",
          },
        }),
      ).toBeNull();
    },
  );

  it("ignores future event families without requiring any known envelope", () => {
    expect(normalizeEvent({ type: "agent.future", payload: { value: secret } })).toBeNull();
  });

  it("leaves top-level error events to the SDK transport", () => {
    expect(
      normalizeEvent({
        type: "error",
        event_id: "event_error",
        session_id: session.id,
        error: { code: secret, message: secret, param: null, type: "server_error" },
      }),
    ).toBeNull();
  });

  it.each([
    ["queued", "pending"],
    ["in_progress", "running"],
    ["waiting", "waiting"],
    ["completed", "succeeded"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ])("normalizes saved %s turns with nullable usage", (status, normalized) => {
    expect(normalizeTurn({ ...turn, status })).toEqual({
      externalId: turn.id,
      subagentExternalId: null,
      status: normalized,
      usage: null,
      error: null,
    });
  });

  it.each(["completed", "failed", "cancelled"])("does not terminate on subagent %s", (status) => {
    const root = normalizeEvent(turnEvent({ ...turn, status }, `agent.session.turn.${status}`));
    const child = normalizeEvent(
      turnEvent(
        { ...turn, id: "turn_child", subagent_id: "sub_123", status },
        `agent.session.turn.${status}`,
      ),
    );
    expect(root && isTerminal(root)).toBe(true);
    expect(child && isTerminal(child)).toBe(false);
    expect(child).toMatchObject({
      turnExternalId: "turn_child",
      turn: { subagentExternalId: "sub_123" },
    });
  });

  it("prefers terminal event usage over a null embedded turn usage", () => {
    const event = normalizeEvent({
      ...turnEvent({ ...turn, status: "completed" }, "agent.session.turn.completed"),
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
    expect(event).toMatchObject({
      type: "turn.status",
      turn: { usage: { inputTokens: 10, outputTokens: 20 } },
    });
  });

  it("falls back to embedded turn usage when the event carries none", () => {
    const event = normalizeEvent(
      turnEvent(
        { ...turn, status: "completed", usage: { input_tokens: 3, output_tokens: 4 } },
        "agent.session.turn.completed",
      ),
    );
    expect(event).toMatchObject({
      turn: { usage: { inputTokens: 3, outputTokens: 4 } },
    });
  });

  it("lets terminal event usage win when both are present", () => {
    const event = normalizeEvent({
      ...turnEvent(
        {
          ...turn,
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 4 },
        },
        "agent.session.turn.completed",
      ),
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(event).toMatchObject({
      turn: { usage: { inputTokens: 10, outputTokens: 20 } },
    });
  });

  it("keeps usage null when neither the event nor the turn reports it", () => {
    const event = normalizeEvent({
      ...turnEvent({ ...turn, status: "completed" }, "agent.session.turn.completed"),
      usage: null,
    });
    expect(event).toMatchObject({ turn: { usage: null } });
  });

  it("normalizes legacy user messages with text and images", () => {
    expect(
      normalizeMessage({
        id: null,
        type: "message",
        turn_id: turn.id,
        role: "user",
        phase: null,
        status: "completed",
        content: [
          { type: "input_text", text: "Describe this image" },
          { type: "input_image", image_url: "data:image/png;base64,cGl4ZWw=" },
        ],
      }),
    ).toEqual({
      externalId: null,
      turnExternalId: turn.id,
      role: "user",
      phase: null,
      status: "completed",
      content: [
        { type: "text", text: "Describe this image" },
        { type: "image", url: "data:image/png;base64,cGl4ZWw=" },
      ],
    });
  });

  it.each([
    ["context_length_exceeded", "The model context limit was exceeded"],
    ["session_budget_exceeded", "The session usage budget was exceeded"],
    ["usage_limit_exceeded", "The account usage limit was exceeded"],
    ["credit_balance_exhausted", "The account has no API credits remaining"],
    ["rate_limit_exceeded", "The request rate limit was exceeded"],
    ["server_overloaded", "The model service is temporarily overloaded"],
    ["cyber_policy", "The request was rejected by a safety policy"],
    ["connection_failed", "The model service connection failed"],
    ["server_error", "The model service encountered an error"],
    ["authentication_error", "The API credentials are invalid or lack access"],
    ["invalid_request", "The request input or configuration is invalid"],
    ["resource_not_found", "The requested model or resource is unavailable"],
    ["sandbox_error", "Environment failed"],
    ["executor_version_incompatible", "The environment executor must be upgraded"],
    ["active_turn_not_steerable", "The active turn cannot accept additional input"],
    ["request_timeout", "The model service request timed out"],
    ["internal_error", "The runtime encountered an internal error"],
  ])("maps documented diagnostic %s to static text everywhere", (code, message) => {
    const failed = { ...turn, status: "failed", error: { code, message: secret } };
    const saved = normalizeTurn(failed);
    const event = normalizeEvent(turnEvent(failed));
    const environment = normalizeEvent(environmentEvent({ code, message: secret, type: secret }));
    expect(saved.error).toEqual({ code, message });
    expect(event).toMatchObject({ turn: { error: { code, message } } });
    expect(environment).toMatchObject({ type: "runtime.error", code, message });
    expect(JSON.stringify({ saved, event, environment })).not.toContain(secret);
  });

  it.each([secret, "constructor", "__proto__", "toString", ""])(
    "replaces unrecognized diagnostic code %s with a safe fallback",
    (code) => {
      const error = { code, message: secret };
      const failed = { ...turn, status: "failed", error };
      const expected = { code: null, message: "Agent runtime failed" };
      const saved = normalizeTurn(failed);
      const event = normalizeEvent(turnEvent(failed));
      const environment = normalizeEvent(environmentEvent(error));
      expect(saved.error).toEqual(expected);
      expect(event).toMatchObject({ turn: { error: expected } });
      expect(environment).toMatchObject({ type: "runtime.error", ...expected });
      expect(JSON.stringify({ saved, event, environment })).not.toContain(secret);
    },
  );

  it("returns a safe terminal environment failure when diagnostics are null", () => {
    const event = normalizeEvent(environmentEvent(null));
    expect(event).toMatchObject({
      type: "runtime.error",
      code: null,
      message: "Environment failed",
    });
    expect(event && isTerminal(event)).toBe(true);
  });

  it.each([
    undefined,
    {},
    { code: null, message: secret },
    { code: secret },
    { code: secret, message: 1 },
  ])("rejects malformed nested diagnostics without exposing their values", (error) => {
    invalid(() => normalizeTurn({ ...turn, status: "failed", error }));
    invalid(() => normalizeEvent(turnEvent({ ...turn, status: "failed", error })));
    invalid(() => normalizeEvent(environmentEvent(error)));
  });

  it.each([
    { type: "agent.session.idle", event_id: "event_session", session: { status: "idle" } },
    {
      type: "agent.session.idle",
      event_id: "event_session",
      session: { id: session.id, status: secret },
    },
    { type: "agent.session.idle", session },
    { type: "agent.session.turn.completed", event_id: "event_turn", turn },
    {
      type: "agent.session.turn.output_text.done",
      event_id: "event_text",
      session_id: session.id,
      item_id: "msg_123",
      content_index: 0,
    },
    {
      type: "agent.session.environment.failed",
      event_id: "event_environment",
      session_id: session.id,
    },
  ])("rejects malformed supported event schemas", (event) => {
    invalid(() => normalizeEvent(event));
  });

  it.each([
    { type: "openai_hosted" },
    { type: "openai_hosted", id: "" },
    { type: "self_hosted", id: "env_123" },
    { type: secret, id: "env_123" },
  ])("rejects missing hosted IDs and unsupported session environments", (environment) => {
    invalid(() => normalizeSession({ ...session, environment }));
  });

  it("accepts an idle hosted session while provisioning is asynchronous", () => {
    expect(normalizeSession(session)).toMatchObject({
      status: "idle",
      environmentExternalId: "env_123",
    });
  });

  it("normalizes environmentless sessions without an environment ID", () => {
    expect(normalizeSession({ ...session, environment: { type: "none" } })).toMatchObject({
      status: "idle",
      environmentExternalId: null,
    });
  });
});
