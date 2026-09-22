"use client";

import { useEffect, useRef, useState } from "react";
import { type ModuleProgress, type RuntimeBlock, MODULE_TICKER } from "./url-scan-flow-types";

export function LiveModuleTicker({ modules, elapsedSec }: { modules: ModuleProgress[]; elapsedSec: number }) {
  return (
    <div className="rounded-3xl border border-border bg-white p-6 sm:p-8" role="status" aria-live="polite">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full bg-accent animate-pulse" aria-hidden />
          <p className="font-semibold text-foreground">Live scan in progress…</p>
        </div>
        <p className="text-sm text-muted font-mono tabular-nums">{elapsedSec.toFixed(1)}s</p>
      </div>
      <ul className="space-y-2.5 max-h-[400px] overflow-y-auto pr-2">
        {modules.map((m) => {
          const done = m.state === "done";
          const skipped = m.state === "skipped";
          const running = m.state === "running";
          // Issue #648 item 1: a module whose own `_notChecked` check fired
          // must never render as a clean "done" tick — it gets its own
          // state, distinct from both "done" and "skipped" (skipped means
          // the runner didn't run it at all; not-checked means it ran and
          // reported it had nothing it could look at).
          const notChecked = m.state === "not-checked";
          const hasIssues = (m.errors || 0) + (m.warnings || 0) > 0;
          return (
            <li key={m.name} className="flex items-center gap-3 text-sm">
              <span
                className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                  done && hasIssues
                    ? "bg-amber-500 text-white"
                    : done
                    ? "bg-emerald-500 text-white"
                    : notChecked
                    ? "bg-slate-200 text-slate-500"
                    : skipped
                    ? "bg-slate-200 text-slate-500"
                    : running
                    ? "bg-accent/15 text-accent"
                    : "bg-slate-100 text-slate-400"
                }`}
                aria-hidden
              >
                {done ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                ) : notChecked ? (
                  <span className="text-[10px] font-bold">?</span>
                ) : skipped ? (
                  <span className="text-[10px] font-bold">—</span>
                ) : running ? (
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                ) : null}
              </span>
              <span className={`flex-1 ${done ? "text-foreground" : running ? "text-foreground font-medium" : "text-muted"}`}>
                {m.name}
              </span>
              {done && hasIssues && (
                <span className="text-xs font-mono text-amber-700">
                  {m.errors ? `${m.errors}E` : ""}
                  {m.errors && m.warnings ? " · " : ""}
                  {m.warnings ? `${m.warnings}W` : ""}
                </span>
              )}
              {done && !hasIssues && <span className="text-xs font-mono text-emerald-700">clean</span>}
              {skipped && <span className="text-xs text-muted italic">skipped</span>}
              {notChecked && (
                <span className="text-xs text-muted italic" title={m.reason}>
                  not checked
                </span>
              )}
              {done && typeof m.duration === "number" && m.duration > 100 && (
                <span className="text-xs font-mono text-muted tabular-nums">{(m.duration / 1000).toFixed(1)}s</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ProgressTicker({ suite, elapsedSec }: { suite: "web" | "wp"; elapsedSec: number }) {
  const items = MODULE_TICKER[suite];
  const activeIndex = Math.min(items.length - 1, Math.floor(elapsedSec / 1.6));
  return (
    <div className="rounded-3xl border border-border bg-white p-6 sm:p-8" role="status" aria-live="polite">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full bg-accent animate-pulse" aria-hidden />
          <p className="font-semibold text-foreground">Scanning your site...</p>
        </div>
        <p className="text-sm text-muted font-mono tabular-nums">{elapsedSec.toFixed(1)}s</p>
      </div>
      <ul className="space-y-2.5">
        {items.map((label, i) => {
          const done = i < activeIndex;
          const active = i === activeIndex;
          return (
            <li
              key={label}
              className={`flex items-center gap-3 text-sm transition-opacity ${
                i > activeIndex + 2 ? "opacity-30" : ""
              }`}
            >
              <span
                className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                  done ? "bg-emerald-500 text-white" : active ? "bg-accent/15 text-accent" : "bg-slate-100 text-slate-400"
                }`}
                aria-hidden
              >
                {done ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                ) : active ? (
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                ) : null}
              </span>
              <span className={done ? "text-foreground" : active ? "text-foreground font-medium" : "text-muted"}>
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Plain-English rendering of the reason codes web-runtime-gate.js emits.
 * The code is the only thing the server sends — no variable names, hostnames
 * or upstream error bodies reach the browser. An unknown code still gets a
 * truthful sentence rather than nothing.
 */
export function describeRuntimeReason(reason?: string | null): string {
  if (reason === "not-configured") return "the live-browser worker is not switched on for this deployment yet";
  if (reason === "callback-timeout") return "the live-browser worker did not report back within the time limit";
  if (reason === "dispatch-failed:timeout") return "the live-browser worker did not answer in time";
  if (reason === "dispatch-failed:network") return "the live-browser worker could not be reached";
  if (reason && reason.startsWith("dispatch-failed:")) {
    return `the live-browser worker refused the job (HTTP ${reason.slice("dispatch-failed:".length)})`;
  }
  return "it could not be started this time";
}

/**
 * Shown when the runtime (headless-browser) pass did NOT run — not queued,
 * refused, or queued but never reported back.
 *
 * Why this exists: /web sells "we open your site in a real browser." A report
 * that silently omits a whole advertised layer reads as a clean bill of
 * health (Doctrine #1). Static-probe findings are still real; the customer
 * needs one plain sentence saying what did and did not run (Doctrine #6).
 */
export function RuntimeUnavailable({ reason }: { reason?: string | null }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 ring-1 ring-amber-100" role="status">
      <div className="flex items-start gap-3">
        <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-amber-500/15 flex items-center justify-center">
          <span className="w-2 h-2 rounded-full bg-amber-500" aria-hidden />
        </span>
        <div className="flex-1">
          <p className="font-semibold text-amber-900 leading-tight">
            Runtime checks (real-browser errors, headers under load) were not run: {describeRuntimeReason(reason)}. Static checks ran.
          </p>
          <p className="text-sm text-amber-900/80 mt-1">
            Everything below comes from the static and network checks, and it&apos;s all real — but
            live JavaScript errors, hydration mismatches and CSP violations are <em>not</em>{" "}
            reflected in the score. Re-run the scan later, or email{" "}
            <a href="mailto:support@gatetest.io" className="underline font-medium">
              support@gatetest.io
            </a>{" "}
            if it keeps happening.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Fallback when the server did not say how long to wait: 60s deadline + 30s grace (web-runtime-gate.js). */
const DEFAULT_RUNTIME_TIMEOUT_SEC = 90;

export function RuntimePending({
  pollUrl,
  timeoutSec,
  onComplete,
  onTimeout,
}: {
  pollUrl: string;
  timeoutSec?: number;
  onComplete: (rt: RuntimeBlock["payload"]) => void;
  onTimeout: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const onCompleteRef = useRef(onComplete);
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onTimeoutRef.current = onTimeout;
  }, [onComplete, onTimeout]);

  useEffect(() => {
    let cancelled = false;
    const start = Date.now();
    const limitMs = (timeoutSec && timeoutSec > 0 ? timeoutSec : DEFAULT_RUNTIME_TIMEOUT_SEC) * 1000;
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    const stop = () => {
      clearInterval(poll);
      clearInterval(tick);
    };
    const poll = setInterval(async () => {
      // A queued job that never calls back must not spin forever — report
      // callback-timeout so the customer knows the runtime pass did not run.
      if (Date.now() - start > limitMs) {
        stop();
        if (!cancelled) onTimeoutRef.current();
        return;
      }
      try {
        const r = await fetch(pollUrl, { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        if (data?.runtime?.status === "completed" || data?.runtime?.status === "failed") {
          onCompleteRef.current(data.runtime.payload);
          stop();
        }
      } catch {
        /* error-ok — keep polling */
      }
    }, 3000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [pollUrl, timeoutSec]);

  return (
    <div className="rounded-2xl border border-border bg-blue-50 p-5 ring-1 ring-blue-100">
      <div className="flex items-start gap-3">
        <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-blue-500/15 flex items-center justify-center">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" aria-hidden />
        </span>
        <div className="flex-1">
          <p className="font-semibold text-blue-900 leading-tight">Live browser check running…</p>
          <p className="text-sm text-blue-800/80 mt-1">
            We&apos;re loading your site in a real Chromium and watching for JavaScript errors,
            hydration mismatches, CSP violations and broken network requests. Usually 10-30 seconds. <span className="font-mono tabular-nums">{elapsed}s elapsed.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
