import type { ToolConnection, ToolConnectionStatus, Toolkit } from "@opensquad/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ToolsKeyStatus } from "../../../../shared/ipc.js";

const REASON_COPY: Record<string, string> = {
  "not-configured": "No Composio key saved.",
  "secure-storage-unavailable":
    "This device can't encrypt the key securely, so saving is disabled.",
  "authentication-required":
    "Saving a key requires sign-in, which isn't available in this build yet.",
  "origin-not-allowed": "Key storage is only available for the local development API.",
  "origin-changed":
    "The saved key belongs to a different API address. Remove it, then save a new one.",
  "corrupt-storage": "The saved key can't be read. Remove it, then save a new one.",
};

const STATUS_COPY: Record<ToolConnectionStatus, string> = {
  active: "Connected",
  pending: "Waiting for approval",
  attention: "Needs reconnecting",
};

const KEY_REJECTED = "Composio rejected this key. Check it's a project key (starts with ak_).";

function statusCopy(status: ToolsKeyStatus | null): string {
  if (!status) return "Checking key status…";
  if (status.state === "configured") return "A Composio key is saved on this device.";
  return REASON_COPY[status.reason] ?? "Composio key storage is unavailable.";
}

function canRemove(status: ToolsKeyStatus | null): boolean {
  return (
    status?.state === "configured" ||
    (status?.state === "unavailable" &&
      (status.reason === "origin-changed" || status.reason === "corrupt-storage"))
  );
}

function canSave(status: ToolsKeyStatus | null): boolean {
  return (
    status?.state === "configured" ||
    (status?.state === "unavailable" && status.reason === "not-configured")
  );
}

function errorCopy(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "tools key rejected") return KEY_REJECTED;
  return message || "Something went wrong.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

interface ToolsDialogProps {
  onClose(): void;
  onStatusChange?(status: ToolsKeyStatus): void;
  searchDelayMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export function ToolsDialog({
  onClose,
  onStatusChange,
  searchDelayMs = 300,
  pollIntervalMs = 3_000,
  pollTimeoutMs = 5 * 60_000,
}: ToolsDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const names = useRef(new Map<string, string>());
  const [status, setStatus] = useState<ToolsKeyStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<ToolConnection[] | null>(null);
  const [query, setQuery] = useState("");
  const [toolkits, setToolkits] = useState<Toolkit[] | null>(null);
  const [pending, setPending] = useState<{ toolkit: string; connectionId: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const configured = status?.state === "configured";

  const updateStatus = useCallback(
    (next: ToolsKeyStatus) => {
      setStatus(next);
      onStatusChange?.(next);
    },
    [onStatusChange],
  );

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let active = true;
    void window.opensquad
      .getToolsKeyStatus()
      .then((next) => active && updateStatus(next))
      .catch((err: unknown) => active && setError(errorCopy(err)));
    return () => {
      active = false;
      if (element?.open) element.close();
    };
  }, [updateStatus]);

  const loadConnections = useCallback(async () => {
    const result = await window.opensquad.listToolConnections();
    setConnections(result.items);
    return result.items;
  }, []);

  useEffect(() => {
    if (!configured) {
      setConnections(null);
      return;
    }
    loadConnections().catch((err: unknown) => setError(errorCopy(err)));
  }, [configured, loadConnections]);

  useEffect(() => {
    if (!configured) {
      setToolkits(null);
      return;
    }
    let active = true;
    const search = query.trim();
    const timer = setTimeout(() => {
      window.opensquad
        .listToolkits(search ? { search } : {})
        .then((result) => {
          if (!active) return;
          for (const item of result.items) names.current.set(item.slug, item.name);
          setToolkits(result.items);
        })
        .catch((err: unknown) => active && setError(errorCopy(err)));
    }, searchDelayMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [configured, query, searchDelayMs]);

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let polling = false;
    const interval = setInterval(() => {
      if (polling) return;
      polling = true;
      window.opensquad
        .listToolConnections()
        .then(({ items }) => {
          if (!active) return;
          setConnections(items);
          const done = items.some(
            (item) =>
              item.status === "active" &&
              (item.id === pending.connectionId || item.toolkit === pending.toolkit),
          );
          if (done) setPending(null);
        })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, pollIntervalMs);
    const timeout = setTimeout(() => {
      if (!active) return;
      setPending(null);
      setError("Connecting took too long. Try again.");
    }, pollTimeoutMs);
    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [pending, pollIntervalMs, pollTimeoutMs]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorCopy(err));
    } finally {
      setBusy(false);
    }
  }

