"use client";

/**
 * <UrlScanFlow> — paste-URL → scan → results, shared by /web and /wp.
 *
 * Sub-components live in sibling files to keep this orchestrator under the
 * file-length budget:
 *   - url-scan-flow-types.ts     — shared types + constants
 *   - url-scan-flow-cards.tsx    — HealthScore, Stat, Finding, Recommendation, Paywall
 *   - url-scan-flow-progress.tsx — LiveModule, Progress, RuntimePending tickers
 *   - url-scan-flow-export.tsx   — Copy-for-agent prompt formatter + button
 *   - url-scan-flow-sse.ts       — text/event-stream parser
 *
 * Design rules:
 *   - Bible: "the scan experience must be CINEMATIC." Module-by-module
 *     ticker, animated score reveal, staggered finding cards.
 *   - Findings are CLUSTERS (1 missing CSP header = 1 row).
 *   - Runtime status: hide entirely when "unavailable".
 *   - Paywall CTA appears below findings when preview === true.
 *
 * Accessibility: all interactive elements keyboard-focusable, aria-live
 * region for state changes, findings expand via <details>/<summary>.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  Finding,
  ModuleProgress,
  Recommendation,
  RuntimeBlock,
  ScanResult,
  UrlScanFlowProps,
} from "./url-scan-flow-types";
import { HealthScoreCard, StatCard, FindingRow, RecommendationCard, PaywallCard, ModuleChecksCard } from "./url-scan-flow-cards";
import { explainScoreChange } from "@/app/lib/health-score";
import { LiveModuleTicker, ProgressTicker, RuntimePending, RuntimeUnavailable } from "./url-scan-flow-progress";
import { CopyForAgentButton } from "./url-scan-flow-export";
import { ScanFeedback } from "./ScanFeedback";
import { consumeSseStream } from "./url-scan-flow-sse";

// Issue #648 item 3 — permalink + restore for /web (and /wp, which shares
// this component) results. Reuses the EXACT client-side encoding #647
// already shipped for the free-scan playground (`?s=` — see
// website/app/playground/page.tsx's encodeShareData/decodeShareData/
// pushPermalink) rather than inventing a second permalink mechanism: whole
// result, base64url-encoded with an embedded `sharedAt` timestamp, pushed
// to the address bar with replaceState, expiring after 48h. No server-side
// store — same tradeoff #647 already accepted, and this route has no
// `scanId`-keyed persistence to restore from instead.
const SHARE_EXPIRY_MS = 48 * 60 * 60 * 1000;

function encodeShareData(result: ScanResult): string {
  const payload = { ...result, sharedAt: Date.now() };
  return btoa(encodeURIComponent(JSON.stringify(payload))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShareData(encoded: string): ScanResult | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(atob(base64));
    const data = JSON.parse(json) as ScanResult;
    if (!data.sharedAt || Date.now() - data.sharedAt > SHARE_EXPIRY_MS) return null;
    return data;
  } catch {
    return null; // error-ok — a malformed or tampered `?s=` value is not a scan result
  }
}

/** Pushes the current result into the address bar as `?s=...` so reload
 *  and copy-link both restore it. Returns the URL, or null when the
 *  browser refuses the history write (a long encoded result) — a refusal
 *  must not take the on-screen result down with it. */
function pushPermalink(result: ScanResult): string | null {
  try {
    const url = `${window.location.origin}${window.location.pathname}?s=${encodeShareData(result)}`;
    window.history.replaceState({}, "", url);
    return url;
  } catch {
    return null; // error-ok — see above
  }
}

// Issue #658 item 2 — "why did the score move" needs SOMETHING to compare
// against. There's no server-side scanId-keyed history for /web scans (same
// gap item 3/#647 already accepted for the permalink), so the last scan's
// coverage numbers for THIS target URL are remembered client-side, same
// pattern/tradeoff as ScanFeedback.tsx's per-scan "already answered" memory.
// Per-viewer convenience only — never blocks rendering when storage is
// unavailable (private browsing, quota, SSR).
const COVERAGE_STORAGE_PREFIX = "gt_web_coverage:";

