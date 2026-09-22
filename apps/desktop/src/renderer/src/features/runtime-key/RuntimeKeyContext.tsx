import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { RuntimeKeyStatus } from "../../../../shared/ipc.js";

interface RuntimeKeyContextValue {
  status: RuntimeKeyStatus | null;
  loading: boolean;
  error: string | null;
  keyDialogOpen: boolean;
  openKeyDialog(): void;
  closeKeyDialog(): void;
  refresh(): void;
  save(key: string): Promise<void>;
  remove(): Promise<void>;
}

const RuntimeKeyContext = createContext<RuntimeKeyContextValue | null>(null);

export function RuntimeKeyProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RuntimeKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    void window.opensquad
      .getRuntimeKeyStatus()
      .then((result) => setStatus(result))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Unable to read runtime key status"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const save = useCallback(async (key: string) => {
    setError(null);
    try {
      setStatus(await window.opensquad.setRuntimeKey(key));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save runtime key");
      throw err;
    }
  }, []);

  const remove = useCallback(async () => {
    setError(null);
    try {
      setStatus(await window.opensquad.deleteRuntimeKey());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove runtime key");
      throw err;
    }
  }, []);

  const openKeyDialog = useCallback(() => setKeyDialogOpen(true), []);
  const closeKeyDialog = useCallback(() => setKeyDialogOpen(false), []);

  return (
    <RuntimeKeyContext.Provider
      value={{
        status,
        loading,
        error,
        keyDialogOpen,
        openKeyDialog,
        closeKeyDialog,
        refresh,
        save,
        remove,
      }}
    >
      {children}
    </RuntimeKeyContext.Provider>
  );
}

export function useRuntimeKey(): RuntimeKeyContextValue {
  const value = useContext(RuntimeKeyContext);
  if (!value) throw new Error("useRuntimeKey must be used inside RuntimeKeyProvider");
  return value;
}
