import type { MemoryDocument, MemoryDocumentName, MemoryRevision } from "@opensquad/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type ApiClient, ApiError, getApiClient } from "@/lib/api/client.js";
import { useApiResource } from "../agents/useApiResource.js";
import { ForgetMemoryDialog } from "./ForgetMemoryDialog.js";
import { MemoryUpdates } from "./MemoryUpdates.js";

const tabs: Array<{ name: MemoryDocumentName; label: string; placeholder: string }> = [
  {
    name: "profile",
    label: "About you",
    placeholder: "Who you are: name, role, background, anything you want every bot to know.",
  },
  {
    name: "preferences",
    label: "Preferences",
    placeholder: "How you like bots to talk and work with you: tone, length, format, language.",
  },
  {
    name: "notes",
    label: "Notes for this bot",
    placeholder: "Context only this bot needs: projects, decisions, things to keep in mind.",
  },
];
const conflictMessage =
  "This memory changed somewhere else. Reload to get the latest version; unsaved changes on this tab will be lost.";
const revisionAuthors = {
  user: "Edited by you",
  revert: "Restored",
  extraction: "Updated from a conversation",
} as const;

export function MemoryPanel({
  agentId,
  disabled,
  onBusyChange,
}: {
  agentId: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const load = useCallback(
    (api: ApiClient, signal: AbortSignal) => api.getMemory(agentId, signal),
    [agentId],
  );
  const { data, error, loading, refresh } = useApiResource(load);
  const [memoryDocuments, setMemoryDocuments] = useState<MemoryDocument[] | null>(null);
  const [selected, setSelected] = useState<MemoryDocumentName>("profile");
  const [drafts, setDrafts] = useState<
    Partial<Record<MemoryDocumentName, { content: string; baseVersion: number }>>
  >({});
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [history, setHistory] = useState<MemoryRevision[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [forgetOpen, setForgetOpen] = useState(false);
  const id = useId();
  const tabRefs = useRef<Partial<Record<MemoryDocumentName, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (data) setMemoryDocuments(data.documents);
  }, [data]);

  const current = memoryDocuments?.find((item) => item.name === selected);
  const tab = tabs.find((item) => item.name === selected);
  if (loading)
    return (
      <div className="list-state" role="status">
        Loading memory…
      </div>
    );
  if (error)
    return (
      <div className="list-state">
        <p role="alert" className="error-message">
          {error.message}
        </p>
        <button type="button" className="button secondary" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  if (!current || !tab || !memoryDocuments) return null;

  const draft = drafts[selected];
  const loadedVersion = current.version;
  const expectedVersion = draft?.baseVersion ?? loadedVersion;
  const currentText = draft?.content ?? current.content;
  const dirty = draft !== undefined && draft.content !== current.content;
  const excess = Math.max(0, currentText.length - current.limit);
  const busy = disabled || mutationBusy;

  function handleEdit(content: string) {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [selected]: {
        content,
        baseVersion: currentDrafts[selected]?.baseVersion ?? loadedVersion,
      },
    }));
    setSaved(false);
    setMutationError(null);
    setConflict(false);
  }

  function clearDraft(name: MemoryDocumentName) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  function acceptDocument(updated: MemoryDocument) {
    setMemoryDocuments(
      (current) =>
        current?.map((item) => (item.name === updated.name ? updated : item)) ?? [updated],
    );
  }

  async function loadHistory(name: MemoryDocumentName, cursor: string | null, append = false) {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const api = await getApiClient();
      const page = await api.listMemoryRevisions(agentId, name, cursor);
      setHistory((current) => (append ? [...current, ...page.items] : page.items));
      setHistoryCursor(page.nextCursor);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Unable to load memory history");
    } finally {
      setHistoryLoading(false);
    }
  }

  function handleUpdateFinished(documents: MemoryDocument[]) {
    setMemoryDocuments(documents);
    if (historyOpen) void loadHistory(selected, null);
  }

  async function save() {
    if (!dirty || excess || busy) return;
    setMutationBusy(true);
    onBusyChange(true);
    setMutationError(null);
    setConflict(false);
    try {
      const api = await getApiClient();
      const updated = await api.saveMemory(agentId, selected, currentText, expectedVersion);
      acceptDocument(updated);
      clearDraft(selected);
      setSaved(true);
      if (historyOpen) await loadHistory(selected, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setMutationError(conflictMessage);
        setConflict(true);
      } else setMutationError(error instanceof Error ? error.message : "Unable to save memory");
    } finally {
      setMutationBusy(false);
      onBusyChange(false);
    }
  }

  async function restore(revision: MemoryRevision) {
    if (busy) return;
    setMutationBusy(true);
    onBusyChange(true);
    setMutationError(null);
    setConflict(false);
    try {
      const api = await getApiClient();
      const updated = await api.revertMemory(agentId, selected, revision.version, expectedVersion);
      acceptDocument(updated);
      clearDraft(selected);
      setSaved(false);
      await loadHistory(selected, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setMutationError(conflictMessage);
        setConflict(true);
      } else setMutationError(error instanceof Error ? error.message : "Unable to restore memory");
    } finally {
      setMutationBusy(false);
      onBusyChange(false);
    }
  }

  function reload() {
    setDrafts({});
    setSaved(false);
    setMutationError(null);
    setConflict(false);
    setHistoryError(null);
    refresh();
  }

  function changeTab(name: MemoryDocumentName) {
    setSelected(name);
    setHistoryOpen(false);
    setHistoryError(null);
    setHistory([]);
    setHistoryCursor(null);
    setExpanded(new Set());
    tabRefs.current[name]?.focus();
  }

  return (
    <div className="memory-panel">
      <p className="muted memory-intro">
        Your bots read this at the start of each new conversation. Changes apply to new
        conversations, not ones already open.
      </p>
      <MemoryUpdates
        key={agentId}
        agentId={agentId}
        autoUpdate={data?.autoUpdate ?? true}
        lastUpdate={data?.lastUpdate ?? null}
        disabled={busy}
        onFinished={handleUpdateFinished}
      />
      <div className="memory-tabs" role="tablist" aria-label="Memory documents">
        {tabs.map((item, index) => (
          <button
            ref={(element) => {
              tabRefs.current[item.name] = element;
            }}
            id={`${id}-tab-${item.name}`}
            key={item.name}
            type="button"
            role="tab"
            className="memory-tab"
            aria-selected={selected === item.name}
            aria-controls={`${id}-panel`}
            tabIndex={selected === item.name ? 0 : -1}
            disabled={busy}
            onClick={() => changeTab(item.name)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const next = tabs[(index + delta + tabs.length) % tabs.length];
              if (next) changeTab(next.name);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${tab.name}`}
        className="memory-tabpanel"
      >
        <p className="muted memory-scope">
          {current.scope === "shared"
            ? "Shared with all your bots."
            : "Only this bot sees these notes."}
        </p>
        <label className="sr-only" htmlFor={`${id}-editor`}>
          {tab.label}
        </label>
        <textarea
          id={`${id}-editor`}
          disabled={busy}
          value={currentText}
          placeholder={tab.placeholder}
          onChange={(event) => handleEdit(event.target.value)}
        />
        <div className={`memory-counter${excess ? " over" : ""}`}>
          <span>
            {currentText.length} / {current.limit}
          </span>
          {excess > 0 && <span>Too long by {excess} characters</span>}
        </div>
        {mutationError && (
          <div role="alert" className="error-message memory-mutation-error">
            <p>{mutationError}</p>
            {conflict && (
              <button type="button" className="button secondary" disabled={busy} onClick={reload}>
                Reload
              </button>
            )}
          </div>
        )}
        <p role="status" className="memory-saved">
          {saved ? "Saved" : ""}
        </p>
        <div className="memory-actions">
          <button
            type="button"
            className="button primary"
            disabled={!dirty || excess > 0 || busy}
            onClick={() => void save()}
          >
            Save
          </button>
          {dirty && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => clearDraft(selected)}
            >
              Discard changes
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              const open = !historyOpen;
              setHistoryOpen(open);
              if (open) void loadHistory(selected, null);
            }}
          >
            {historyOpen ? "Hide history" : "History"}
          </button>
        </div>
        {historyOpen && (
          <div className="memory-history">
            {historyLoading && <p role="status">Loading history…</p>}
            {historyError && (
              <p role="alert" className="error-message">
                {historyError}
              </p>
            )}
            {!historyLoading && !historyError && history.length === 0 && <p>No history yet.</p>}
            {history.map((revision) => {
              const isExpanded = expanded.has(revision.version);
              return (
                <div className="memory-revision" key={revision.version}>
                  <div className="memory-revision-heading">
                    <span>
                      Version {revision.version} · {revisionAuthors[revision.author]} ·{" "}
                      {new Date(revision.createdAt).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      className="button text-button"
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(revision.version)) next.delete(revision.version);
                          else next.add(revision.version);
                          return next;
                        })
                      }
                    >
                      {isExpanded ? "Hide" : "View"}
                    </button>
                    {revision.version !== current.version && (
                      <button
                        type="button"
                        className="button text-button"
                        disabled={busy}
                        onClick={() => void restore(revision)}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="preserve-text memory-revision-content">{revision.content}</div>
                  )}
                </div>
              );
            })}
            {historyCursor && (
              <button
                type="button"
                className="button text-button"
                disabled={historyLoading}
                onClick={() => void loadHistory(selected, historyCursor, true)}
              >
                Load older
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="button danger-quiet memory-forget"
        disabled={busy}
        onClick={() => setForgetOpen(true)}
      >
        Forget everything
      </button>
      {forgetOpen && (
        <ForgetMemoryDialog
          onBusyChange={onBusyChange}
          onClose={() => setForgetOpen(false)}
          onForgotten={() => {
            setForgetOpen(false);
            setDrafts({});
            setHistory([]);
            setHistoryCursor(null);
            setHistoryOpen(false);
            setSaved(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
