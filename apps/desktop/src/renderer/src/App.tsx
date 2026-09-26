import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge.js";
import { BotsPage } from "@/features/agents/BotsPage.js";
import { useHealth } from "@/features/home/useHealth.js";
import { RuntimeKeyProvider, useRuntimeKey } from "@/features/runtime-key/RuntimeKeyContext.js";
import { RuntimeKeyDialog } from "@/features/runtime-key/RuntimeKeyDialog.js";
import { ToolsDialog } from "@/features/tools/ToolsDialog.js";
import type { RuntimeKeyStatus } from "../../shared/ipc.js";

function keyLabel(status: RuntimeKeyStatus | null): string {
  if (status?.state === "configured") return "Saved";
  if (status?.state === "unavailable" && status.reason === "not-configured") return "Not set";
  return "Unavailable";
}

function Header() {
  const { status, check } = useHealth();
  const { status: keyStatus, keyDialogOpen, openKeyDialog, closeKeyDialog } = useRuntimeKey();
  const [toolsStatus, setToolsStatus] = useState<RuntimeKeyStatus | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  useEffect(() => {
    void window.opensquad
      .getToolsKeyStatus()
      .then(setToolsStatus)
      .catch(() => {});
  }, []);
  return (
    <header className="app-navigation">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          O
        </span>
        <span>OpenSquad</span>
        <span className="brand-divider" aria-hidden="true">
          /
        </span>
        <span className="muted">Workspace</span>
      </div>
      <button type="button" className="connection-button key-button" onClick={openKeyDialog}>
        Runtime key <span className="muted">{keyLabel(keyStatus)}</span>
      </button>
      <button
        type="button"
        className="connection-button key-button"
        onClick={() => setToolsOpen(true)}
      >
        Tools <span className="muted">{keyLabel(toolsStatus)}</span>
      </button>
      <button
        type="button"
        className="connection-button"
        onClick={() => void check()}
        aria-label="Check API connection"
      >
        <StatusBadge status={status} />
      </button>
      {keyDialogOpen && <RuntimeKeyDialog onClose={closeKeyDialog} />}
      {toolsOpen && (
        <ToolsDialog onClose={() => setToolsOpen(false)} onStatusChange={setToolsStatus} />
      )}
    </header>
  );
}

export function App() {
  return (
    <RuntimeKeyProvider>
      <div className="app-shell">
        <div className="titlebar-drag h-9 shrink-0" />
        <Header />
        <main className="app-main">
          <BotsPage />
        </main>
      </div>
    </RuntimeKeyProvider>
  );
}