function loadPreviousCoverage(targetUrl: string): { totalModules?: number; checkedModules?: number; notCheckedModules?: string[]; score?: number; build?: string } | null {
  try {
    const raw = window.localStorage.getItem(COVERAGE_STORAGE_PREFIX + targetUrl);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // error-ok — storage blocked/unavailable; nothing to compare against
  }
}

function saveCoverage(targetUrl: string, result: ScanResult): void {
  try {
    window.localStorage.setItem(
      COVERAGE_STORAGE_PREFIX + targetUrl,
      JSON.stringify({
        totalModules: result.totalModules,
        checkedModules: result.checkedModules,
        notCheckedModules: result.notCheckedModules,
        // Issue #661 — score + engine build ride along so the NEXT scan of
        // this URL can tell a build-caused score move apart from a real
        // change on the customer's site, even when coverage is unchanged.
        score: result.healthScore?.score,
        build: result.build,
      })
    );
  } catch {
    /* error-ok — storage blocked; the explanation just won't be available next time */
  }
}

export function UrlScanFlow({ suite, endpoint, streamEndpoint, recommendEndpoint, placeholderUrl = "https://yoursite.com", brandLabel, initialUrl = "" }: UrlScanFlowProps) {
  type Phase = "idle" | "scanning" | "results" | "error";
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState(initialUrl);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [liveModules, setLiveModules] = useState<ModuleProgress[]>([]);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  // Issue #658 item 2 — "N checks added" / "M modules excluded" vs the last
  // scan of this same URL from this browser.
  const [scoreChangeNote, setScoreChangeNote] = useState<string | null>(null);
  const tickerRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recAbortRef = useRef<AbortController | null>(null);
  // Paid full-report unlock: after Stripe Checkout, the success_url returns
  // here as /web?session_id=cs_...&url=<target>. The sessionId rides on every
  // scan request; the server verifies payment_status=paid via
  // full-report-auth before lifting the paywall — nothing client-asserted.
  const sessionIdRef = useRef<string>("");
  const autoRanRef = useRef(false);

  // Debounced pre-scan recommendation fetch. Fires when URL looks valid
  // and hasn't changed for 600ms. Aborts any in-flight previous fetch.
  // Failures are silent — the card just doesn't appear.
  useEffect(() => {
    if (!recommendEndpoint || phase !== "idle") return;
    const trimmed = url.trim();
    if (!trimmed) { setRecommendation(null); return; }
    if (!/^https?:\/\/[^/\s.]+\.[^/\s]+/i.test(trimmed) && !/^[^/\s.]+\.[^/\s.]+/.test(trimmed)) {
      setRecommendation(null);
      return;
    }
    const timer = setTimeout(async () => {
      if (recAbortRef.current) recAbortRef.current.abort();
      const abort = new AbortController();
      recAbortRef.current = abort;
      try {
        const res = await fetch(recommendEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
          signal: abort.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.recommendation) {
          setRecommendation(data as Recommendation);
        }
      } catch {
        /* error-ok — abort or network error — silent */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [url, recommendEndpoint, phase]);

  // Restore from a `?s=` permalink (item 3), or Stripe-return auto-run:
  // /web?session_id=cs_...&url=<target> lands here after a successful
  // full-report checkout — pick up both params, run the scan once with the
  // paid session attached. A permalink takes priority: it's a completed
  // result to render immediately, not a scan to (re-)run.
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    const sp = new URLSearchParams(window.location.search);
    const shared = sp.get("s");
    if (shared) {
      const restored = decodeShareData(shared);
      if (restored) {
        setUrl(restored.targetUrl || "");
        setResult(restored);
        setPhase("results");
        return;
      }
    }
    const sid = (sp.get("session_id") || "").trim();
    const paidUrl = (sp.get("url") || "").trim();
    if (sid) sessionIdRef.current = sid;
    if (sid && paidUrl) {
      setUrl(paidUrl);
      void startScan(paidUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase === "scanning") {
      const start = Date.now();
      tickerRef.current = setInterval(() => {
        setElapsedSec((Date.now() - start) / 1000);
      }, 100);
    } else {
      if (tickerRef.current) clearInterval(tickerRef.current);
      tickerRef.current = null;
      setElapsedSec(0);
    }
    return () => {
      if (tickerRef.current) clearInterval(tickerRef.current);
    };
  }, [phase]);

  async function runStreaming(targetUrl: string, abort: AbortController) {
    if (!streamEndpoint) throw new Error("no-stream-endpoint");
    const res = await fetch(streamEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ url: targetUrl, ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}) }),
      signal: abort.signal,
    });
    if (!res.ok) {
      let errMsg = `Scan failed (HTTP ${res.status})`;
      try {
        const j = await res.json();
        errMsg = j?.error || errMsg;
      } catch { /* error-ok — error body unreadable — the status alone is reported */ }
      throw new Error(errMsg);
    }

    let completed: ScanResult | null = null;
    await consumeSseStream(res, (event, data) => {
      if (event === "module:start") {
        const d = data as { module: string };
        setLiveModules((prev) => {
          const i = prev.findIndex((m) => m.name === d.module);
          if (i >= 0) {
            const copy = [...prev];
            copy[i] = { ...copy[i], state: "running" };
            return copy;
          }
          return [...prev, { name: d.module, state: "running" }];
        });
      } else if (event === "module:end") {
        // Issue #648 items 1-2: the server now says explicitly whether a
        // module was actually checked. A not-checked module gets its own
        // ticker state (never "done") and carries its own reason — never
        // the runtime-dispatch reason from a different part of the report.
        const d = data as { module: string; status?: "checked" | "not-checked"; errors?: number; warnings?: number; duration?: number; reason?: string };
        setLiveModules((prev) => {
          const i = prev.findIndex((m) => m.name === d.module);
          const updated: ModuleProgress =
            d.status === "not-checked"
              ? { name: d.module, state: "not-checked", reason: d.reason, duration: d.duration }
              : { name: d.module, state: "done", errors: d.errors, warnings: d.warnings, duration: d.duration };
          if (i >= 0) {
            const copy = [...prev];
            copy[i] = updated;
            return copy;
          }
          return [...prev, updated];
        });
      } else if (event === "module:skip") {
        const d = data as { module: string };
        setLiveModules((prev) => {
          const i = prev.findIndex((m) => m.name === d.module);
          const updated: ModuleProgress = { name: d.module, state: "skipped" };
          if (i >= 0) {
            const copy = [...prev];
            copy[i] = updated;
            return copy;
          }
          return [...prev, updated];
        });
      } else if (event === "complete") {
        completed = data as ScanResult;
      } else if (event === "error") {
        const d = data as { error?: string };
        throw new Error(d?.error || "Scan errored mid-stream");
      }
    }, abort.signal);

    if (!completed) throw new Error("Scan stream closed without a complete event");
    return completed;
  }

  async function runNonStreaming(targetUrl: string): Promise<ScanResult> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: targetUrl, ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Scan failed. Please try a different URL.");
    return data as ScanResult;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!url.trim()) return;
    await startScan(url.trim());
  }

  async function startScan(targetUrl: string) {
    setError(null);
    setLiveModules([]);
    setPhase("scanning");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const data = streamEndpoint
        ? await runStreaming(targetUrl, abort)
        : await runNonStreaming(targetUrl);
      // Issue #658 item 2 — compare against the LAST scan of this exact
      // URL from this browser before overwriting the remembered coverage.
      const previousCoverage = loadPreviousCoverage(targetUrl);
      setScoreChangeNote(
        explainScoreChange(previousCoverage, {
          totalModules: data.totalModules,
          checkedModules: data.checkedModules,
          notCheckedModules: data.notCheckedModules,
          score: data.healthScore?.score,
          build: data.build,
        })
      );
      saveCoverage(targetUrl, data);
      setResult(data);
      setPhase("results");
      // Item 3 — a completed scan gets a URL immediately, not only on an
      // explicit "share" click, so reload/back never drops the report.
      pushPermalink(data);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        setPhase("idle");
        return;
      }
      setError(err instanceof Error ? err.message : "Network error — please try again.");
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }

  function reset() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setResult(null);
    setError(null);
    setLiveModules([]);
    setScoreChangeNote(null);
    setPhase("idle");
    setUrl("");
    // Drop a restored/pushed `?s=` permalink so "scan a different URL"
    // doesn't leave the old report's link sitting in the address bar.
    try {
      window.history.replaceState({}, "", window.location.pathname);
    } catch { /* error-ok — an unwritable history entry is not worth failing the reset over */ }
  }

  const [linkCopied, setLinkCopied] = useState(false);
  async function copyPermalink() {
    if (!result) return;
    const url = pushPermalink(result) || window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2400);
    } catch {
      /* error-ok — clipboard denied; the address bar already carries the link */
    }
  }

  function applyRuntimePayload(payload: RuntimeBlock["payload"]) {
    if (!result || !payload || !Array.isArray(payload.findings)) return;
    const newFindings: Finding[] = payload.findings
      .filter((f) => f.passed === false && f.severity !== "info")
      .map((f) => ({
        severity: f.severity,
        title: f.message.slice(0, 100),
        body: f.message,
        module: "runtimeErrors",
        ruleKey: f.name,
        instanceCount: 1,
        highSignal: f.name.includes("csp-violation") || f.name.includes("page-error"),
      }));
    setResult({
      ...result,
      findings: [...result.findings, ...newFindings],
      runtime: { ...result.runtime!, status: "completed", checked: true, payload },
    });
  }

  // Queued but no signed callback within the deadline + grace: the runtime
  // pass did not run. Say so (callback-timeout) instead of spinning forever.
  function markRuntimeTimedOut() {
    setResult((prev) =>
      prev && prev.runtime?.status === "queued"
        ? { ...prev, runtime: { ...prev.runtime, status: "unavailable", reason: "callback-timeout", checked: false, pollUrl: null } }
        : prev
    );
  }

  const showRuntime = result?.runtime?.status === "queued" || result?.runtime?.status === "completed";
  // What the feedback row records as the tier: the free preview or the paid full report.
  const feedbackTier = result?.preview ? "preview" : "full-report";

  return (
    <div className="w-full">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col sm:flex-row items-stretch justify-center gap-3 max-w-xl mx-auto"
      >
        <label className="sr-only" htmlFor="url-scan-input">Website URL to scan</label>
        <input
          id="url-scan-input"
          type="url"
          name="url"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholderUrl}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={phase === "scanning"}
          className="flex-1 px-5 py-4 rounded-xl border border-border bg-background text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent text-lg disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={phase === "scanning" || !url.trim()}
          className="px-8 py-4 rounded-xl bg-accent text-white font-semibold text-lg hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {phase === "scanning" ? "Scanning…" : "Scan my site"}
        </button>
      </form>

      {phase === "idle" && (
        <>
          <p className="text-center text-sm text-muted mt-6">
            Free preview — top 3 issues plus your Health Score. No signup, no install.
          </p>
          {recommendation && <RecommendationCard rec={recommendation} />}
        </>
      )}

      {phase === "scanning" && (
        <div className="mt-10 max-w-2xl mx-auto">
          {streamEndpoint && liveModules.length > 0 ? (
            <LiveModuleTicker modules={liveModules} elapsedSec={elapsedSec} />
          ) : (
            <ProgressTicker suite={suite} elapsedSec={elapsedSec} />
          )}
        </div>
      )}

      {phase === "error" && (
        <div className="mt-10 max-w-2xl mx-auto">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 ring-1 ring-rose-100" role="alert">
            <h2 className="font-semibold text-rose-900 mb-1">We couldn&apos;t scan that URL</h2>
            <p className="text-sm text-rose-900/80">{error}</p>
            <button
              onClick={reset}
              className="mt-4 px-4 py-2 rounded-lg bg-rose-600 text-white font-medium hover:bg-rose-700 transition-colors"
            >
              Try a different URL
            </button>
          </div>
        </div>
      )}

      {phase === "results" && result && (
        <div className="mt-12 max-w-4xl mx-auto space-y-8">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted">
              Scanned <span className="font-mono text-foreground">{result.targetUrl}</span> in{" "}
              <span className="font-mono tabular-nums text-foreground">{(result.duration / 1000).toFixed(1)}s</span>
              {brandLabel && <span className="ml-2 text-muted">• {brandLabel}</span>}
            </p>
            <div className="flex items-center gap-4">
              <button
                onClick={copyPermalink}
                className="text-accent hover:text-accent-hover font-medium transition-colors focus:outline-none focus-visible:underline"
              >
                {linkCopied ? "Link copied!" : "Copy link to this result"}
              </button>
              <button
                onClick={reset}
                className="text-accent hover:text-accent-hover font-medium transition-colors focus:outline-none focus-visible:underline"
              >
                Scan a different URL →
              </button>
            </div>
          </div>

          <HealthScoreCard
            {...result.healthScore}
            notCheckedModules={result.notCheckedModules}
            notCheckedReasons={result.notCheckedReasons}
            totalModules={result.totalModules}
            scoreChangeNote={scoreChangeNote}
          />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Errors" value={result.errorCount} accent="rose" />
            <StatCard label="Warnings" value={result.warningCount} accent="amber" />
            <StatCard label="Root causes" value={result.totalClusters} accent="teal" />
            <StatCard label="Raw findings" value={result.totalFindings} accent="slate" />
          </div>

          {showRuntime && result.runtime?.status === "queued" && result.runtime.pollUrl && (
            <RuntimePending
              pollUrl={result.runtime.pollUrl}
              timeoutSec={result.runtime.timeoutSec}
              onComplete={applyRuntimePayload}
              onTimeout={markRuntimeTimedOut}
            />
          )}

          {/* The advertised browser pass did not run (not configured, refused,
              or never called back). Say so — a report that silently omits a
              whole layer reads as a clean bill of health. */}
          {result.runtime?.status === "unavailable" && (
            <RuntimeUnavailable reason={result.runtime.reason} />
          )}

          {/* Issue #648 item 4 — free regardless of `result.preview`: check
              NAMES are not the paid part, only the fix guidance below is. */}
          <ModuleChecksCard moduleChecks={result.moduleChecks} />

          {result.findings.length > 0 ? (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-xl font-bold">
                    {result.preview ? "Top issues — free preview" : "Every issue found"}
                  </h2>
                  <p className="text-sm text-muted mt-1">
                    Click any row for plain-language detail and fix guidance.
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                {result.findings.map((f, i) => (
                  <FindingRow key={`${f.ruleKey}-${i}`} finding={f} index={i} scanId={result.scanId} tier={feedbackTier} />
                ))}
              </div>

              <div className="mt-6">
                <CopyForAgentButton result={result} />
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
              <p className="text-emerald-900 font-semibold">No issues in the modules we ran 🎉</p>
              <p className="text-sm text-emerald-900/80 mt-1">
                Consider running a deeper suite to check more dimensions.
              </p>
            </div>
          )}

          {/* One question, once per scan — the answer is what reaches us
              before a review site does. */}
          <ScanFeedback surface={suite} scanId={result.scanId} tier={feedbackTier} contextKey={result.targetUrl} />

          {result.paywall && result.paywall.remainingCount > 0 && (
            <PaywallCard paywall={result.paywall} targetUrl={result.targetUrl} />
          )}

          <div className="text-center pt-4">
            <p className="text-xs text-muted">
              Powered by the{" "}
              <Link href="/" className="text-accent hover:underline font-medium">
                GateTest
              </Link>{" "}
              engine — 90+ live checks; the real-browser runtime pass is rolling out and is reported separately when it runs.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
