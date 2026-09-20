import { useCallback, useEffect, useRef, useState } from "react";
import { getApiClient } from "../../lib/api/client.js";
import {
  applyEvent,
  emptyThread,
  prependMessages,
  type ThreadEvent,
  type ThreadState,
} from "./thread-state.js";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "closed";

const EVENT_TYPES = [
  "conversation.snapshot",
  "participant.updated",
  "message.created",
  "message.delta",
  "message.text.completed",
  "message.completed",
  "run.updated",
  "stream.reset",
] as const;

export function useConversationStream(conversationId: string | null): {
  thread: ThreadState;
  stream: StreamStatus;
  reconnect: () => void;
  apply: (event: ThreadEvent) => void;
  loadEarlier: () => Promise<void>;
  loadingEarlier: boolean;
  earlierError: Error | null;
} {
  const [thread, setThread] = useState<ThreadState>(emptyThread);
  const [stream, setStream] = useState<StreamStatus>(conversationId ? "connecting" : "closed");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<Error | null>(null);
  const [generation, setGeneration] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = thread.nextMessageCursor;
  const loadingRef = useRef(false);

  useEffect(() => {
    void generation;
    if (!conversationId) {
      setThread(emptyThread);
      setStream("closed");
      return;
    }
    setThread(emptyThread);
    setEarlierError(null);
    setStream("connecting");
    let source: EventSource | null = null;
    let cancelled = false;
    const live = () => !cancelled && source !== null && sourceRef.current === source;
    const onEvent = (event: MessageEvent) => {
      if (!live() || typeof event.data !== "string") return;
      try {
        const data: unknown = JSON.parse(event.data);
        const payload =
          typeof data === "object" && data !== null
            ? (data as { payload?: unknown }).payload
            : undefined;
        setThread((state) => applyEvent(state, { type: event.type, payload }));
      } catch {
        return;
      }
    };
    void getApiClient()
      .then((client) => {
        if (cancelled) return;
        source = new EventSource(
          `${client.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/events`,
        );
        sourceRef.current = source;
        for (const type of EVENT_TYPES) {
          source.addEventListener(type, onEvent as EventListener);
        }
        source.onopen = () => {
          if (live()) setStream("live");
        };
        source.onerror = () => {
          if (!live() || source === null) return;
          setStream(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
        };
      })
      .catch(() => {
        if (!cancelled) setStream("closed");
      });
    return () => {
      cancelled = true;
      if (source) {
        if (sourceRef.current === source) sourceRef.current = null;
        source.close();
      }
    };
  }, [conversationId, generation]);

  const apply = useCallback((event: ThreadEvent) => {
    setThread((state) => applyEvent(state, event));
  }, []);

  const reconnect = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setGeneration((value) => value + 1);
  }, []);

  const loadEarlier = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!conversationId || cursor === null || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingEarlier(true);
    setEarlierError(null);
    try {
      const client = await getApiClient();
      const page = await client.listMessages(conversationId, cursor);
      setThread((state) => prependMessages(state, page));
    } catch (error) {
      setEarlierError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      loadingRef.current = false;
      setLoadingEarlier(false);
    }
  }, [conversationId]);

  return { thread, stream, reconnect, apply, loadEarlier, loadingEarlier, earlierError };
}
