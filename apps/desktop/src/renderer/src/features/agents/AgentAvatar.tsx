import { useEffect, useState } from "react";
import { type AgentRecord, getApiClient } from "@/lib/api/client.js";

export function AgentAvatar({ agent, large = false }: { agent: AgentRecord; large?: boolean }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setSource(null);
    if (agent.avatarUrl) {
      void getApiClient()
        .then((api) => api.getAvatar(agent, controller.signal))
        .then((blob) => {
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setSource(objectUrl);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSource(null);
        });
    }
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agent]);
  return (
    <span className={`agent-avatar${large ? " large" : ""}`} aria-hidden="true">
      {source ? (
        <img src={source} alt="" onError={() => setSource(null)} />
      ) : (
        agent.name.trim().slice(0, 2).toUpperCase() || "B"
      )}
    </span>
  );
}
