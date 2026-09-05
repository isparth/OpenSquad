import { useCallback, useEffect, useState } from "react";
import { getApiClient } from "@/lib/api/client.js";

export type HealthStatus = { kind: "checking" } | { kind: "up" } | { kind: "down"; reason: string };

export function useHealth() {
  const [status, setStatus] = useState<HealthStatus>({ kind: "checking" });

  const check = useCallback(async () => {
    setStatus({ kind: "checking" });
    try {
      const api = await getApiClient();
      const health = await api.health();
      setStatus(health.ok ? { kind: "up" } : { kind: "down", reason: `db ${health.db}` });
    } catch (error) {
      setStatus({ kind: "down", reason: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return { status, check };
}
