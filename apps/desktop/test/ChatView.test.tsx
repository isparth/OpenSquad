import type { ConversationMessage, ConversationRun } from "@opensquad/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "@/features/chat/ChatView.js";
import { RuntimeKeyProvider } from "@/features/runtime-key/RuntimeKeyContext.js";
import type { AgentRecord } from "@/lib/api/client.js";
import { FakeEventSource } from "./fake-event-source.js";

const agent: AgentRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Alice",
  label: null,
  description: "",
  instructions: "",
  avatarUrl: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};
const conversation = {
  id: "c-1",
  title: null,
  createdAt: "2026-09-15T00:00:00.000Z",
};
const created = {
  id: "c-2",
  title: null,
  createdAt: "2026-09-16T00:00:00.000Z",
};

const userParticipant = {
  id: "p-user",
  conversationId: "c-1",
  kind: "user",
  refId: "dev-user",
  name: "You",
  deletedAt: null,
};
const agentParticipant = {
  id: "p-agent",
  conversationId: "c-1",
  kind: "agent",
  refId: agent.id,
  name: "Alice",
  deletedAt: null,
};

function userMessage(sequence = "1"): ConversationMessage {
  return {
    id: `m-user-${sequence}`,
    conversationId: "c-1",
    participantId: "p-user",
    runId: "r-1",
    sequence,
    role: "user",
    content: [{ index: 0, type: "text", text: "hello", completed: true }],
    phase: null,
    status: "completed",
    createdAt: "2026-09-15T00:00:00.000Z",
  };
}

function run(overrides: Partial<ConversationRun> = {}): ConversationRun {
  return {
    id: "r-1",
    conversationId: "c-1",
    agentParticipantId: "p-agent",
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
    participants: [userParticipant, agentParticipant],
    activeRun: null,
    latestMessages: [],
    nextMessageCursor: null,
    ...overrides,
  };
}

function routedFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url).pathname;
  if (path === `/agents/${agent.id}`) return Promise.resolve(Response.json(agent));
  if (path === "/me") return Promise.resolve(Response.json({ userId: "dev-user" }));
  if (path === "/conversations")
    return Promise.resolve(Response.json({ items: [conversation], nextCursor: null }));
  if (path === "/conversations/c-1/messages")
    return Promise.resolve(Response.json({ items: [], nextCursor: null }));
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function renderChat(props: Partial<Parameters<typeof ChatView>[0]> = {}) {
  const onOpenProfile = props.onOpenProfile ?? vi.fn();
  const onOpenSettings = props.onOpenSettings ?? vi.fn();
  const onOpenKeySettings = props.onOpenKeySettings ?? vi.fn();
  render(
    <RuntimeKeyProvider>
      <ChatView
        id={agent.id}
        onOpenProfile={onOpenProfile}
        onOpenSettings={onOpenSettings}
        onOpenKeySettings={onOpenKeySettings}
      />
    </RuntimeKeyProvider>,
  );
  return { onOpenProfile, onOpenSettings, onOpenKeySettings };
}

