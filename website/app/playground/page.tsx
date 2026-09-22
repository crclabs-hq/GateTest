"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { consumeSseStream } from "@/app/components/url-scan-flow-sse";
import { totalModuleCount } from "@/app/components/howitworks/modules-data";
import { SITE_URL, badgeUrl } from "@/app/lib/site-url";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import { TOTAL_MODULES } from "@/app/lib/module-count";

// One definition of the honesty formatting shared with the two API routes
// (Doctrine #4) — the wall-clock headline (N3/F3) so a 0.1s engine number is
// never displayed as if it were the whole request.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scanGrade = require("@/app/lib/scan-grade") as {
  formatDurationHeadline: (timing: { wallMs?: number | null; fetchMs?: number | null; engineMs?: number | null } | null | undefined) => {
    headline: string;
    headlineLabel: string;
    split: string | null;
  };
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ModuleResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  severity?: Severity;
}

/** "error" is the gate's word for a blocking finding. "critical" is the name
 *  the API used before 2026-09-22 and still arrives on share links inside
 *  their 48h window, so it is kept as an alias rather than rendered blank. */
type Severity = "error" | "critical" | "warning" | "info";

interface LockedModule {
  name: string;
  category: string;
}

interface Finding {
  module: string;
  message: string;
  severity: string;
}

interface ScanResult {
  status: "complete" | "failed";
  repo_url: string;
  tier: string;
  modules: ModuleResult[];
  totalModules?: number;
  freeModules?: number;
  totalIssues: number;
  duration: number;
  healthScore: number | null;
  grade: string;
  gradeColor: string;
  /** F1 — the grade is driven by `blockingCount`; warnings are counted, shown, never fatal. */
  blockingCount?: number;
  warningCount?: number;
  infoCount?: number;
  countLabel?: string;
  gradeSummary?: string;
  /** F2 — what was scanned, when, under which report id. */
  scanId?: string;
  scannedAt?: string;
  commitSha?: string | null;
  branch?: string | null;
  resultHeader?: string;
  /** F3 — what the free scan actually read, and how long each half took. */
  scopeLabel?: string;
  coverage?: {
    filesAnalysed?: number | null;
    filesInRepo?: number | null;
    source?: string | null;
    truncated?: boolean;
    engineMs?: number | null;
    fetchMs?: number | null;
    wallMs?: number | null;
    /** N2 — one definition of the coverage fraction (Doctrine #4). */
    scanned?: number;
    total?: number;
    partial?: boolean;
  };
  /** F4 — resolved server-side; never trusted from the client. */
  viewer?: { signedIn: boolean; canSignIn?: boolean; canFix: boolean };
  topFindings: Finding[];
  upgradeNote: string;
  error?: string;
  sharedAt?: number;
}

