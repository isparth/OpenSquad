import { useState } from "react";
import type { AgentRecord, ApiClient } from "@/lib/api/client.js";
import { ChatView } from "../chat/ChatView.js";
import { useRuntimeKey } from "../runtime-key/RuntimeKeyContext.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { AgentDetails } from "./AgentDetails.js";
import { AgentForm } from "./AgentForm.js";
import { useApiResource } from "./useApiResource.js";

const loadAgents = (api: ApiClient, signal: AbortSignal) => api.listAgents(signal);
type View =
  | { kind: "empty" }
  | { kind: "create" }
  | { kind: "detail"; id: string }
  | { kind: "chat"; id: string };

export function BotsPage() {
  const { data: agents, error, loading, refresh } = useApiResource(loadAgents);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const { openKeyDialog } = useRuntimeKey();
  const filtered =
    agents?.filter((agent) =>
      `${agent.name} ${agent.label ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) ?? [];
  function saved(agent: AgentRecord) {
    setView({ kind: "detail", id: agent.id });
    refresh();
  }

  return (
    <section className="bots-page" aria-labelledby="bots-title">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Your workspace</p>
          <h1 id="bots-title">
            Bots <span className="count">{agents?.length ?? "—"}</span>
          </h1>
          <p className="muted">A team shaped around the way you work.</p>
        </div>
        <button
          type="button"
          className="button primary"
          data-testid="create-agent"
          disabled={busy}
          onClick={() => setView({ kind: "create" })}
        >
          <span aria-hidden="true">+</span> New bot
        </button>
      </header>
      <div className="bots-layout">
        <aside className="bot-directory" aria-label="Your bots">
          <div className="directory-toolbar">
            <label className="sr-only" htmlFor="bot-search">
              Search bots
            </label>
            <input
              id="bot-search"
              type="search"
              placeholder="Search bots…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              type="button"
              className="button text-button"
              disabled={busy || loading}
              onClick={refresh}
              aria-label="Refresh bots"
            >
              Refresh
            </button>
          </div>
          {loading && (
            <div className="list-state" role="status">
              Loading your bots…
            </div>
          )}
          {error && (
            <div className="list-state">
              <p role="alert" className="error-message">
                {error.message}
              </p>
              <button type="button" className="button secondary" onClick={refresh}>
                Retry
              </button>
            </div>
          )}
          {!loading && !error && agents?.length === 0 && (
            <div className="list-state">
              <h2>No bots yet</h2>
              <p className="muted">Create your first bot to get started.</p>
            </div>
          )}
          {!loading && !error && agents && agents.length > 0 && filtered.length === 0 && (
            <p className="list-state muted">No bots match your search.</p>
          )}
          <ul className="bot-list" data-testid="agent-list">
            {filtered.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className={`bot-list-item${(view.kind === "detail" || view.kind === "chat") && view.id === agent.id ? " selected" : ""}`}
                  aria-label={`${agent.name} ${agent.label || "No label"}`}
                  aria-current={
                    (view.kind === "detail" || view.kind === "chat") && view.id === agent.id
                      ? "true"
                      : undefined
                  }
                  disabled={busy}
                  onClick={() => setView({ kind: "detail", id: agent.id })}
                >
                  <AgentAvatar agent={agent} />
                  <span className="bot-list-copy">
                    <span className="bot-list-name">{agent.name}</span>
                    <span className="muted">{agent.label || "No label"}</span>
                  </span>
                  <span className="list-chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="directory-note">Your bots and settings stay saved between sessions.</p>
        </aside>
        <div className="bot-panel" aria-live="polite">
          {view.kind === "create" && (
            <AgentForm
              key="create"
              onSaved={saved}
              onCancel={() => setView({ kind: "empty" })}
              onBusyChange={setBusy}
            />
          )}
          {view.kind === "detail" && (
            <AgentDetails
              key={view.id}
              id={view.id}
              busy={busy}
              onChanged={refresh}
              onDeleted={() => {
                setView({ kind: "empty" });
                refresh();
              }}
              onBusyChange={setBusy}
              onOpenChat={() => setView({ kind: "chat", id: view.id })}
            />
          )}
          {view.kind === "chat" && (
            <ChatView
              key={view.id}
              id={view.id}
              onBack={() => setView({ kind: "detail", id: view.id })}
              onOpenKeySettings={openKeyDialog}
            />
          )}
          {view.kind === "empty" && (
            <div className="panel-state welcome-panel">
              <span className="empty-mark" aria-hidden="true">
                O
              </span>
              <h2>Make room for your next teammate.</h2>
              <p className="muted">
                Select a bot to see its profile, or create one with a name, a purpose, and a way of
                working.
              </p>
              <p className="workspace-note">No model key needed to manage your bots.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
