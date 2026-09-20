import { useEffect, useId, useRef, useState } from "react";
import { type AgentRecord, ApiError, getApiClient } from "@/lib/api/client.js";

export function DeleteAgentDialog({
  agent,
  onDeleted,
  onClose,
  onBusyChange,
}: {
  agent: AgentRecord;
  onDeleted: () => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus();
    return () => element?.close();
  }, []);
  async function remove() {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const api = await getApiClient();
      await api.deleteAgent(agent.id);
      onDeleted();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) onDeleted();
      else setError(error instanceof Error ? error.message : "Unable to delete bot");
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      data-testid="delete-agent-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={`${id}-title`}>Delete {agent.name}?</h2>
      <p id={`${id}-description`} className="muted">
        This removes the bot and its avatar. This action cannot be undone.
      </p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          ref={cancel}
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onClose}
        >
          Keep bot
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? "Deleting…" : "Delete bot"}
        </button>
      </div>
    </dialog>
  );
}
