import type {
  ConversationMessage,
  ConversationParticipant,
  ConversationRun,
  ConversationSummary,
} from "@opensquad/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AgentRecord, type ApiClient, ApiError, getApiClient } from "@/lib/api/client.js";
import { AgentAvatar } from "../agents/AgentAvatar.js";
import { useApiResource } from "../agents/useApiResource.js";
import { useRuntimeKey } from "../runtime-key/RuntimeKeyContext.js";
import { useConversationStream } from "./useConversationStream.js";

const RECONCILE_CODES = new Set(["uncertain_mutation", "worker_lost", "stream_disconnected"]);

function runNeedsReconcile(run: ConversationRun | null): boolean {
  return (
    !!run &&
    run.active &&
    (run.observation === "reconciliation_required" || RECONCILE_CODES.has(run.error?.code ?? ""))
  );
}

function messageText(message: ConversationMessage): string {
  return [...message.content]
    .sort((a, b) => a.index - b.index)
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("");
}

function authorName(
  message: ConversationMessage,
  participants: ConversationParticipant[],
  agent: AgentRecord,
): string {
  const participant = participants.find((entry) => entry.id === message.participantId);
  if (participant) return participant.name;
  return message.role === "user" ? "You" : agent.name;
}

export function ChatView({
  id,
  onOpenProfile,
  onOpenSettings,
  onOpenKeySettings,
}: {
  id: string;
  onOpenProfile(): void;
  onOpenSettings(): void;
  onOpenKeySettings(): void;
}) {
  const load = useCallback((api: ApiClient, signal: AbortSignal) => api.getAgent(id, signal), [id]);
  const { data: agent, error, loading } = useApiResource(load);
  if (loading)
    return (
      <div className="panel-state" role="status">
        Loading bot…
      </div>
    );
  if (error || !agent)
    return (
      <div className="panel-state" data-testid="agent-not-found">
        <h2>
          {error instanceof ApiError && error.status === 404
            ? "Bot not found"
            : "Couldn't load this bot"}
        </h2>
        <p className="muted">
          {error instanceof ApiError && error.status === 404
            ? "It may have been deleted or is no longer available to you."
            : (error?.message ?? "")}
        </p>
        <button type="button" className="button secondary" onClick={onOpenProfile}>
          Back
        </button>
      </div>
    );
  return (
    <Chat
      agent={agent}
      onOpenProfile={onOpenProfile}
      onOpenSettings={onOpenSettings}
      onOpenKeySettings={onOpenKeySettings}
    />
  );
}

