import { StatusBadge } from "@/components/StatusBadge.js";
import { BotsPage } from "@/features/agents/BotsPage.js";
import { useHealth } from "@/features/home/useHealth.js";
import { RuntimeKeyProvider, useRuntimeKey } from "@/features/runtime-key/RuntimeKeyContext.js";
import { RuntimeKeyDialog } from "@/features/runtime-key/RuntimeKeyDialog.js";

function Header() {
  const { status, check } = useHealth();
  const { status: keyStatus, keyDialogOpen, openKeyDialog, closeKeyDialog } = useRuntimeKey();
  const keyLabel =
    keyStatus?.state === "configured"
      ? "Saved"
      : keyStatus?.state === "unavailable" && keyStatus.reason === "not-configured"
        ? "Not set"
        : "Unavailable";
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
        Runtime key <span className="muted">{keyLabel}</span>
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