  const saveKey = () =>
    run(async () => {
      const value = key.trim();
      setKey("");
      updateStatus(await window.opensquad.setToolsKey(value));
    });

  const removeKey = () =>
    run(async () => {
      setPending(null);
      updateStatus(await window.opensquad.deleteToolsKey());
    });

  const connect = (toolkit: string) =>
    run(async () => {
      const { connectionId } = await window.opensquad.startToolConnection({ toolkit });
      setPending({ toolkit, connectionId });
    });

  const disconnect = (connectionId: string) =>
    run(async () => {
      setConfirming(null);
      await window.opensquad.removeToolConnection({ connectionId });
      await loadConnections();
    });

  const nameFor = (slug: string) => names.current.get(slug) ?? slug;
  const visible = connections?.filter(
    (item) => item.status !== "pending" || item.id === pending?.connectionId,
  );
  const activeToolkits = new Set(
    (connections ?? []).filter((item) => item.status === "active").map((item) => item.toolkit),
  );

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog tools-dialog"
      aria-labelledby={`${id}-title`}
      data-testid="tools-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={`${id}-title`}>Tools</h2>
      <section className="tools-section">
        <p className="muted">{statusCopy(status)}</p>
        <div className="field">
          <label htmlFor={`${id}-key`}>Composio key</label>
          <input
            id={`${id}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            disabled={busy || !canSave(status)}
            onChange={(event) => setKey(event.target.value)}
          />
          <p className="field-hint">
            Your Composio project key. Stored encrypted; used only to connect apps and run tools.
          </p>
        </div>
        <div className="form-actions">
          {canRemove(status) && (
            <button
              type="button"
              className="button danger-quiet"
              disabled={busy}
              onClick={() => void removeKey()}
            >
              Remove
            </button>
          )}
          <button
            type="button"
            className="button primary"
            disabled={busy || !key.trim() || !canSave(status)}
            onClick={() => void saveKey()}
          >
            Save
          </button>
        </div>
      </section>

      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}

      {configured && (
        <>
          <section className="tools-section" aria-labelledby={`${id}-connected`}>
            <h3 id={`${id}-connected`}>Connected apps</h3>
            {visible?.length === 0 && <p className="muted">No apps connected yet.</p>}
            {visible && visible.length > 0 && (
              <ul className="tools-list" aria-label="Connected apps">
                {visible.map((item) => (
                  <li key={item.id} className="tools-row">
                    <div className="tools-row-copy">
                      <strong>{nameFor(item.toolkit)}</strong>
                      <span className="muted">
                        <span>{STATUS_COPY[item.status]}</span>
                        {formatDate(item.createdAt) && <span> · {formatDate(item.createdAt)}</span>}
                      </span>
                    </div>
                    {confirming === item.id ? (
                      <div className="tools-confirm">
                        <span>Bots lose access to this app.</span>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => setConfirming(null)}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          className="button danger"
                          aria-label={`Disconnect ${nameFor(item.toolkit)}`}
                          disabled={busy}
                          onClick={() => void disconnect(item.id)}
                        >
                          Disconnect
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="button text-button"
                        disabled={busy}
                        onClick={() => setConfirming(item.id)}
                      >
                        Disconnect
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="tools-section" aria-labelledby={`${id}-add`}>
            <h3 id={`${id}-add`}>Add an app</h3>
            {pending && (
              <div className="tools-pending" role="status">
                <span>Finish connecting in your browser…</span>
                <button type="button" className="button secondary" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            )}
            <div className="field">
              <label htmlFor={`${id}-search`}>Search apps</label>
              <input
                id={`${id}-search`}
                type="search"
                maxLength={100}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {toolkits && toolkits.length === 0 && <p className="muted">No matching apps.</p>}
            {toolkits && toolkits.length > 0 && (
              <ul className="tools-list" aria-label="Available apps">
                {toolkits.map((item) => (
                  <li key={item.slug} className="tools-row">
                    <div className="tools-row-copy">
                      <strong>{item.name}</strong>
                      <span className="muted">{item.description}</span>
                    </div>
                    {activeToolkits.has(item.slug) ? (
                      <button type="button" className="button secondary" disabled>
                        Connected
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button secondary"
                        aria-label={`Connect ${item.name}`}
                        disabled={busy || pending !== null}
                        onClick={() => void connect(item.slug)}
                      >
                        Connect
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <div className="form-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
