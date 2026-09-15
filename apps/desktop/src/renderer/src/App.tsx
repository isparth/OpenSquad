import { StatusBadge } from "@/components/StatusBadge.js";
import { BotsPage } from "@/features/agents/BotsPage.js";
import { useHealth } from "@/features/home/useHealth.js";

export function App() {
  const { status, check } = useHealth();
  return (
    <div className="app-shell">
      <div className="titlebar-drag h-9 shrink-0" />
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
        <button
          type="button"
          className="connection-button"
          onClick={() => void check()}
          aria-label="Check API connection"
        >
          <StatusBadge status={status} />
        </button>
      </header>
      <main className="app-main">
        <BotsPage />
      </main>
    </div>
  );
}
