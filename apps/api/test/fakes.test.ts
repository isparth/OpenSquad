import type { RuntimeEvent, RuntimeEventStream, RuntimeSession } from "@opensquad/core";
import { describe, expect, it, vi } from "vitest";
import { FakeRuntimeProvider } from "./fakes.js";

const credentials = { apiKey: "dummy-test-key" };
const session: RuntimeSession = {
  provider: "fake-runtime",
  externalId: "session-test",
  model: "test-model",
  status: "idle",
  environmentExternalId: null,
};

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

describe("FakeRuntimeProvider", () => {
  it("fails closed for every unconfigured operation", async () => {
    const runtime = new FakeRuntimeProvider();
    const calls = {
      createSession: () => runtime.createSession({ instructions: "Test" }, credentials),
      retrieveSession: () => runtime.retrieveSession(session, credentials),
      sendInput: () => runtime.sendInput(session, "Hello", credentials),
      events: () => runtime.events(session, credentials),
      listMessages: () => collect(runtime.listMessages(session, credentials)),
      listTurns: () => collect(runtime.listTurns(session, credentials)),
      cancel: () => runtime.cancel(session, credentials),
      destroySession: () => runtime.destroySession(session, credentials),
    };
    for (const [method, call] of Object.entries(calls)) {
      await expect(call()).rejects.toThrow(`Configure FakeRuntimeProvider.${method}`);
    }
  });

  it("keeps scripts, call history and feature settings isolated between instances", async () => {
    const first = new FakeRuntimeProvider();
    const second = new FakeRuntimeProvider();
    first.features.mcp = true;
    first.createSession.mockResolvedValueOnce(session);
    expect(await first.createSession({ instructions: "Test" }, credentials)).toBe(session);
    expect(second.features.mcp).toBe(false);
    expect(second.createSession).not.toHaveBeenCalled();
    await expect(second.createSession({ instructions: "Test" }, credentials)).rejects.toThrow(
      "Configure FakeRuntimeProvider.createSession",
    );
    await expect(first.createSession({ instructions: "Test" }, credentials)).rejects.toThrow(
      "Configure FakeRuntimeProvider.createSession",
    );
  });

  it("passes explicit credentials and request signals to a scripted subscription and send failure", async () => {
    const runtime = new FakeRuntimeProvider();
    const request = { signal: new AbortController().signal };
    const event: RuntimeEvent = {
      type: "session.status",
      externalId: "event-test",
      sessionExternalId: session.externalId,
      turnExternalId: null,
      status: "idle",
    };
    const stream: RuntimeEventStream = {
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield event;
        throw new Error("Scripted disconnect");
      },
    };
    runtime.events.mockResolvedValueOnce(stream);
    runtime.sendInput.mockRejectedValueOnce(new Error("Scripted send failure"));

    const subscription = await runtime.events(session, credentials, request);
    try {
      await expect(runtime.sendInput(session, "Hello", credentials, request)).rejects.toThrow(
        "Scripted send failure",
      );
      const iterator = subscription[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ value: event, done: false });
      await expect(iterator.next()).rejects.toThrow("Scripted disconnect");
    } finally {
      subscription.close();
    }
    expect(runtime.events).toHaveBeenCalledWith(session, credentials, request);
    expect(runtime.sendInput).toHaveBeenCalledWith(session, "Hello", credentials, request);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(runtime.destroySession).not.toHaveBeenCalled();
  });

  it("allows saved history and turn outcomes to be scripted independently of live events", async () => {
    const runtime = new FakeRuntimeProvider();
    runtime.listMessages.mockImplementationOnce(async function* () {
      yield {
        externalId: null,
        turnExternalId: "turn-test",
        role: "assistant",
        status: "completed",
        phase: "final",
        content: [{ type: "text", text: "Saved reply without deltas" }],
      };
    });
    runtime.listTurns.mockImplementationOnce(async function* () {
      yield {
        externalId: "turn-test",
        subagentExternalId: null,
        status: "succeeded",
        usage: { inputTokens: 1, outputTokens: 2 },
        error: null,
      };
    });
    expect(await collect(runtime.listMessages(session, credentials))).toMatchObject([
      { externalId: null, content: [{ type: "text", text: "Saved reply without deltas" }] },
    ]);
    expect(await collect(runtime.listTurns(session, credentials))).toMatchObject([
      { status: "succeeded", subagentExternalId: null },
    ]);
    expect(runtime.events).not.toHaveBeenCalled();
  });
});
