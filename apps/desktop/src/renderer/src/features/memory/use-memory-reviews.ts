import type { MemoryReview } from "@opensquad/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getApiClient } from "@/lib/api/client.js";
import type { ReviewAction } from "./MemoryReviewItem.js";

export function useMemoryReviews(agentId: string, pendingCount: number, onChanged: () => void) {
  const [items, setItems] = useState<MemoryReview[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionIds, setActionIds] = useState<Set<string>>(() => new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const mounted = useRef(false);
  const generation = useRef(0);
  const lastLoadedAgentId = useRef(agentId);
  const requests = useRef(new Set<AbortController>());

  const abortRequests = useCallback(() => {
    for (const controller of requests.current) controller.abort();
    requests.current.clear();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      abortRequests();
    };
  }, [abortRequests]);

  const loadFirstPage = useCallback(
    (clear: boolean) => {
      const requestGeneration = ++generation.current;
      abortRequests();
      const controller = new AbortController();
      requests.current.add(controller);
      setLoading(true);
      setLoadingMore(false);
      setLoadError(null);
      setActionErrors({});
      if (clear) {
        setItems([]);
        setNextCursor(null);
      }
      void (async () => {
        try {
          const api = await getApiClient();
          const page = await api.listMemoryReviews(agentId, null, controller.signal);
          if (
            !mounted.current ||
            controller.signal.aborted ||
            requestGeneration !== generation.current
          )
            return;
          setItems(page.items);
          setNextCursor(page.nextCursor);
        } catch {
          if (
            mounted.current &&
            !controller.signal.aborted &&
            requestGeneration === generation.current
          )
            setLoadError("Couldn't load memory reviews. Try again.");
        } finally {
          requests.current.delete(controller);
          if (mounted.current && requestGeneration === generation.current) setLoading(false);
        }
      })();
    },
    [abortRequests, agentId],
  );

  useEffect(() => {
    const agentChanged = lastLoadedAgentId.current !== agentId;
    if (pendingCount > 0) {
      lastLoadedAgentId.current = agentId;
      loadFirstPage(agentChanged);
    } else {
      generation.current++;
      abortRequests();
      setItems([]);
      setNextCursor(null);
      setLoading(false);
      setLoadingMore(false);
      setLoadError(null);
      setActionErrors({});
    }
    return () => {
      generation.current++;
      abortRequests();
    };
  }, [abortRequests, agentId, loadFirstPage, pendingCount]);

  async function loadMore() {
    if (!nextCursor || loading || loadingMore) return;
    const cursor = nextCursor;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    requests.current.add(controller);
    setLoadingMore(true);
    setLoadError(null);
    try {
      const api = await getApiClient();
      const page = await api.listMemoryReviews(agentId, cursor, controller.signal);
      if (!mounted.current || controller.signal.aborted || requestGeneration !== generation.current)
        return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      if (mounted.current && !controller.signal.aborted && requestGeneration === generation.current)
        setLoadError("Couldn't load memory reviews. Try again.");
    } finally {
      requests.current.delete(controller);
      if (mounted.current && requestGeneration === generation.current) setLoadingMore(false);
    }
  }

  async function actOnReview(review: MemoryReview, action: ReviewAction) {
    if (actionIds.has(review.updateId)) return;
    setActionIds((current) => new Set(current).add(review.updateId));
    setActionErrors((current) => ({ ...current, [review.updateId]: "" }));
    try {
      const api = await getApiClient();
      if (action === "keep") await api.keepMemoryUpdate(review.updateId);
      else await api.undoMemoryUpdate(review.updateId);
      if (!mounted.current) return;
      setItems((current) => current.filter((item) => item.updateId !== review.updateId));
      onChanged();
    } catch (error) {
      if (!mounted.current) return;
      if (
        error instanceof ApiError &&
        (error.status === 404 ||
          (action === "undo" &&
            error.status === 409 &&
            error.message.toLowerCase().includes("already reviewed")))
      ) {
        setItems((current) => current.filter((item) => item.updateId !== review.updateId));
        onChanged();
      } else if (action === "undo" && error instanceof ApiError && error.status === 409) {
        loadFirstPage(false);
        setActionErrors((current) => ({
          ...current,
          [review.updateId]:
            "Memory changed since this update. Use History to restore an older version.",
        }));
      } else {
        setActionErrors((current) => ({
          ...current,
          [review.updateId]: "Couldn't update this review. Try again.",
        }));
      }
    } finally {
      if (mounted.current) {
        setActionIds((current) => {
          const next = new Set(current);
          next.delete(review.updateId);
          return next;
        });
      }
    }
  }

  return {
    items,
    nextCursor,
    loading,
    loadingMore,
    loadError,
    actionIds,
    actionErrors,
    reload: () => loadFirstPage(true),
    loadMore,
    actOnReview,
  };
}
