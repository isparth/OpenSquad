import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "@/lib/api/client.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { AgentForm } from "./AgentForm.js";
import { AvatarPicker } from "./AvatarPicker.js";
import { DeleteAgentDialog } from "./DeleteAgentDialog.js";
import { useApiResource } from "./useApiResource.js";

export function AgentDetails({
  id,
  busy,
  onChanged,
  onDeleted,
  onBusyChange,
  onOpenChat,
  startEditing,
}: {
  id: string;
  busy: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onBusyChange: (busy: boolean) => void;
  onOpenChat: () => void;
  startEditing?: boolean;
}) {
  const load = useCallback((api: ApiClient, signal: AbortSignal) => api.getAgent(id, signal), [id]);
  const { data: agent, error, loading, refresh } = useApiResource(load);
  const [editing, setEditing] = useState(startEditing ?? false);
  const [deleting, setDeleting] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (agent && !editing) heading.current?.focus();
  }, [agent, editing]);
  function changed() {
    refresh();
    onChanged();
  }

  if (loading)
    return (
      <div className="panel-state" role="status">
        Loading bot…
      </div>
    );
  if (error)
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
            : error.message}
        </p>
        <button type="button" className="button secondary" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  if (!agent) return null;
  if (editing)
    return (
      <AgentForm
        agent={agent}
        onBusyChange={onBusyChange}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          changed();
        }}
      />
    );

  return (
    <article className="agent-detail" data-testid="agent-details">
      <div className="agent-detail-header">
        <AgentAvatar agent={agent} large />
        <div className="agent-identity">
          <p className="eyebrow">Bot profile</p>
          <h2 ref={heading} tabIndex={-1}>
            {agent.name}
          </h2>
          {agent.label && <span className="tag">{agent.label}</span>}
        </div>
        <button type="button" className="button primary" disabled={busy} onClick={onOpenChat}>
          Open chat
        </button>
        <button
          ref={editButton}
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          Edit bot
        </button>
      </div>
      <section className="detail-section">
        <h3>About</h3>
        <p className={`preserve-text${agent.description ? "" : " muted"}`}>
          {agent.description || "No description yet. Add a few words about what this bot does."}
        </p>
      </section>
      <section className="detail-section">
        <h3>Instructions</h3>
        <div className={`instructions-preview preserve-text${agent.instructions ? "" : " muted"}`}>
          {agent.instructions || "No instructions yet. Define how this bot should work."}
        </div>
      </section>
      <section className="detail-section">
        <h3>Sandbox</h3>
        <p className={agent.sandboxEnabled ? "" : "muted"}>
          {agent.sandboxEnabled
            ? "On. New conversations get an OpenAI-hosted sandbox for running code and working with files."
            : "Off. This bot chats without a sandbox. Turn it on in Edit bot."}
        </p>
      </section>
      <section className="detail-section">
        <h3>Appearance</h3>
        <AvatarPicker
          agentId={agent.id}
          disabled={busy}
          onBusyChange={onBusyChange}
          onChanged={changed}
        />
      </section>
      <div className="detail-footer">
        <p className="muted">
          Saved to your workspace. Chat uses the runtime key saved on this device.
        </p>
        <button
          type="button"
          className="button danger-quiet"
          disabled={busy}
          onClick={() => setDeleting(true)}
        >
          Delete bot
        </button>
      </div>
      {deleting && (
        <DeleteAgentDialog
          agent={agent}
          onBusyChange={onBusyChange}
          onDeleted={onDeleted}
          onClose={() => setDeleting(false)}
        />
      )}
    </article>
  );
}
