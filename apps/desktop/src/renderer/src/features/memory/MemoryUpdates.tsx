import type { MemoryDocument, MemoryDocumentName, MemoryUpdate } from "@opensquad/core";
import { useEffect, useRef, useState } from "react";
import { getApiClient } from "@/lib/api/client.js";
import { useRuntimeKey } from "../runtime-key/RuntimeKeyContext.js";

const noKeyMessage = "Add your OpenAI key to update memory.";
const labels: Record<MemoryDocumentName, string> = {
  profile: "About you",
  preferences: "Preferences",
  notes: "Notes for this bot",
};

function updateStatus(update: MemoryUpdate | null): string {
  if (!update) return "No updates yet.";
  const time = new Date(update.createdAt).toLocaleString();
  const tokens = update.usage
    ? ` · ${update.usage.inputTokens + update.usage.outputTokens} tokens`
    : "";
  let message: string;
  if (update.status === "running") {
    message = "Updating memory from your recent conversations…";
  } else if (update.status === "succeeded" && update.errorCode === "memory_changed") {
    const changed = update.changed.map((change) => labels[change.name]);
    message = `Updated ${time}${changed.length ? `: ${changed.join(", ")}` : ""}. Some memory was edited during the update, so those conversations will be read again next time.`;
  } else if (update.status === "succeeded" && update.changed.length > 0) {
    message = `Updated ${time}: ${update.changed.map((change) => labels[change.name]).join(", ")}.`;
  } else if (update.status === "succeeded" && update.errorCode === null) {
    message = `Checked ${time}. Nothing new to remember.`;
  } else if (update.errorCode === "output_too_long") {
    message = `The last update (${time}) wrote too much and was discarded. It will try again next time.`;
  } else {
    message = `The last update (${time}) didn't finish. It will try again next time.`;
  }
  return `${message}${tokens}`;
}

export function MemoryUpdates({
  agentId,
  autoUpdate,
  lastUpdate,
  disabled,
  onFinished,
}: {
  agentId: string;
  autoUpdate: boolean;
  lastUpdate: MemoryUpdate | null;
  disabled: boolean;
  onFinished: (documents: MemoryDocument[]) => void;
}) {
  const { status: runtimeKeyStatus } = useRuntimeKey();
  const keyConfigured = runtimeKeyStatus?.state === "configured";
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(autoUpdate);
  const [latestUpdate, setLatestUpdate] = useState(lastUpdate);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    setAutoUpdateEnabled(autoUpdate);
  }, [autoUpdate]);

  useEffect(() => {
    setLatestUpdate(lastUpdate);
    setActionStatus(null);
  }, [lastUpdate]);

  const runningUpdateId = latestUpdate?.status === "running" ? latestUpdate.id : null;
  useEffect(() => {
    if (!runningUpdateId) return;
    const controller = new AbortController();
    let stopped = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const api = await getApiClient();
        const result = await api.getMemory(agentId, controller.signal);
        if (stopped || controller.signal.aborted) return;
        setLatestUpdate(result.lastUpdate);
        if (result.lastUpdate?.status === "running") {
          timer = window.setTimeout(() => void poll(), 2_000);
        } else {
          setActionStatus(null);
          onFinishedRef.current(result.documents);
        }
      } catch {
        if (!stopped && !controller.signal.aborted)
          timer = window.setTimeout(() => void poll(), 2_000);
      }
    }

    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller.abort();
    };
  }, [agentId, runningUpdateId]);

  async function changeAutoUpdate(next: boolean) {
    if (disabled || settingsBusy) return;
    const previous = autoUpdateEnabled;
    setAutoUpdateEnabled(next);
    setSettingsError(null);
    setSettingsBusy(true);
    try {
      const api = await getApiClient();
      setAutoUpdateEnabled(await api.setMemoryAutoUpdate(next));
    } catch (error) {
      setAutoUpdateEnabled(previous);
      setSettingsError(error instanceof Error ? error.message : "Couldn't update memory settings.");
    } finally {
      setSettingsBusy(false);
    }
  }

  async function updateNow() {
    if (disabled || refreshBusy || latestUpdate?.status === "running" || !keyConfigured) return;
    setRefreshBusy(true);
    setRefreshError(null);
    setActionStatus(null);
    try {
      const result = await window.opensquad.refreshMemory({ agentId });
      if (result.update === null) {
        setActionStatus("Nothing new to read. Memory is up to date.");
      } else {
        setLatestUpdate(result.update);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "runtime credential unavailable") setRefreshError(noKeyMessage);
      else if (message === "rate limited")
        setRefreshError("Too many memory updates this hour. Try again later.");
      else if (message === "request conflict") setRefreshError("This runtime can't update memory.");
      else setRefreshError("Couldn't start a memory update.");
    } finally {
      setRefreshBusy(false);
    }
  }

  return (
    <section className="memory-updates" aria-label="Automatic memory updates">
      <label className="memory-auto-toggle">
        <input
          type="checkbox"
          role="switch"
          aria-checked={autoUpdateEnabled}
          checked={autoUpdateEnabled}
          disabled={disabled || settingsBusy}
          aria-describedby="memory-auto-update-description"
          onChange={(event) => void changeAutoUpdate(event.currentTarget.checked)}
        />
        <span>Update memory automatically</span>
      </label>
      <p id="memory-auto-update-description" className="muted memory-auto-description">
        When you start a new conversation, this bot reads your earlier conversations with it and
        updates memory. Each update makes one model call on your OpenAI key. This setting applies to
        all your bots.
      </p>
      <div className="memory-update-controls">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || refreshBusy || latestUpdate?.status === "running" || !keyConfigured}
          onClick={() => void updateNow()}
        >
          Update now
        </button>
        {!keyConfigured && <span className="muted memory-key-hint">{noKeyMessage}</span>}
      </div>
      <p className="memory-update-status" role="status" aria-live="polite">
        {actionStatus ?? updateStatus(latestUpdate)}
      </p>
      {settingsError && (
        <p className="error-message memory-update-error" role="alert">
          {settingsError}
        </p>
      )}
      {refreshError && (refreshError !== noKeyMessage || keyConfigured) && (
        <p className="error-message memory-update-error" role="alert">
          {refreshError}
        </p>
      )}
    </section>
  );
}
