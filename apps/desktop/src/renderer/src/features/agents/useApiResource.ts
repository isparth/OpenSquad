import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, getApiClient } from "@/lib/api/client.js";

export function useApiResource<T>(load: (api: ApiClient, signal: AbortSignal) => Promise<T>) {
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const refresh = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ data: null, error: null, loading: true });
    void getApiClient()
      .then((api) => load(api, controller.signal))
      .then(
        (data) => {
          if (!controller.signal.aborted) setState({ data, error: null, loading: false });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              data: null,
              error: error instanceof Error ? error : new Error("Request failed"),
              loading: false,
            });
        },
      );
  }, [load]);
  useEffect(() => {
    refresh();
    return () => active.current?.abort();
  }, [refresh]);
  return { ...state, refresh };
}
