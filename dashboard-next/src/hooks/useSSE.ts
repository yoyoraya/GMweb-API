import { useEffect, useRef } from "react";

export interface SseEvent {
  type: string;
  jobId?: string;
  to?: string;
  priority?: string;
  [k: string]: unknown;
}

// Subscribe to /events (same-origin cookie auth). Reconnects with backoff.
export function useSSE(onEvent: (e: SseEvent) => void, enabled: boolean) {
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry = 1000;

    const connect = () => {
      if (closed) return;
      es = new EventSource("/events", { withCredentials: true });
      es.onmessage = (ev) => {
        try {
          cb.current(JSON.parse(ev.data));
        } catch {
          /* ignore keep-alive comments */
        }
      };
      es.onopen = () => {
        retry = 1000;
      };
      es.onerror = () => {
        es?.close();
        if (closed) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    connect();

    return () => {
      closed = true;
      es?.close();
    };
  }, [enabled]);
}
