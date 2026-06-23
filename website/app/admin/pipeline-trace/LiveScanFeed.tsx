"use client";

import { useState, useEffect, useRef } from "react";

interface ScanEvent {
  id: string;
  repo_url: string | null;
  tier: string | null;
  status: string;
  score: number | null;
  duration_ms: number | null;
  created_at: string;
}

type FeedStatus = "connecting" | "live" | "error" | "closed";

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
  const [feedStatus, setFeedStatus] = useState<FeedStatus>("connecting");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource("/api/admin/pipeline-trace/stream", {
      withCredentials: true,
    });

    es.onopen = () => {
      setConnected(true);
      setFeedStatus("live");
    };

    es.addEventListener("scan", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as ScanEvent;
        setEvents((prev) => [...prev, data].slice(-50));
      } catch { /* ignore malformed SSE payloads */ }
    });

    es.addEventListener("error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { message?: string };
        // Named "error" event is a server-sent informational error, not a connection drop
        console.error("[LiveScanFeed] server error:", data.message);
      } catch { /* ignore */ }
    });

    es.addEventListener("close", () => {
      es.close();
      setConnected(false);
      setFeedStatus("closed");
    });

    // Unnamed onerror fires on connection failure / 401 / network drop
    es.onerror = () => {
      setConnected(false);
      setFeedStatus("error");
    };

    return () => {
      es.close();
    };
  }, []);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const statusLabel: Record<FeedStatus, string> = {
    connecting: "connecting…",
    live: `${events.length} events`,
    error: "disconnected",
    closed: "stream closed — reconnecting",
  };

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
        <span className="text-[10px] text-gray-500 font-mono">{statusLabel[feedStatus]}</span>
      </header>

      <div
        role="log"
        aria-live="polite"
        aria-label="Live scan execution events"
        className="h-64 overflow-y-auto font-mono text-[11px] leading-relaxed p-3 space-y-0.5"
      >
        {events.length === 0 ? (
          <span className="text-gray-600 italic">
            {feedStatus === "error"
              ? "Stream disconnected — re-authenticate at /admin if this persists."
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
