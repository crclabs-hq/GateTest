"use client";

import { useState, useEffect, useRef } from "react";
import { reconnectDelayMs } from "./reconnect-backoff";

interface ScanEvent {
  id: string;
  repo_url: string | null;
  tier: string | null;
  status: string;
  score: number | null;
  duration_ms: number | null;
  created_at: string;
}

// What the header says is what is true: the stream is open, a reconnect is
// scheduled (and when), or we have stopped trying (and why).
type FeedStatus =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "reconnecting"; inSeconds: number; reason: string }
  | { kind: "disconnected"; reason: string };

const STREAM_URL = "/api/admin/pipeline-trace/stream";

// EventSource hides the HTTP status of a failed connect. Ask once with fetch
// so a 401 says "HTTP 401" instead of looping forever; the body is not read.
async function probeStream(): Promise<{ status: number; ok: boolean } | null> {
  const ctrl = new AbortController();
  try {
    const res = await fetch(STREAM_URL, { credentials: "same-origin", signal: ctrl.signal });
    return { status: res.status, ok: res.ok };
  } catch { /* error-ok — network failure; caller reports "network unreachable" */
    return null;
  } finally {
    ctrl.abort();
  }
}

const STATUS_COLOR: Record<string, string> = {
  completed: "text-emerald-400",
  failed: "text-red-400",
  running: "text-yellow-300",
  pending: "text-gray-500",
};

function fmtTime(iso: string): string {
  return iso.slice(11, 19);
}

function fmtRepo(url: string | null): string {
  if (!url) return "—";
  return url.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

export function LiveScanFeed() {
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>({ kind: "connecting" });
  // A server-sent `event: error` (e.g. "Database not configured") is shown in
  // the feed, not only logged to the console.
  const [serverError, setServerError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let unmounted = false;

    const scheduleReconnect = (delayMs: number, reason: string) => {
      if (unmounted) return;
      clearTimeout(retryTimer);
      setFeedStatus({ kind: "reconnecting", inSeconds: Math.round(delayMs / 1000), reason });
      retryTimer = setTimeout(connect, delayMs);
    };

    const onConnectionLost = async () => {
      es?.close();
      es = null;
      setConnected(false);
      if (unmounted) return;
      const probe = await probeStream();
      if (unmounted) return;
      if (probe && (probe.status === 401 || probe.status === 403)) {
        // Retrying cannot fix a refused credential — stop and say so.
        setFeedStatus({ kind: "disconnected", reason: `HTTP ${probe.status} — sign in again at /admin` });
        return;
      }
      const reason = probe === null
        ? "network unreachable"
        : probe.ok ? "connection dropped" : `HTTP ${probe.status}`;
      scheduleReconnect(reconnectDelayMs(failures), reason);
      failures++;
    };

    function connect() {
      if (unmounted) return;
      setFeedStatus({ kind: "connecting" });
      const source = new EventSource(STREAM_URL, { withCredentials: true });
      es = source;

      source.onopen = () => {
        failures = 0;
        setConnected(true);
        setFeedStatus({ kind: "live" });
      };

      source.addEventListener("scan", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as ScanEvent;
          setEvents((prev) => [...prev, data].slice(-50));
          setServerError(null);
        } catch { /* error-ok — ignore malformed SSE payloads */ }
      });

      // One listener for both meanings of "error": a server-sent `event: error`
      // carries data (shown in the UI); a connection failure carries none
      // (reconnect with backoff). es.onerror fires for BOTH, which is why the
      // old code marked the feed "disconnected" on every server message.
      source.addEventListener("error", (e: Event) => {
        const payload = (e as MessageEvent).data;
        if (typeof payload === "string" && payload) {
          let message = payload;
          try {
            message = (JSON.parse(payload) as { message?: string }).message || payload;
          } catch { /* error-ok — not JSON; show the raw payload */ }
          setServerError(message);
          return;
        }
        void onConnectionLost();
      });

      // The route ends every stream after 55s on purpose. Reconnect on the
      // first backoff step; this is routine, not a failure.
      source.addEventListener("close", () => {
        source.close();
        es = null;
        setConnected(false);
        failures = 0;
        scheduleReconnect(reconnectDelayMs(0), "server closed the stream (55s limit)");
      });
    }

    connect();

    return () => {
      unmounted = true;
      clearTimeout(retryTimer);
      if (es) es.close();
    };
  }, []);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const statusLabel =
    feedStatus.kind === "connecting" ? "connecting…"
    : feedStatus.kind === "live" ? `live · ${events.length} events`
    : feedStatus.kind === "reconnecting" ? `reconnecting in ${feedStatus.inSeconds}s — ${feedStatus.reason}`
    : `disconnected: ${feedStatus.reason}`;

  return (
    <section className="mt-8 rounded-xl border border-gray-700 bg-gray-900 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-800">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`w-2 h-2 rounded-full shrink-0 ${
              connected ? "bg-emerald-400 animate-pulse" : "bg-gray-600"
            }`}
          />
          <span className="text-xs font-bold text-gray-200 uppercase tracking-wider">
            Live Engine Feed
          </span>
        </div>
        <span
          className={`text-[10px] font-mono ${feedStatus.kind === "disconnected" ? "text-red-400" : "text-gray-500"}`}
        >
          {statusLabel}
        </span>
      </header>

      {serverError && (
        <p role="alert" className="px-4 py-2 text-[11px] font-mono text-red-300 bg-red-950/60 border-b border-red-900">
          Server error: {serverError}
        </p>
      )}

      <div
        role="log"
        aria-live="polite"
        aria-label="Live scan execution events"
        className="h-64 overflow-y-auto font-mono text-[11px] leading-relaxed p-3 space-y-0.5"
      >
        {events.length === 0 ? (
          <span className="text-gray-600 italic">
            {feedStatus.kind === "disconnected"
              ? `Stream disconnected: ${feedStatus.reason}`
              : feedStatus.kind === "reconnecting"
              ? `Not receiving events — ${feedStatus.reason}; retrying in ${feedStatus.inSeconds}s.`
              : "Waiting for scan events…"}
          </span>
        ) : (
          events.map((ev, i) => (
            <div
              key={`${ev.id}-${i}`}
              className="flex items-baseline gap-2 whitespace-nowrap overflow-hidden"
            >
              <span className="text-gray-600 shrink-0 w-[58px]">{fmtTime(ev.created_at)}</span>
              <span
                className={`shrink-0 w-16 font-semibold ${STATUS_COLOR[ev.status] ?? "text-gray-300"}`}
              >
                {ev.status}
              </span>
              <span className="text-purple-400 shrink-0 w-[72px] truncate">{ev.tier ?? "—"}</span>
              <span className="text-gray-300 truncate min-w-0">{fmtRepo(ev.repo_url)}</span>
              {ev.score != null && (
                <span className="text-gray-600 shrink-0">{ev.score}</span>
              )}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}
