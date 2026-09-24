import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStream } from "@/features/chat/useConversationStream.js";
import { FakeEventSource } from "./fake-event-source.js";

const message = {
  id: "m-1",
  conversationId: "c-1",
  participantId: "p-1",
  runId: "r-1",
  sequence: "1",
  role: "assistant",
  content: [{ index: 0, type: "text", text: "he", completed: false }],
  phase: null,
  status: "running",
  createdAt: "2026-09-15T00:00:00.000Z",
};
const snapshot = {
  conversation: { id: "c-1", title: null, createdAt: "2026-09-15T00:00:00.000Z" },
  participants: [],
  activeRun: null,
  latestMessages: [message],
  nextMessageCursor: "cur-1",
  environment: null,
};

async function latestSource() {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error("Expected an EventSource instance");
  return source;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: [], nextCursor: null })));
});
afterEach(() => vi.unstubAllGlobals());

describe("useConversationStream", () => {
  it("applies a snapshot then deltas from the live source", async () => {
    const { result } = renderHook(() => useConversationStream("c-1"));
    const source = await latestSource();
    expect(source.url).toBe("http://localhost:3000/conversations/c-1/events");
    expect(result.current.stream).toBe("connecting");
    source.open();
    expect(result.current.stream).toBe("live");
    source.emit("conversation.snapshot", snapshot);
    expect(result.current.thread.conversation?.id).toBe("c-1");
    source.emit("message.delta", { messageId: "m-1", contentIndex: 0, text: "llo" });
    expect(result.current.thread.messages[0]?.content[0]).toEqual({
      index: 0,
      type: "text",
      text: "hello",
      completed: false,
    });
  });

  it("reports reconnecting while open and closed after close", async () => {
    const { result } = renderHook(() => useConversationStream("c-1"));
    const source = await latestSource();
    source.open();
    source.error();
    expect(result.current.stream).toBe("reconnecting");
    source.close();
    source.error();
    expect(result.current.stream).toBe("closed");
  });

  it("stays closed without a conversation id", async () => {
    const { result } = renderHook(() => useConversationStream(null));
    await Promise.resolve();
    expect(result.current.stream).toBe("closed");
    expect(result.current.thread.messages).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("reconnect() closes the old source and opens a fresh one", async () => {
    const { result } = renderHook(() => useConversationStream("c-1"));
    const first = await latestSource();
    first.open();
    act(() => result.current.reconnect());
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    const second = await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
      const instance = FakeEventSource.instances[1];
      if (!instance) throw new Error("Expected a second EventSource");
      return instance;
    });
    expect(second.url).toBe(first.url);
    expect(result.current.stream).toBe("connecting");
  });

  it("closes the old source and resets the thread on id change", async () => {
    const { result, rerender } = renderHook(({ id }) => useConversationStream(id), {
      initialProps: { id: "c-1" as string | null },
    });
    const first = await latestSource();
    first.emit("conversation.snapshot", snapshot);
    rerender({ id: "c-2" });
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(result.current.thread.conversation).toBeNull();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1]?.url).toContain("/conversations/c-2/events");
  });

  it("ignores events from a stale source", async () => {
    const { result } = renderHook(() => useConversationStream("c-1"));
    const first = await latestSource();
    first.emit("conversation.snapshot", snapshot);
    act(() => result.current.reconnect());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const second = FakeEventSource.instances[1];
    if (!second) throw new Error("Expected a second EventSource");
    second.emit("conversation.snapshot", snapshot);
    expect(result.current.thread.messages).toHaveLength(1);
    first.emit("message.delta", { messageId: "m-1", contentIndex: 0, text: "stale" });
    expect(result.current.thread.messages[0]?.content[0]).toEqual({
      index: 0,
      type: "text",
      text: "he",
      completed: false,
    });
  });

  it("closes the source on unmount", async () => {
    const { unmount } = renderHook(() => useConversationStream("c-1"));
    const source = await latestSource();
    unmount();
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("loadEarlier prepends a page and updates the cursor", async () => {
    const { result } = renderHook(() => useConversationStream("c-1"));
    const source = await latestSource();
    source.emit("conversation.snapshot", snapshot);
    const earlier = { ...message, id: "m-0", sequence: "0", status: "completed" };
    vi.mocked(fetch).mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        new URL(url).pathname.endsWith("/messages")
          ? Response.json({ items: [earlier], nextCursor: null })
          : Response.json({ items: [], nextCursor: null }),
      );
    });
    await act(() => result.current.loadEarlier());
    expect(result.current.thread.messages.map((m) => m.id)).toEqual(["m-0", "m-1"]);
    expect(result.current.thread.nextMessageCursor).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/conversations/c-1/messages?limit=50&cursor=cur-1",
      expect.anything(),
    );
    await act(() => result.current.loadEarlier());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("closes when the API client cannot be resolved", async () => {
    vi.resetModules();
    vi.mocked(window.opensquad.getApiBaseUrl).mockRejectedValueOnce(new Error("no bridge"));
    const { useConversationStream: fresh } = await import(
      "@/features/chat/useConversationStream.js"
    );
    const { result } = renderHook(() => fresh("c-1"));
    await waitFor(() => expect(result.current.stream).toBe("closed"));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("surfaces loadEarlier failures", async () => {
    const { result } = renderHook(() => useConversationStream("c-1"));
    const source = await latestSource();
    source.emit("conversation.snapshot", snapshot);
    vi.mocked(fetch).mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        new URL(url).pathname.endsWith("/messages")
          ? new Response("nope", { status: 500 })
          : Response.json({ items: [], nextCursor: null }),
      );
    });
    await act(() => result.current.loadEarlier());
    expect(result.current.earlierError?.message).toBe("API returned status 500");
    expect(result.current.loadingEarlier).toBe(false);
  });
});
