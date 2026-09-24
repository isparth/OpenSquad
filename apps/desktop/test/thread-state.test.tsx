import type { ConversationMessage, ConversationRun } from "@opensquad/core";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  emptyThread,
  prependMessages,
  type ThreadState,
} from "@/features/chat/thread-state.js";

const conversation = { id: "c-1", title: null, createdAt: "2026-09-15T00:00:00.000Z" };
const participant = {
  id: "p-1",
  conversationId: "c-1",
  kind: "agent" as const,
  refId: "a-1",
  name: "Bot",
  deletedAt: null,
};

function msg(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "m-1",
    conversationId: "c-1",
    participantId: "p-1",
    runId: "r-1",
    sequence: "1",
    role: "assistant",
    content: [{ index: 0, type: "text", text: "", completed: false }],
    phase: null,
    status: "running",
    createdAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<ConversationRun> = {}): ConversationRun {
  return {
    id: "r-1",
    conversationId: "c-1",
    agentParticipantId: "p-1",
    clientRequestId: "req-1",
    status: "running",
    observation: "connected",
    active: true,
    cancelRequested: false,
    createdAt: "2026-09-15T00:00:00.000Z",
    finishedAt: null,
    deadlineAt: "2026-09-15T00:10:00.000Z",
    usage: null,
    error: null,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    conversation,
    participants: [participant],
    activeRun: null,
    latestMessages: [msg()],
    nextMessageCursor: "cur-1",
    environment: null,
    ...overrides,
  };
}