async function selectConversation() {
  const buttons = await screen.findAllByRole("button", { name: /Conversation ·/ });
  const first = buttons[0];
  if (!first) throw new Error("Expected a conversation");
  fireEvent.click(first);
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("Expected an EventSource instance");
  return source;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(routedFetch));
  vi.mocked(window.opensquad.getRuntimeKeyStatus)
    .mockReset()
    .mockResolvedValue({ state: "configured" });
  vi.mocked(window.opensquad.sendMessage)
    .mockReset()
    .mockResolvedValue({ message: userMessage(), run: run() });
  vi.mocked(window.opensquad.cancelRun)
    .mockReset()
    .mockResolvedValue({ run: run({ cancelRequested: true }) });
  vi.mocked(window.opensquad.reconcileRun)
    .mockReset()
    .mockResolvedValue({ run: run({ observation: "connected" }) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("chat view", () => {
  it("auto-selects the latest conversation and opens its stream", async () => {
    renderChat();
    const button = await screen.findByRole("button", { name: /Conversation ·/ });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    expect(FakeEventSource.instances.at(-1)?.url).toContain("/conversations/c-1/events");
    expect(button).toHaveAttribute("aria-current", "true");
  });

  it("auto-selects the newest conversation when several exist", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === "/conversations")
        return Promise.resolve(Response.json({ items: [conversation, created], nextCursor: null }));
      if (new URL(url).pathname === "/conversations/c-2/messages")
        return Promise.resolve(Response.json({ items: [], nextCursor: null }));
      return routedFetch(input);
    });
    renderChat();
    await screen.findAllByRole("button", { name: /Conversation ·/ });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    expect(FakeEventSource.instances.at(-1)?.url).toContain("/conversations/c-2/events");
  });

  it("shows the empty state and opens no stream when there are no conversations", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === "/conversations")
        return Promise.resolve(Response.json({ items: [], nextCursor: null }));
      return routedFetch(input);
    });
    renderChat();
    expect(await screen.findByText("Pick a conversation or start a new one.")).toBeInTheDocument();
    await Promise.resolve();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("calls the profile and settings callbacks from the header", async () => {
    const { onOpenProfile, onOpenSettings } = renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("prompts for a runtime key when none is saved", async () => {
    vi.mocked(window.opensquad.getRuntimeKeyStatus).mockResolvedValue({
      state: "unavailable",
      reason: "not-configured",
    });
    const { onOpenKeySettings } = renderChat();
    await selectConversation();
    expect(screen.getByText("Save a runtime key to start chatting.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add runtime key" }));
    expect(onOpenKeySettings).toHaveBeenCalled();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  });

  it("creates a conversation with user and agent participants and selects it", async () => {
    renderChat();
    await screen.findByRole("button", { name: /Conversation ·/ });
    vi.mocked(fetch).mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === "/conversations")
        return Promise.resolve(Response.json({ conversation: created }));
      return routedFetch(input);
    });
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/conversations",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            participants: [
              { kind: "user", refId: "dev-user" },
              { kind: "agent", refId: agent.id },
            ],
          }),
        }),
      ),
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    expect(FakeEventSource.instances.at(-1)?.url).toContain("/conversations/c-2/events");
  });

  it("appends a second page on Load more and hides the button at the end", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.pathname === "/conversations" && parsed.searchParams.get("cursor") === "page-2") {
        return Promise.resolve(Response.json({ items: [conversation, created], nextCursor: null }));
      }
      if (parsed.pathname === "/conversations") {
        return Promise.resolve(Response.json({ items: [conversation], nextCursor: "page-2" }));
      }
      return routedFetch(input);
    });
    renderChat();
    await screen.findByRole("button", { name: /Conversation ·/ });
    expect(screen.getAllByRole("button", { name: /Conversation ·/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("cursor=page-2"),
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Conversation ·/ })).toHaveLength(2),
    );
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows a paging failure next to Load more, not in the New conversation slot", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.pathname === "/conversations" && parsed.searchParams.get("cursor") === "page-2") {
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      if (parsed.pathname === "/conversations") {
        return Promise.resolve(Response.json({ items: [conversation], nextCursor: "page-2" }));
      }
      return routedFetch(input);
    });
    renderChat();
    await screen.findByRole("button", { name: /Conversation ·/ });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("API returned status 500");
    const earlier = document.querySelector(".chat-earlier");
    expect(earlier).not.toBeNull();
    expect(earlier?.contains(alert)).toBe(true);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });

  it("sends a message, streams the reply, and re-enables the composer", async () => {
    renderChat();
    const source = await selectConversation();
    source.emit("conversation.snapshot", snapshot());
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(window.opensquad.sendMessage).toHaveBeenCalledTimes(1));
    const command = vi.mocked(window.opensquad.sendMessage).mock.calls[0]?.[0];
    if (!command) throw new Error("Expected a sendMessage call");
    expect(command.conversationId).toBe("c-1");
    expect(command.text).toBe("hello");
    expect(command.clientRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(box).toBeDisabled();
    source.emit("message.created", {
      message: {
        ...userMessage("2"),
        id: "m-bot",
        participantId: "p-agent",
        role: "assistant",
        status: "running",
        content: [{ index: 0, type: "text", text: "", completed: false }],
      },
    });
    source.emit("message.delta", { messageId: "m-bot", contentIndex: 0, text: "Hi" });
    source.emit("message.delta", { messageId: "m-bot", contentIndex: 0, text: " there" });
    source.emit("message.text.completed", {
      messageId: "m-bot",
      contentIndex: 0,
      text: "Hi there!",
    });
    source.emit("message.completed", {
      message: {
        ...userMessage("2"),
        id: "m-bot",
        participantId: "p-agent",
        role: "assistant",
        status: "completed",
        content: [{ index: 0, type: "text", text: "Hi there!", completed: true }],
      },
    });
    source.emit("run.updated", { run: run({ active: false, status: "succeeded" }) });
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
    expect(box).toBeEnabled();
  });

  it("keeps Shift+Enter as a newline and only sends on Enter", async () => {
    renderChat();
    const source = await selectConversation();
    source.emit("conversation.snapshot", snapshot());
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    await Promise.resolve();
    expect(window.opensquad.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(window.opensquad.sendMessage).toHaveBeenCalled());
  });

  it("retries a failed send with the same clientRequestId and discards back to the draft", async () => {
    vi.mocked(window.opensquad.sendMessage)
      .mockRejectedValueOnce(new Error("request failed"))
      .mockRejectedValueOnce(new Error("request failed"));
    renderChat();
    const source = await selectConversation();
    source.emit("conversation.snapshot", snapshot());
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "keep me" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("request failed");
    const firstCall = vi.mocked(window.opensquad.sendMessage).mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(window.opensquad.sendMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(window.opensquad.sendMessage).mock.calls[1]?.[0]).toEqual(firstCall);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(box).toHaveValue("keep me"));
    expect(box).toBeEnabled();
  });

  it("cancels an active run and hides Cancel once requested", async () => {
    renderChat();
    const source = await selectConversation();
    source.emit("conversation.snapshot", snapshot({ activeRun: run() }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(window.opensquad.cancelRun).toHaveBeenCalledWith({ runId: "r-1" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Cancelling…/);
  });

  it("offers Reconcile when the run needs reconciliation", async () => {
    renderChat();
    const source = await selectConversation();
    source.emit(
      "conversation.snapshot",
      snapshot({ activeRun: run({ observation: "reconciliation_required" }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
    await waitFor(() =>
      expect(window.opensquad.reconcileRun).toHaveBeenCalledWith({ runId: "r-1" }),
    );
  });

  it("does not leak a failed send into another conversation", async () => {
    vi.mocked(window.opensquad.sendMessage).mockRejectedValueOnce(new Error("request failed"));
    vi.mocked(fetch).mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === "/conversations")
        return Promise.resolve(Response.json({ items: [created, conversation], nextCursor: null }));
      return routedFetch(input);
    });
    renderChat();
    const first = await selectConversation();
    first.emit("conversation.snapshot", snapshot());
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "draft for A" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("request failed");
    const buttons = screen.getAllByRole("button", { name: /Conversation ·/ });
    const other = buttons.find((button) => button.getAttribute("aria-current") !== "true");
    if (!other) throw new Error("Expected a second conversation");
    fireEvent.click(other);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(1));
    const second = FakeEventSource.instances.at(-1);
    if (!second) throw new Error("Expected a second EventSource");
    second.emit("conversation.snapshot", snapshot());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const nextBox = screen.getByLabelText("Message");
    expect(nextBox).toHaveValue("");
    expect(nextBox).toBeEnabled();
  });

  it("shows Reconnect after the stream closes and reopens on click", async () => {
    renderChat();
    const source = await selectConversation();
    source.close();
    source.error();
    expect(screen.getByRole("status")).toHaveTextContent("Live updates disconnected.");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  });
});
