import { useEffect, useId, useRef, useState } from "react";
import type { RuntimeKeyStatus } from "../../../../shared/ipc.js";
import { useRuntimeKey } from "./RuntimeKeyContext.js";

const REASON_COPY: Record<string, string> = {
  "not-configured": "No runtime key saved.",
  "secure-storage-unavailable":
    "This device can't encrypt the key securely, so saving is disabled.",
  "authentication-required":
    "Saving a key requires sign-in, which isn't available in this build yet.",
  "origin-not-allowed": "Key storage is only available for the local development API.",
  "origin-changed":
    "The saved key belongs to a different API address. Remove it, then save a new one.",
  "corrupt-storage": "The saved key can't be read. Remove it, then save a new one.",
};

function statusCopy(status: RuntimeKeyStatus | null): string {
  if (!status) return "Checking key status…";
  if (status.state === "configured") return "A runtime key is saved on this device.";
  return REASON_COPY[status.reason] ?? "Runtime key storage is unavailable.";
}

function canRemove(status: RuntimeKeyStatus | null): boolean {
  return (
    status?.state === "configured" ||
    (status?.state === "unavailable" &&
      (status.reason === "origin-changed" || status.reason === "corrupt-storage"))
  );
}

function canSave(status: RuntimeKeyStatus | null): boolean {
  return (
    status?.state === "configured" ||
    (status?.state === "unavailable" && status.reason === "not-configured")
  );
}

export function RuntimeKeyDialog({ onClose }: { onClose: () => void }) {
  const { status, error, save, remove } = useRuntimeKey();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => {
      if (element?.open) element.close();
    };
  }, []);

  async function submit() {
    const value = key.trim();
    setBusy(true);
    try {
      await save(value);
    } catch {
      // the context exposes the message via error
    } finally {
      setKey("");
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await remove();
    } catch {
      // the context exposes the message via error
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby={`${id}-title`}
      data-testid="runtime-key-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={`${id}-title`}>Runtime key</h2>
      <p role="status" className="muted">
        {statusCopy(status)}
      </p>
      <div className="field">
        <label htmlFor="runtime-key">Runtime key</label>
        <input
          ref={input}
          id="runtime-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          disabled={busy || !canSave(status)}
          onChange={(event) => setKey(event.target.value)}
        />
        <p className="field-hint">
          Stored encrypted with your OS keychain. Used only to run your bots; never shown again.
        </p>
      </div>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
          Close
        </button>
        {canRemove(status) && (
          <button
            type="button"
            className="button danger-quiet"
            disabled={busy}
            onClick={() => void clear()}
          >
            Remove
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={busy || !key.trim() || !canSave(status)}
          onClick={() => void submit()}
        >
          Save
        </button>
      </div>
    </dialog>
  );
}