interface TerminalLine {
  id: number;
  type: "info" | "run" | "pass" | "fail" | "done" | "error";
  text: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EXAMPLE_REPOS = [
  { label: "facebook/react", url: "https://github.com/facebook/react" },
  { label: "vercel/next.js", url: "https://github.com/vercel/next.js" },
  { label: "expressjs/express", url: "https://github.com/expressjs/express" },
  { label: "crclabs-hq/gatetest", url: "https://github.com/crclabs-hq/GateTest" },
];

const QUICK_MODULES = ["syntax", "lint", "secrets", "codeQuality"];

const MODULE_LABELS: Record<string, string> = {
  syntax:      "Syntax validation",
  lint:        "Lint & style rules",
  secrets:     "Secret detection",
  codeQuality: "Code quality analysis",
};

/** Grey when there is no grade to show — never a colour that reads as a pass. */
const NO_GRADE_COLOR = "#6b7280";

const SEVERITY_STYLE: Record<Severity, { label: string; text: string; bg: string; border: string; dot: string }> = {
  error:    { label: "BLOCKING", text: "text-red-700",    bg: "bg-red-500/[0.06]",    border: "border-red-500/25",    dot: "bg-red-500" },
  critical: { label: "BLOCKING", text: "text-red-700",    bg: "bg-red-500/[0.06]",    border: "border-red-500/25",    dot: "bg-red-500" },
  warning:  { label: "WARNING",  text: "text-amber-700",  bg: "bg-amber-500/[0.06]",  border: "border-amber-500/25",  dot: "bg-amber-500" },
  info:     { label: "INFO",     text: "text-sky-700",    bg: "bg-sky-500/[0.06]",    border: "border-sky-500/25",    dot: "bg-sky-500" },
};

function severityOf(raw: string | undefined): Severity {
  return raw === "error" || raw === "critical" || raw === "warning" || raw === "info" ? raw : "warning";
}

// Share links encode the whole result client-side (no backend store — see
// SHARE_EXPIRY_MS note below) so "shareable URL" works without a new
// dependency (Vercel KV/Redis aren't in the approved stack). The embedded
// `sharedAt` timestamp is what "expires after 48 hours" actually checks —
// the underlying URL data doesn't vanish, but the page treats it as
// expired and refuses to render it past the window, same practical effect
// for the intended use case (a link shared once, checked within a couple
// days) without needing new infra.
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
    return null;
  }
}

/**
 * F5 — a completed free scan gets a URL. Until 2026-09-22 the result replaced
 * the hero in place at `/playground`, so back or reload threw it away and the
 * only way to keep it was to press "Share results" first. The permalink is the
 * SAME 48h encoding the share button already produced — one mechanism, not a
 * second store — pushed to the address bar with replaceState as the result
 * renders. Reload re-reads `?s=` and the result comes back.
 *
 * Returns the URL, or null when the browser refuses the history write (the
 * encoded result is long; a refusal must not take the result down with it).
 */