function Chat({
  agent,
  onOpenProfile,
  onOpenSettings,
  onOpenKeySettings,
}: {
  agent: AgentRecord;
  onOpenProfile(): void;
  onOpenSettings(): void;
  onOpenKeySettings(): void;
}) {
  const { status: keyStatus } = useRuntimeKey();
  const keyReady = keyStatus?.state === "configured";
  const loadConversations = useCallback(
    (api: ApiClient, signal: AbortSignal) => api.listConversations(agent.id, null, signal),
    [agent.id],
  );
  const {
    data: conversationPage,
    error: listError,
    loading: listLoading,
    refresh: refreshConversations,
  } = useApiResource(loadConversations);
  const [more, setMore] = useState<{
    items: ConversationSummary[];
    nextCursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const seen = new Set<string>();
  const conversations = [...(more?.items ?? []), ...(conversationPage?.items ?? [])]
    .filter((conversation) => {
      if (seen.has(conversation.id)) return false;
      seen.add(conversation.id);
      return true;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const listCursor = more ? more.nextCursor : (conversationPage?.nextCursor ?? null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const autoSelected = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (conversationId !== null || !conversationPage || autoSelected.current) return;
    const latest = [...conversationPage.items].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )[0];
    if (latest) {
      autoSelected.current = true;
      setConversationId(latest.id);
    }
  }, [conversationPage, conversationId]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function loadMore() {
    if (listCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const api = await getApiClient();
      const page = await api.listConversations(agent.id, listCursor);
      setMore((current) => ({
        items: [...(current?.items ?? []), ...page.items],
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      setMoreError(error instanceof Error ? error.message : "Unable to load conversations");
    } finally {
      setLoadingMore(false);
    }
  }

  function refreshList() {
    setMore(null);
    setMoreError(null);
    refreshConversations();
  }

  async function newConversation() {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const api = await getApiClient();
      const { conversation } = await api.createConversation(agent.id);
      setConversationId(conversation.id);
      refreshList();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Unable to create conversation");
    } finally {
      setCreating(false);
    }
  }

  function conversationLabel(conversation: ConversationSummary): string {
    return (
      conversation.title ?? `Conversation · ${new Date(conversation.createdAt).toLocaleString()}`
    );
  }

  return (
    <div className="chat-view">
      <div className="chat-header">
        <AgentAvatar agent={agent} />
        <h2 ref={heading} tabIndex={-1}>
          {agent.name}
        </h2>
        <div className="chat-header-actions">
          <button type="button" className="button secondary" onClick={onOpenProfile}>
            Profile
          </button>
          <button type="button" className="button secondary" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </div>
      <div className="chat-columns">
        <aside className="chat-list" aria-label="Conversations">
          <div className="directory-toolbar">
            <button
              type="button"
              className="button secondary"
              disabled={creating}
              onClick={() => void newConversation()}
            >
              {creating ? "Starting…" : "New conversation"}
            </button>
          </div>
          {createError && (
            <p role="alert" className="error-message">
              {createError}
            </p>
          )}
          {listLoading && (
            <div className="list-state" role="status">
              Loading conversations…
            </div>
          )}
          {listError && (
            <div className="list-state">
              <p role="alert" className="error-message">
                {listError.message}
              </p>
              <button type="button" className="button secondary" onClick={refreshList}>
                Retry
              </button>
            </div>
          )}
          {!listLoading && !listError && conversations.length === 0 && (
            <p className="list-state muted">No conversations yet.</p>
          )}
          <ul className="bot-list">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  className={`bot-list-item${conversationId === conversation.id ? " selected" : ""}`}
                  aria-current={conversationId === conversation.id ? "true" : undefined}
                  onClick={() => setConversationId(conversation.id)}
                >
                  <span className="bot-list-copy">
                    <span className="bot-list-name">{conversationLabel(conversation)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {listCursor !== null && (
            <div className="chat-earlier">
              <button
                type="button"
                className="button text-button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
              {moreError && (
                <p role="alert" className="error-message">
                  {moreError}
                </p>
              )}
            </div>
          )}
        </aside>
        <div className="chat-thread">
          {conversationId ? (
            <Thread
              key={conversationId}
              agent={agent}
              conversationId={conversationId}
              keyReady={keyReady}
              onOpenKeySettings={onOpenKeySettings}
            />
          ) : (
            <div className="panel-state">
              <p className="muted">Pick a conversation or start a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Thread({
  agent,
  conversationId,
  keyReady,
  onOpenKeySettings,
}: {
  agent: AgentRecord;
  conversationId: string;
  keyReady: boolean;
  onOpenKeySettings(): void;
}) {
  const { thread, stream, reconnect, apply, loadEarlier, loadingEarlier, earlierError } =
    useConversationStream(conversationId);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{ text: string; clientRequestId: string } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const scroller = useRef<HTMLOListElement>(null);
  const nearBottom = useRef(true);
  const messages = thread.messages;

  useEffect(() => {
    void messages;
    const element = scroller.current;
    if (element && nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  async function send(pendingSend?: { text: string; clientRequestId: string }) {
    if (pending && !pendingSend) return;
    const attempt = pendingSend ?? { text: draft, clientRequestId: crypto.randomUUID() };
    if (!attempt.text.trim()) return;
    setPending(attempt);
    setSendError(null);
    try {
      const result = await window.opensquad.sendMessage({
        conversationId,
        text: attempt.text,
        clientRequestId: attempt.clientRequestId,
      });
      apply({ type: "message.created", payload: { message: result.message } });
      apply({ type: "run.updated", payload: { run: result.run } });
      setPending(null);
      setDraft((current) => (current === attempt.text ? "" : current));
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Unable to send message");
    }
  }

  async function cancel() {
    const run = thread.activeRun;
    if (!run || runBusy) return;
    setRunBusy(true);
    setRunError(null);
    try {
      const result = await window.opensquad.cancelRun({ runId: run.id });
      apply({ type: "run.updated", payload: result });
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Unable to cancel run");
    } finally {
      setRunBusy(false);
    }
  }

  async function reconcile() {
    const run = thread.activeRun;
    if (!run || runBusy) return;
    setRunBusy(true);
    setRunError(null);
    try {
      const result = await window.opensquad.reconcileRun({ runId: run.id });
      apply({ type: "run.updated", payload: result });
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Unable to reconcile run");
    } finally {
      setRunBusy(false);
    }
  }

  const activeRun = thread.activeRun;
  const composerDisabled = !!activeRun || !keyReady || pending !== null;
  const live = stream !== "closed" && stream !== "reconnecting";

  return (
    <>
      {thread.nextMessageCursor !== null && (
        <div className="chat-earlier">
          <button
            type="button"
            className="button text-button"
            disabled={loadingEarlier}
            onClick={() => void loadEarlier()}
          >
            {loadingEarlier ? "Loading…" : "Load earlier"}
          </button>
          {earlierError && (
            <p role="alert" className="error-message">
              {earlierError.message}
            </p>
          )}
        </div>
      )}
      <ol
        ref={scroller}
        className="chat-messages"
        aria-label="Messages"
        onScroll={(event) => {
          const element = event.currentTarget;
          nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {thread.messages.map((message) => (
          <li key={message.id} className={`chat-message ${message.role}`}>
            <span className="chat-author">{authorName(message, thread.participants, agent)}</span>
            <span className="chat-bubble">
              {messageText(message)}
              {message.role === "assistant" && message.status === "running" && (
                <span aria-hidden="true"> …</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="chat-status-bar" role="status">
        {stream === "reconnecting" && <p className="muted">Reconnecting to live updates…</p>}
        {stream === "closed" && (
          <p className="muted">
            Live updates disconnected.{" "}
            <button type="button" className="button text-button" onClick={reconnect}>
              Reconnect
            </button>
          </p>
        )}
        {live && activeRun && (
          <p className="muted">
            {activeRun.cancelRequested
              ? "Cancelling…"
              : activeRun.status === "running"
                ? "Replying…"
                : "Waiting for reply…"}
          </p>
        )}
        {live && !activeRun && thread.lastRun?.status === "cancelled" && (
          <p className="muted">Reply cancelled.</p>
        )}
        {live && !activeRun && thread.lastRun?.error && (
          <p className="muted">{thread.lastRun.error.message}</p>
        )}
      </div>
      {runError && (
        <p role="alert" className="error-message">
          {runError}
        </p>
      )}
      {activeRun && (
        <div className="chat-run-actions">
          {!activeRun.cancelRequested && (
            <button
              type="button"
              className="button secondary"
              disabled={runBusy}
              onClick={() => void cancel()}
            >
              Cancel
            </button>
          )}
          {runNeedsReconcile(activeRun) && (
            <button
              type="button"
              className="button secondary"
              disabled={runBusy}
              onClick={() => void reconcile()}
            >
              Reconcile
            </button>
          )}
        </div>
      )}
      {sendError && pending && (
        <div className="chat-banner" role="alert">
          <p className="error-message">{sendError}</p>
          {sendError === "request conflict" && !activeRun && (
            <p className="muted">
              If you changed this bot's settings, start a new conversation to keep chatting.
            </p>
          )}
          <button type="button" className="button secondary" onClick={() => void send(pending)}>
            Retry
          </button>
          <button
            type="button"
            className="button text-button"
            onClick={() => {
              setDraft(pending.text);
              setPending(null);
              setSendError(null);
            }}
          >
            Discard
          </button>
        </div>
      )}
      {keyReady ? (
        <div className="chat-composer">
          <textarea
            aria-label="Message"
            value={draft}
            readOnly={pending !== null}
            disabled={composerDisabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="button primary"
            disabled={composerDisabled || !draft.trim()}
            onClick={() => void send()}
          >
            Send
          </button>
        </div>
      ) : (
        <div className="chat-composer key-prompt">
          <p className="muted">Save a runtime key to start chatting.</p>
          <button type="button" className="button primary" onClick={onOpenKeySettings}>
            Add runtime key
          </button>
        </div>
      )}
    </>
  );
}