describe("thread state", () => {
  it("replaces state on snapshot and sorts messages by numeric sequence", () => {
    const state = applyEvent(emptyThread, {
      type: "conversation.snapshot",
      payload: snapshot({
        latestMessages: [msg({ id: "m-10", sequence: "10" }), msg({ id: "m-2", sequence: "2" })],
      }),
    });
    expect(state.conversation).toEqual(conversation);
    expect(state.participants).toEqual([participant]);
    expect(state.messages.map((m) => m.id)).toEqual(["m-2", "m-10"]);
    expect(state.nextMessageCursor).toBe("cur-1");
  });

  it("keeps sandbox environment status from snapshots and environment updates", () => {
    expect(
      applyEvent(emptyThread, { type: "environment.updated", payload: { status: "pending" } })
        .environment,
    ).toEqual({ type: "hosted", status: "pending" });
    const hosted = { type: "hosted", status: "pending" } as const;
    const state = applyEvent(emptyThread, {
      type: "conversation.snapshot",
      payload: snapshot({ environment: hosted }),
    });
    expect(state.environment).toEqual(hosted);
    const ready = applyEvent(state, { type: "environment.updated", payload: { status: "ready" } });
    expect(ready.environment).toEqual({ type: "hosted", status: "ready" });
    const reset = applyEvent(ready, {
      type: "environment.updated",
      payload: { status: "reset" },
    });
    expect(reset.environment).toEqual({ type: "hosted", status: "reset" });
    expect(applyEvent(reset, { type: "environment.updated", payload: { status: "unknown" } })).toBe(
      reset,
    );
    expect(
      applyEvent(emptyThread, {
        type: "conversation.snapshot",
        payload: snapshot({ environment: { type: "other", status: "ready" } }),
      }),
    ).toBe(emptyThread);
  });

  it("clears lastRun when the snapshot has an active run and keeps it otherwise", () => {
    const lastRun = run({ active: false, status: "succeeded" });
    const withLast: ThreadState = { ...emptyThread, lastRun };
    expect(
      applyEvent(withLast, { type: "conversation.snapshot", payload: snapshot() }).lastRun,
    ).toEqual(lastRun);
    expect(
      applyEvent(withLast, {
        type: "conversation.snapshot",
        payload: snapshot({ activeRun: run() }),
      }).lastRun,
    ).toBeNull();
  });

  it("inserts new messages sorted and only replaces a running message on created", () => {
    let state = applyEvent(emptyThread, {
      type: "message.created",
      payload: { message: msg({ id: "m-2", sequence: "2" }) },
    });
    state = applyEvent(state, {
      type: "message.created",
      payload: { message: msg({ id: "m-1", sequence: "1" }) },
    });
    expect(state.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    const duplicate = msg({ id: "m-1", sequence: "1", status: "completed" });
    state = applyEvent(state, { type: "message.created", payload: { message: duplicate } });
    expect(state.messages.find((m) => m.id === "m-1")?.status).toBe("completed");
    const stale = msg({ id: "m-1", sequence: "1", status: "running" });
    const after = applyEvent(state, { type: "message.created", payload: { message: stale } });
    expect(after.messages.find((m) => m.id === "m-1")?.status).toBe("completed");
  });

  it("appends deltas to running text parts and ignores completed parts", () => {
    let state: ThreadState = {
      ...emptyThread,
      messages: [msg({ content: [{ index: 0, type: "text", text: "he", completed: false }] })],
    };
    state = applyEvent(state, {
      type: "message.delta",
      payload: { messageId: "m-1", contentIndex: 0, text: "llo" },
    });
    expect(state.messages[0]?.content[0]).toEqual({
      index: 0,
      type: "text",
      text: "hello",
      completed: false,
    });
    state = applyEvent(state, {
      type: "message.delta",
      payload: { messageId: "m-1", contentIndex: 1, text: "next" },
    });
    expect(state.messages[0]?.content[1]).toEqual({
      index: 1,
      type: "text",
      text: "next",
      completed: false,
    });
    state = applyEvent(state, {
      type: "message.text.completed",
      payload: { messageId: "m-1", contentIndex: 0, text: "hello!" },
    });
    expect(state.messages[0]?.content[0]).toEqual({
      index: 0,
      type: "text",
      text: "hello!",
      completed: true,
    });
    const after = applyEvent(state, {
      type: "message.delta",
      payload: { messageId: "m-1", contentIndex: 0, text: "ignored" },
    });
    expect(after).toBe(state);
  });

  it("ignores deltas for missing or non-running messages", () => {
    const completed: ThreadState = {
      ...emptyThread,
      messages: [msg({ status: "completed" })],
    };
    for (const state of [emptyThread, completed]) {
      expect(
        applyEvent(state, {
          type: "message.delta",
          payload: { messageId: "m-1", contentIndex: 0, text: "x" },
        }),
      ).toBe(state);
    }
  });

  it("replaces or inserts messages on message.completed", () => {
    const state: ThreadState = { ...emptyThread, messages: [msg()] };
    const done = msg({ status: "completed", content: [] });
    expect(
      applyEvent(state, { type: "message.completed", payload: { message: done } }).messages[0]
        ?.status,
    ).toBe("completed");
    const inserted = applyEvent(state, {
      type: "message.completed",
      payload: { message: msg({ id: "m-9", sequence: "9", status: "completed" }) },
    });
    expect(inserted.messages.map((m) => m.id)).toEqual(["m-1", "m-9"]);
  });

  it("tracks active and last runs without regressing terminal state", () => {
    let state = applyEvent(emptyThread, { type: "run.updated", payload: { run: run() } });
    expect(state.activeRun?.status).toBe("running");
    const finished = run({
      active: false,
      status: "succeeded",
      finishedAt: "2026-09-15T00:01:00.000Z",
    });
    state = applyEvent(state, { type: "run.updated", payload: { run: finished } });
    expect(state.activeRun).toBeNull();
    expect(state.lastRun).toEqual(finished);
    const stale = run({ active: true, status: "running" });
    state = applyEvent(
      { ...state, activeRun: run({ active: true, status: "succeeded" }) },
      { type: "run.updated", payload: { run: stale } },
    );
    expect(state.activeRun?.status).toBe("succeeded");
    const other = applyEvent(
      { ...emptyThread, activeRun: run({ id: "r-2" }) },
      { type: "run.updated", payload: { run: finished } },
    );
    expect(other.activeRun?.id).toBe("r-2");
  });

  it("does not let an older terminal run clobber a newer lastRun", () => {
    const newer = run({
      id: "r-2",
      active: false,
      status: "succeeded",
      createdAt: "2026-09-15T00:05:00.000Z",
    });
    const older = run({
      id: "r-1",
      active: false,
      status: "failed",
      createdAt: "2026-09-15T00:01:00.000Z",
    });
    const state: ThreadState = { ...emptyThread, lastRun: newer };
    expect(applyEvent(state, { type: "run.updated", payload: { run: older } }).lastRun).toEqual(
      newer,
    );
    expect(applyEvent(state, { type: "run.updated", payload: { run: newer } }).lastRun).toEqual(
      newer,
    );
  });

  it("replaces participants by id and ignores resets and invalid payloads", () => {
    const renamed = { ...participant, name: "Renamed" };
    const state = applyEvent(
      { ...emptyThread, participants: [participant] },
      { type: "participant.updated", payload: { participant: renamed } },
    );
    expect(state.participants[0]?.name).toBe("Renamed");
    expect(applyEvent(state, { type: "stream.reset", payload: {} })).toBe(state);
    for (const event of [
      { type: "unknown.event", payload: {} },
      { type: "message.created", payload: { message: { id: 5 } } },
      { type: "conversation.snapshot", payload: { conversation: null } },
      { type: "message.delta", payload: "junk" },
      { type: "run.updated", payload: { run: { ...run(), observation: undefined } } },
      { type: "run.updated", payload: { run: { ...run(), error: { code: 1 } } } },
      {
        type: "participant.updated",
        payload: { participant: { ...participant, name: { nested: "x" } } },
      },
    ]) {
      expect(applyEvent(state, event)).toBe(state);
    }
  });

  it("prepends earlier messages, dedupes by id, and updates the cursor", () => {
    const state: ThreadState = {
      ...emptyThread,
      messages: [msg({ id: "m-3", sequence: "3" })],
      nextMessageCursor: "cur-3",
    };
    const next = prependMessages(state, {
      items: [msg({ id: "m-2", sequence: "2" }), msg({ id: "m-3", sequence: "3" })],
      nextCursor: "cur-2",
    });
    expect(next.messages.map((m) => m.id)).toEqual(["m-2", "m-3"]);
    expect(next.nextMessageCursor).toBe("cur-2");
  });
});
