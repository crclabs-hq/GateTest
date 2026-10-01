"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One definition of "live" for the admin console: fetch an admin endpoint,
 * re-fetch every `intervalMs` while the tab is visible (paused on
 * document.hidden, caught up immediately when the tab returns), and expose
 * a ticking clock so "Updated Ns ago" moves on its own.
 *
 * A failed refresh never discards the last good data — it keeps it and
 * reports the error alongside, so the operator sees "stale since …" instead
 * of a blank card or, worse, an old reading presented as current.
 */
export const LIVE_REFRESH_MS = 30_000;

export interface LiveState<T> {
  data: T | null;
  /** Message from the most recent failed refresh; null once one succeeds. */
  error: string | null;
  /** Epoch ms of the last successful fetch. */
  lastOkAt: number | null;
  loading: boolean;
  /** Ticks every second while visible — use it to render relative ages. */
  now: number;
  refresh: () => void;
}

export function useLiveRefresh<T>(url: string, intervalMs: number = LIVE_REFRESH_MS): LiveState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const lastAttemptAt = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastAttemptAt.current = Date.now();
    setLoading(true);
    try {
      const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as T;
      setData(body);
      setError(null);
      setLastOkAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      inFlight.current = false;
      setLoading(false);
      setNow(Date.now());
    }
  }, [url]);

  useEffect(() => {
    // First read on the next tick, not synchronously inside the effect.
    const first = setTimeout(() => void refresh(), 0);
    let poll: ReturnType<typeof setInterval> | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (!poll) poll = setInterval(() => void refresh(), intervalMs);
      if (!tick) tick = setInterval(() => setNow(Date.now()), 1000);
    };
    const stop = () => {
      if (poll) clearInterval(poll);
      if (tick) clearInterval(tick);
      poll = null;
      tick = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      setNow(Date.now());
      if (Date.now() - lastAttemptAt.current >= intervalMs) void refresh();
      start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(first);
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, intervalMs]);

  return { data, error, lastOkAt, loading, now, refresh: () => void refresh() };
}

export function secondsAgo(at: number | null, now: number): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** "Updated Ns ago · Refresh" — plus a stale marker when the last refresh failed. */
export function LiveStamp({ state, label }: { state: LiveState<unknown>; label?: string }) {
  const { lastOkAt, error, loading, now, refresh } = state;
  return (
    <div className="gt-admin-live-stamp" aria-live="polite">
      {error && (
        <span className="gt-admin-badge bad" title={error}>
          {lastOkAt ? "stale" : "not checked"} — {error}
        </span>
      )}
      <span className="gt-admin-live-age">
        {label ? `${label} · ` : ""}Updated {secondsAgo(lastOkAt, now)}
      </span>
      <button type="button" className="gt-admin-refresh-btn" onClick={refresh} disabled={loading} aria-label="Refresh now">
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