function pushPermalink(result: ScanResult): string | null {
  try {
    const url = `${window.location.origin}/playground?s=${encodeShareData(result)}`;
    window.history.replaceState({}, "", url);
    return url;
  } catch {
    return null; // error-ok — an unwritable history entry is not a failed scan
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function GradeRing({ grade, score, color: gradeColor, animating }: { grade: string; score: number | null; color?: string; animating: boolean }) {
  const color = gradeColor || NO_GRADE_COLOR;
  const pct   = animating || typeof score !== "number" ? 0 : Math.max(4, score);
  const r     = 54;
  const circ  = 2 * Math.PI * r;
  const dash  = (pct / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-36 h-36">
        <svg width="144" height="144" viewBox="0 0 144 144" className="rotate-[-90deg]">
          <circle cx="72" cy="72" r={r} fill="none" stroke="var(--border)" strokeWidth="12" />
          <circle
            cx="72" cy="72" r={r}
            fill="none"
            stroke={color}
            strokeWidth="12"
            strokeDasharray={`${circ}`}
            strokeDashoffset={circ - dash}
            strokeLinecap="round"
            style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(0.22,1,0.36,1)" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-5xl font-semibold" style={{ color, lineHeight: 1 }}>{grade}</span>
          <span className="text-sm font-semibold text-foreground-secondary mt-1">
            {typeof score !== "number" ? "not checked" : `${score}/100`}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted font-mono uppercase tracking-widest">Health Score</p>
    </div>
  );
}

// Real-time streaming means arrival order IS the real timing now — no
// artificial setTimeout stagger needed, just a fade-in on mount so each
// module still animates in as its `module:end` event lands.
function ModuleCard({ mod }: { mod: ModuleResult }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const passed = mod.status === "passed";
  // A module whose findings are warnings is not a red light. Painting every
  // non-clean module red is half of why a repo of lint warnings read as an F.
  const blocking = !passed && severityOf(mod.severity) !== "warning" && severityOf(mod.severity) !== "info";
  const accent = passed
    ? { border: "rgba(34,197,94,0.3)", bg: "rgba(34,197,94,0.05)", pill: "bg-green-500/15 text-green-700" }
    : blocking
      ? { border: "rgba(239,68,68,0.3)", bg: "rgba(239,68,68,0.05)", pill: "bg-red-500/15 text-red-700" }
      : { border: "rgba(245,158,11,0.3)", bg: "rgba(245,158,11,0.05)", pill: "bg-amber-500/15 text-amber-700" };
  const noun = blocking ? "blocking" : "warning";
  return (
    <div
      className="rounded-xl border p-4 transition-all duration-500"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(10px)",
        borderColor: accent.border,
        background: accent.bg,
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-foreground">{MODULE_LABELS[mod.name] || mod.name}</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${accent.pill}`}>
          {passed ? "✓ PASS" : `${mod.issues} ${noun}${mod.issues !== 1 ? "s" : ""}`}
        </span>
      </div>
      <p className="text-xs text-muted font-mono">{(mod.duration / 1000).toFixed(2)}s engine time · {mod.checks} checks</p>
    </div>
  );
}

// One chip per module in the full 121-module catalog that ISN'T part of
// the free tier — the "X/120 complete" progress bar needs something to
// count up to, and this is the shadow-preview mechanic (same pattern the
// $29 tier's upsell already uses) rather than either lying about running
// 121 modules for free or showing a misleadingly small "4/4" bar.
function LockedModuleChip({ mod, delay }: { mod: LockedModule; delay: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div
      title={`${mod.name} — unlock with a paid scan`}
      className="rounded-lg border border-border section-alt px-2.5 py-1.5 flex items-center gap-1.5 transition-all duration-300"
      style={{ opacity: visible ? 1 : 0, transform: visible ? "scale(1)" : "scale(0.9)" }}
    >
      <svg className="w-3 h-3 text-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="5" y="11" width="14" height="9" rx="1.5" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <span className="text-[11px] text-muted font-mono truncate">{mod.name}</span>
    </div>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-foreground-secondary">{completed}/{total} modules</span>
        <span className="text-muted">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%`, transition: "width 0.3s ease-out" }}
        />
      </div>
    </div>
  );
}

// The terminal is what the CLI prints, so it stays a dark panel.
function TerminalWindow({ lines, scanning }: { lines: TerminalLine[]; scanning: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const lineColor = (type: TerminalLine["type"]) => {
    if (type === "pass")  return "text-green-400";
    if (type === "fail")  return "text-red-400";
    if (type === "run")   return "text-yellow-400";
    if (type === "done")  return "text-cyan-400";
    if (type === "error") return "text-red-500";
    return "text-panel-muted";
  };

  const linePrefix = (type: TerminalLine["type"]) => {
    if (type === "pass")  return "✓ ";
    if (type === "fail")  return "✗ ";
    if (type === "run")   return "→ ";
    if (type === "done")  return "● ";
    if (type === "error") return "! ";
    return "  ";
  };

  return (
    <div className="rounded-2xl border border-panel-border bg-panel text-panel-foreground overflow-hidden shadow-lg">
      {/* Terminal title bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-panel-border bg-panel-alt">
        <span className="w-3 h-3 rounded-full bg-danger/80" />
        <span className="w-3 h-3 rounded-full bg-warning/80" />
        <span className="w-3 h-3 rounded-full bg-success/80" />
        <span className="ml-3 text-xs text-panel-muted font-mono">gatetest — quick scan</span>
        {scanning && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-yellow-400 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            scanning
          </span>
        )}
      </div>
      {/* Terminal output */}
      <div className="p-4 font-mono text-xs space-y-0.5 min-h-[240px] max-h-[320px] overflow-y-auto">
        {lines.map((line) => (
          <div key={line.id} className={`flex gap-1 ${lineColor(line.type)}`}>
            <span className="shrink-0 select-none">{linePrefix(line.type)}</span>
            <span className="break-all">{line.text}</span>
          </div>
        ))}
        {scanning && (
          <div className="flex gap-1 text-panel-muted">
            <span>  </span>
            <span className="inline-flex gap-0.5">
              <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
              <span className="animate-bounce" style={{ animationDelay: "100ms" }}>.</span>
              <span className="animate-bounce" style={{ animationDelay: "200ms" }}>.</span>
            </span>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PlaygroundPage() {
  const [url, setUrl]             = useState("");
  const [scanning, setScanning]   = useState(false);
  const [result, setResult]       = useState<ScanResult | null>(null);
  const [error, setError]         = useState("");
  const [lines, setLines]         = useState<TerminalLine[]>([]);
  const [gradeAnimating, setGradeAnimating] = useState(true);
  const [liveModules, setLiveModules] = useState<ModuleResult[]>([]);
  const [lockedModules, setLockedModules] = useState<LockedModule[]>([]);
  const [totalModules, setTotalModules] = useState(0);
  const [isSharedView, setIsSharedView] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [permalink, setPermalink] = useState<string | null>(null);
  const lineId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const addLine = useCallback((type: TerminalLine["type"], text: string) => {
    setLines((prev) => [...prev, { id: lineId.current++, type, text }]);
  }, []);

  // Load a shared result from the `?s=` query param, if present. Client-
  // side only (window.location, not useSearchParams) so this page doesn't
  // need a Suspense boundary just for this one optional feature.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get("s");
    if (!shared) return;
    const decoded = decodeShareData(shared);
    if (decoded) {
      setResult(decoded);
      setIsSharedView(true);
      setPermalink(window.location.href);
      setGradeAnimating(false);
    } else {
      setError("This shared link has expired or is invalid — run a new scan below.");
    }
  }, []);

  const runScan = useCallback(async (repoUrl: string) => {
    if (scanning) return;
    const cleanUrl = repoUrl.trim().replace(/\.git$/, "");
    if (!cleanUrl) { setError("Enter a GitHub repo URL"); return; }
    if (!/github\.com\/[^/]+\/[^/?#\s]+/.test(cleanUrl)) {
      setError("Must be a github.com URL — e.g. https://github.com/owner/repo");
      return;
    }

    setScanning(true);
    setResult(null);
    setError("");
    setLines([]);
    setLiveModules([]);
    setLockedModules([]);
    setTotalModules(0);
    setIsSharedView(false);
    setShareCopied(false);
    setPermalink(null);
    setGradeAnimating(true);
    lineId.current = 0;

    abortRef.current = new AbortController();

    const repoLabel = cleanUrl.replace("https://github.com/", "");
    addLine("info", `GATETEST — Quick Scan`);
    addLine("info", `Target: ${repoLabel}`);
    addLine("info", "─────────────────────────────────");

    let lockedDelay = 0;
    try {
      const res = await fetch("/api/playground/scan/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ repo_url: cleanUrl }),
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        let msg = `Scan failed (HTTP ${res.status})`;
        try { const j = await res.json(); msg = j?.error || msg; } catch { /* error-ok — error body unreadable — the status alone is reported */ }
        throw new Error(msg);
      }

      let completed: ScanResult | null = null;
      await consumeSseStream(res, (event, data) => {
        if (event === "start") {
          const d = data as { totalModules: number; freeModules: number };
          setTotalModules(d.totalModules);
          addLine("info", `Suite: quick (${d.freeModules} free of ${d.totalModules} total modules)`);
          addLine("info", "─────────────────────────────────");
        } else if (event === "module:end") {
          const d = data as ModuleResult;
          setLiveModules((prev) => [...prev, d]);
          const sev = severityOf(d.severity);
          const noun = sev === "warning" || sev === "info" ? "warning" : "blocking";
          if (d.status === "passed") addLine("pass", `${MODULE_LABELS[d.name] || d.name} — ${d.checks} checks passed`);
          else if (d.status === "failed") addLine("fail", `${MODULE_LABELS[d.name] || d.name} — ${d.issues} ${noun}${d.issues !== 1 ? "s" : ""}`);
          else addLine("info", `${MODULE_LABELS[d.name] || d.name} — skipped`);
        } else if (event === "module:locked") {
          const d = data as LockedModule;
          lockedDelay += 6;
          setLockedModules((prev) => [...prev, d]);
        } else if (event === "complete") {
          completed = data as ScanResult;
          addLine("info", "─────────────────────────────────");
          addLine("done", `Scan complete — ${completed.countLabel ?? `${completed.totalIssues} findings`} · ${(completed.duration / 1000).toFixed(1)}s engine time · Grade ${completed.grade}`);
          if (completed.scopeLabel) addLine("info", completed.scopeLabel);
          if (completed.resultHeader) addLine("info", completed.resultHeader);
        } else if (event === "error") {
          const d = data as { error?: string };
          throw new Error(d?.error || "Scan errored mid-stream");
        }
      }, abortRef.current.signal);

      if (!completed) throw new Error("Scan stream closed unexpectedly — please try again");
      setResult(completed);
      setPermalink(pushPermalink(completed));
      setTimeout(() => setGradeAnimating(false), 200);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Network error — please try again";
      addLine("error", msg);
      setError(msg);
    } finally {
      setScanning(false);
    }
  }, [scanning, addLine]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runScan(url);
  };

  // The home hero's "Repository" tab hands off here: /playground?repo=<url>
  // prefills the input and starts the free scan, so the visitor's first click
  // on the site is already a running scan (2026-09-10).
  useEffect(() => {
    const repo = new URLSearchParams(window.location.search).get("repo");
    if (!repo) return;
    setUrl(repo);
    runScan(repo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The share link IS the address bar — the permalink pushed when the result
  // rendered. Copying something different from what the visitor can see was
  // the second half of the "reload loses it" complaint.
  const handleShare = useCallback(() => {
    if (!result) return;
    const shareUrl = permalink || `${window.location.origin}/playground?s=${encodeShareData(result)}`;
    navigator.clipboard?.writeText(shareUrl).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }).catch(() => {}); // error-ok: best-effort UI nicety; feature may be unavailable in this browser
  }, [result, permalink]);

  // N3/F3 — wall clock is the headline duration; falls back to the shared
  // definition's honest "engine time only" label when no wallMs was recorded
  // (e.g. a pre-2026-09-22 permalink restored within its 48h window).
  const resultTiming = scanGrade.formatDurationHeadline(
    result ? (result.coverage ?? { engineMs: result.duration }) : null
  );

  return (
    <main>
      <PageHero
        align="center"
        eyebrow="Live · Free · No account needed"
        title={<>Scan any <span className="text-accent">GitHub repo</span></>}
        lede={<>Paste a URL. Watch {QUICK_MODULES.length} battle-tested modules run in real time — and see the full {totalModuleCount()}-module catalogue light up alongside them.</>}
        actions={
          <div className="w-full max-w-3xl mx-auto space-y-4 text-left">
            <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
              {/* The field has no visible label by design (hero search box), so the
                  accessible name comes from a real associated <label>. A placeholder
                  is not a label — it disappears on first keystroke and several
                  screen readers never announce it. */}
              <label className="sr-only" htmlFor="playground-repo-url">
                GitHub repository or website URL to scan
              </label>
              <input
                id="playground-repo-url"
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(""); }}
                placeholder="https://github.com/owner/repo"
                className="flex-1 min-w-0 px-5 py-4 rounded-2xl bg-[var(--surface-solid)] border border-border text-foreground placeholder:text-muted font-mono text-sm focus:outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20 transition-all"
                disabled={scanning}
              />
              <button
                type="submit"
                disabled={scanning || !url.trim()}
                className="btn-cta px-8 py-4 rounded-2xl font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {scanning ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    Scanning…
                  </span>
                ) : "Scan Now →"}
              </button>
            </form>

            {error && (
              <p className="text-sm text-danger font-mono px-1">{error}</p>
            )}

            {/* Example repos */}
            <div className="flex flex-wrap justify-center gap-2">
              <span className="text-xs text-muted font-mono pt-1">Try:</span>
              {EXAMPLE_REPOS.map((repo) => (
                <button
                  key={repo.url}
                  onClick={() => { setUrl(repo.url); setError(""); }}
                  disabled={scanning}
                  className="px-3 py-1 rounded-full text-xs font-mono border border-border bg-[var(--surface-solid)] text-foreground-secondary hover:text-foreground hover:border-accent/50 transition-all disabled:opacity-40"
                >
                  {repo.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      <Section>
        <div className="max-w-5xl mx-auto space-y-12">

        {/* ── Shared-scan banner ── */}
        {isSharedView && result && (
          <div className="rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 flex items-center justify-between gap-3">
            <p className="text-sm text-accent">
              Viewing a saved result for <span className="font-mono">{result.repo_url.replace("https://github.com/", "")}</span>
              {result.sharedAt && ` · shared ${Math.max(0, Math.round((Date.now() - result.sharedAt) / 3_600_000))}h ago`}
            </p>
            <button
              onClick={() => { setIsSharedView(false); setResult(null); setPermalink(null); window.history.replaceState({}, "", "/playground"); }}
              className="text-xs font-mono text-accent hover:underline shrink-0"
            >
              Run a new scan →
            </button>
          </div>
        )}

        {/* ── Progress bar — live during a streaming scan ── */}
        {scanning && totalModules > 0 && (
          <ProgressBar completed={liveModules.length + lockedModules.length} total={totalModules} />
        )}

        {/* ── Terminal + Results ──
            F5 — a permalink (`?s=`) restores `result` without ever running a
            scan, so `lines` stays empty. Until 2026-09-22 this block gated on
            `scanning || lines.length > 0` alone, which a restored result never
            satisfies — the grade and findings existed in state but had no
            path to the DOM; only the "Viewing a saved result" banner above
            rendered. `result` now opens the same path a completed scan uses. */}
        {(scanning || lines.length > 0 || result) && (
          <div className="space-y-6">
            {(scanning || lines.length > 0) && (
              <TerminalWindow lines={lines} scanning={scanning} />
            )}

            {/* Results panel — shown after scan completes, or restored from a permalink */}
            {result && !scanning && (
              <div className="space-y-8 animate-in fade-in duration-700">

                {/* ── Report header — the commit, the time, the report id (F2) ── */}
                <div className="rounded-xl border border-border section-alt px-4 py-3 space-y-1">
                  <p className="text-xs font-mono text-foreground-secondary break-all">
                    {result.resultHeader
                      ?? `${result.repo_url.replace("https://github.com/", "")} @ commit not resolved · scan time not recorded · report id not issued`}
                  </p>
                  {/* What the free scan actually read, so 0.1s is never mistaken
                      for a clone-and-build of the whole repository (F3). */}
                  <p className="text-xs font-mono text-muted break-all">
                    {result.scopeLabel ?? "scan scope not recorded"}
                  </p>
                </div>

                {/* Health score + module grid */}
                <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-8 items-start">
                  <GradeRing grade={result.grade} score={result.healthScore} color={result.gradeColor} animating={gradeAnimating} />

                  <div className="space-y-3">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <h2 className="font-display text-xl font-bold text-foreground">
                        {result.countLabel
                          ?? (result.totalIssues === 0
                            ? "0 blocking · 0 warnings"
                            : `${result.totalIssues} finding${result.totalIssues !== 1 ? "s" : ""}`)}
                      </h2>
                      {/* N3/F3 — wall clock is the headline, never the engine-only
                          half of the split read as if it were the whole request
                          (a 0.9s engine time next to an 8.2s wall clock is a
                          40-55% understatement). The split renders beneath. */}
                      <span className="text-xs font-mono text-muted">
                        {resultTiming.headline} {resultTiming.headlineLabel} · quick tier
                      </span>
                    </div>
                    {resultTiming.split && (
                      <p className="text-[11px] font-mono text-muted">{resultTiming.split}</p>
                    )}

                    {result.gradeSummary && (
                      <p className="text-xs text-muted">{result.gradeSummary}</p>
                    )}

                    {result.totalModules ? (
                      <ProgressBar completed={result.modules.length} total={result.totalModules} />
                    ) : null}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {result.modules.map((mod) => (
                        <ModuleCard key={mod.name} mod={mod} />
                      ))}
                    </div>

                    {lockedModules.length > 0 && !isSharedView && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {lockedModules.map((mod) => (
                          <LockedModuleChip key={mod.name} mod={mod} delay={0} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Top findings — severity colour-coded; the fix CTA is gated on the viewer */}
                {result.topFindings.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <h3 className="text-sm font-bold text-muted uppercase tracking-widest font-mono">
                        Top Findings
                      </h3>
                      <button
                        onClick={handleShare}
                        className="text-xs font-mono text-muted hover:text-foreground transition-colors flex items-center gap-1.5"
                      >
                        {shareCopied ? (
                          <>✓ Link copied</>
                        ) : (
                          <>
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                              <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
                            </svg>
                            Share results (link works for 48h)
                          </>
                        )}
                      </button>
                    </div>
                    {/* issue #651 — the badge's own "needs account scan" copy says this
                        same thing; a customer reading a shared free-scan link should not
                        conclude their README badge updated when it did not. */}
                    <p className="text-[11px] font-mono text-muted text-right -mt-1">
                      <Link href="/playground" className="underline hover:text-foreground transition-colors">
                        This free scan
                      </Link>{" "}
                      doesn&apos;t update a badge — an account scan does.
                    </p>
                    <div className="space-y-2">
                      {result.topFindings.slice(0, 8).map((f, i) => {
                        const sev = severityOf(f.severity);
                        const style = SEVERITY_STYLE[sev];
                        return (
                          <div
                            key={i}
                            className={`rounded-xl border ${style.border} ${style.bg} px-4 py-3 flex items-start gap-3`}
                          >
                            <span className={`shrink-0 mt-1 w-1.5 h-1.5 rounded-full ${style.dot}`} />
                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`text-[10px] font-bold ${style.text} font-mono uppercase tracking-wider`}>
                                  {style.label}
                                </span>
                                <span className="text-xs font-bold text-muted font-mono uppercase">{f.module}</span>
                              </div>
                              <p className="text-sm text-foreground-secondary break-all">{f.message}</p>
                            </div>
                            {/* F4 — the fix CTA is only real for someone who can
                                push to this repository. Everyone else gets the
                                sign-in link, or nothing. `viewer` is resolved
                                server-side from the session cookie. */}
                            {!isSharedView && result.viewer?.canFix && (
                              <Link
                                href={`/checkout?tier=scan_fix&repo=${encodeURIComponent(result.repo_url)}&module=${encodeURIComponent(f.module)}`}
                                className="btn-secondary shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap"
                                title="Open a fix PR on this repository with the Scan + Fix tier"
                              >
                                Fix This PR →
                              </Link>
                            )}
                            {!isSharedView && !result.viewer?.canFix && !result.viewer?.signedIn && result.viewer?.canSignIn && (
                              <a
                                href="/api/auth/github"
                                className="shrink-0 text-xs font-mono text-muted hover:text-foreground underline whitespace-nowrap"
                                title="Sign in to check whether you can open a fix PR on this repository"
                              >
                                Sign in to fix
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Upgrade CTA */}
                <div className="card-highlight p-6 space-y-4">
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-foreground">{result.upgradeNote}</p>
                    <p className="text-xs text-muted">
                      The full scan adds N+1 queries, race conditions, money float bugs, TLS bypasses,
                      secret rotation age, PR size enforcement, and {totalModuleCount() - QUICK_MODULES.length} more battle-tested checks.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Link
                      href={`/checkout?tier=full&repo=${encodeURIComponent(result.repo_url)}`}
                      className="btn-cta px-5 py-2.5 rounded-xl text-sm font-bold"
                    >
                      Full Scan — $99
                    </Link>
                    <Link
                      href={`/checkout?tier=scan_fix&repo=${encodeURIComponent(result.repo_url)}`}
                      className="btn-secondary px-5 py-2.5 rounded-xl text-sm font-bold"
                    >
                      Scan + Fix — $199
                    </Link>
                    <Link
                      href={`/checkout?tier=nuclear&repo=${encodeURIComponent(result.repo_url)}`}
                      className="btn-secondary px-5 py-2.5 rounded-xl text-sm font-bold"
                    >
                      Forensic — $399
                    </Link>
                  </div>
                  <p className="text-xs text-muted">
                    One-time payment · Never auto-renews · Results in minutes
                  </p>
                </div>

                {/* Badge embed section — the snippet is what the README renders, so it stays
                    a dark panel. N2 — a partial-coverage scan (file cap reached) says so in
                    the markdown's own alt text, not just in the grade line above; a badge
                    pasted into a README outlives this page and must carry the caveat itself. */}
                <div className="card p-6 space-y-3">
                  <h3 className="text-sm font-bold text-foreground">Add a live badge to your README</h3>
                  <p className="text-xs text-muted">
                    Shows your live GateTest grade — updates after every scan.
                    {result.coverage?.partial && (
                      <> Partial coverage: scanned {result.coverage.scanned} of {result.coverage.total} files (file cap reached).</>
                    )}
                  </p>
                  <div className="rounded-xl bg-panel text-panel-foreground border border-panel-border p-3 font-mono text-xs overflow-x-auto">
                    {`[![GateTest${result.coverage?.partial ? " (partial coverage)" : ""}](${badgeUrl(`/badge/${
                      result.repo_url.replace("https://github.com/", "")
                    }`)})](${SITE_URL})`}
                  </div>
                </div>

              </div>
            )}
          </div>
        )}

        {/* ── Initial state — feature callouts ──
            Excludes a restored permalink too (F5) — otherwise these three
            generic cards rendered underneath a real result with no scan and
            no lines recorded, since this condition previously only checked
            `scanning`/`lines`, neither of which a restored `result` sets. */}
        {!scanning && lines.length === 0 && !result && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                icon: "⚡",
                title: "4 modules, real results",
                body: "Syntax validation, lint rules, secret detection, and code quality — the four checks that catch the most critical issues.",
              },
              {
                icon: "🎯",
                title: "Real checks, real findings",
                body: `This isn't a canned demo — it runs the same four checks a paid Quick Scan does against your actual code. Paid Full, Scan + Fix and Forensic scans run every applicable module of the ${TOTAL_MODULES}-module engine on top.`,
              },
              {
                icon: "🔒",
                title: "Nothing stored",
                body: "Your code is fetched from GitHub's public API, scanned in memory, and discarded. We store nothing from playground scans.",
              },
            ].map((card) => (
              <div key={card.title} className="card p-5 space-y-2">
                <span className="text-2xl">{card.icon}</span>
                <h3 className="text-sm font-bold text-foreground">{card.title}</h3>
                <p className="text-xs text-muted leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Related links ── */}
        <div className="text-center text-xs text-muted font-mono space-x-4">
          <Link href="/#pricing" className="hover:text-foreground transition-colors">Pricing</Link>
          <Link href="/badge" className="hover:text-foreground transition-colors">README Badge</Link>
          <Link href="/docs/api" className="hover:text-foreground transition-colors">API Docs</Link>
        </div>
        </div>
      </Section>
    </main>
  );
}
