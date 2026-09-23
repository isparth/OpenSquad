import { useEffect, useId, useRef, useState } from "react";
import { getApiClient } from "@/lib/api/client.js";

export function ForgetMemoryDialog({
  onBusyChange,
  onForgotten,
  onClose,
}: {
  onBusyChange: (busy: boolean) => void;
  onForgotten: () => void;
  onClose: () => void;
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

  async function forget() {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    let forgotten = false;
    try {
      const api = await getApiClient();
      await api.forgetMemory();
      forgotten = true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to forget memory");
    } finally {
      setBusy(false);
      onBusyChange(false);
      if (forgotten) onForgotten();
    }
  }

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      data-testid="forget-memory-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={`${id}-title`}>Forget everything?</h2>
      <p id={`${id}-description`} className="muted">
        This permanently deletes About you and Preferences, which all your bots share, plus every
        bot's notes and all history. It cannot be undone.
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
          Keep memory
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={() => void forget()}
        >
          {busy ? "Forgetting…" : "Forget everything"}
        </button>
      </div>
    </dialog>
  );
}
