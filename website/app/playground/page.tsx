"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { consumeSseStream } from "@/app/components/url-scan-flow-sse";
import { totalModuleCount } from "@/app/components/howitworks/modules-data";

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

type Severity = "critical" | "warning" | "info";

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
  healthScore: number;
  grade: string;
  gradeColor: string;
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

const GRADE_RING_COLOR: Record<string, string> = {
  A: "#22c55e",
  B: "#0d9488",
  C: "#eab308",
  D: "#f97316",
  F: "#ef4444",
};

const SEVERITY_STYLE: Record<Severity, { label: string; text: string; bg: string; border: string; dot: string }> = {
  critical: { label: "CRITICAL", text: "text-red-400",    bg: "bg-red-500/[0.06]",    border: "border-red-500/25",    dot: "bg-red-500" },
  warning:  { label: "WARNING",  text: "text-amber-400",  bg: "bg-amber-500/[0.06]",  border: "border-amber-500/25",  dot: "bg-amber-500" },
  info:     { label: "INFO",     text: "text-sky-400",    bg: "bg-sky-500/[0.06]",    border: "border-sky-500/25",    dot: "bg-sky-500" },
};

function severityOf(raw: string | undefined): Severity {
  return raw === "critical" || raw === "warning" || raw === "info" ? raw : "warning";
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

// ── Sub-components ────────────────────────────────────────────────────────────

function GradeRing({ grade, score, animating }: { grade: string; score: number; animating: boolean }) {
  const color = GRADE_RING_COLOR[grade] || "#6b7280";
  const pct   = animating ? 0 : Math.max(4, score);
  const r     = 54;
  const circ  = 2 * Math.PI * r;
  const dash  = (pct / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-36 h-36">
        <svg width="144" height="144" viewBox="0 0 144 144" className="rotate-[-90deg]">
          <circle cx="72" cy="72" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="12" />
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
          <span className="text-5xl font-black" style={{ color, lineHeight: 1 }}>{grade}</span>
          <span className="text-sm font-semibold text-white/60 mt-1">{score}/100</span>
        </div>
      </div>
      <p className="text-xs text-white/50 font-mono uppercase tracking-widest">Health Score</p>
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
  return (
    <div
      className="rounded-xl border p-4 transition-all duration-500"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(10px)",
        borderColor: passed ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)",
        background: passed ? "rgba(34,197,94,0.05)" : "rgba(239,68,68,0.05)",
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-white/90">{MODULE_LABELS[mod.name] || mod.name}</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${passed ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
          {passed ? "✓ PASS" : `✗ ${mod.issues} issue${mod.issues !== 1 ? "s" : ""}`}
        </span>
      </div>
      <p className="text-xs text-white/40 font-mono">{(mod.duration / 1000).toFixed(2)}s · {mod.checks} checks</p>
    </div>
  );
}

// One chip per module in the full 120-module catalog that ISN'T part of
// the free tier — the "X/120 complete" progress bar needs something to
// count up to, and this is the shadow-preview mechanic (same pattern the
// $29 tier's upsell already uses) rather than either lying about running
// 120 modules for free or showing a misleadingly small "4/4" bar.
function LockedModuleChip({ mod, delay }: { mod: LockedModule; delay: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div
      title={`${mod.name} — unlock with a paid scan`}
      className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-2.5 py-1.5 flex items-center gap-1.5 transition-all duration-300"
      style={{ opacity: visible ? 1 : 0, transform: visible ? "scale(1)" : "scale(0.9)" }}
    >
      <svg className="w-3 h-3 text-white/25 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="5" y="11" width="14" height="9" rx="1.5" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <span className="text-[11px] text-white/30 font-mono truncate">{mod.name}</span>
    </div>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-white/50">{completed}/{total} modules</span>
        <span className="text-white/30">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, #059669, #0891b2)",
            transition: "width 0.3s ease-out",
          }}
        />
      </div>
    </div>
  );
}

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
    return "text-white/60";
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
    <div className="rounded-2xl border border-white/10 bg-[#0a0a0a] overflow-hidden shadow-2xl">
      {/* Terminal title bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/[0.02]">
        <span className="w-3 h-3 rounded-full bg-red-500/70" />
        <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
        <span className="w-3 h-3 rounded-full bg-green-500/70" />
        <span className="ml-3 text-xs text-white/30 font-mono">gatetest — quick scan</span>
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
          <div className="flex gap-1 text-white/30">
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
        try { const j = await res.json(); msg = j?.error || msg; } catch { /* ignore */ }
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
          if (d.status === "passed") addLine("pass", `${MODULE_LABELS[d.name] || d.name} — ${d.checks} checks passed`);
          else if (d.status === "failed") addLine("fail", `${MODULE_LABELS[d.name] || d.name} — ${d.issues} issue${d.issues !== 1 ? "s" : ""} found`);
          else addLine("info", `${MODULE_LABELS[d.name] || d.name} — skipped`);
        } else if (event === "module:locked") {
          const d = data as LockedModule;
          lockedDelay += 6;
          setLockedModules((prev) => [...prev, d]);
        } else if (event === "complete") {
          completed = data as ScanResult;
          addLine("info", "─────────────────────────────────");
          addLine("done", `Scan complete — ${completed.totalIssues} issue${completed.totalIssues !== 1 ? "s" : ""} · ${(completed.duration / 1000).toFixed(1)}s · Grade ${completed.grade}`);
        } else if (event === "error") {
          const d = data as { error?: string };
          throw new Error(d?.error || "Scan errored mid-stream");
        }
      }, abortRef.current.signal);

      if (!completed) throw new Error("Scan stream closed unexpectedly — please try again");
      setResult(completed);
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

  const handleShare = useCallback(() => {
    if (!result) return;
    const encoded = encodeShareData(result);
    const shareUrl = `${window.location.origin}/playground?s=${encoded}`;
    navigator.clipboard?.writeText(shareUrl).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }).catch(() => {}); // error-ok: best-effort UI nicety; feature may be unavailable in this browser
  }, [result]);

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      {/* ── Nav breadcrumb ── */}
      <div className="border-b border-white/[0.06]">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-2 text-sm text-white/40">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/70">Playground</span>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-12 space-y-12">

        {/* ── Hero ── */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.04] text-xs text-white/50 font-mono uppercase tracking-widest">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Live · Free · No account needed
          </div>
          <h1 className="text-4xl sm:text-5xl font-black tracking-tight">
            Scan any{" "}
            <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              GitHub repo
            </span>
          </h1>
          <p className="text-lg text-white/50 max-w-xl mx-auto">
            Paste a URL. Watch {QUICK_MODULES.length} battle-tested modules run in real time —
            and see the full {totalModuleCount()}-module catalogue light up alongside them.
          </p>
        </div>

        {/* ── URL Input ── */}
        <div className="space-y-4">
          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
            <input
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setError(""); }}
              placeholder="https://github.com/owner/repo"
              className="flex-1 px-5 py-4 rounded-2xl bg-white/[0.05] border border-white/10 text-white placeholder-white/25 font-mono text-sm focus:outline-none focus:border-emerald-500/60 focus:bg-white/[0.07] transition-all"
              disabled={scanning}
            />
            <button
              type="submit"
              disabled={scanning || !url.trim()}
              className="px-8 py-4 rounded-2xl font-bold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: scanning
                  ? "rgba(34,197,94,0.2)"
                  : "linear-gradient(135deg, #059669, #0891b2)",
                color: "#fff",
              }}
            >
              {scanning ? (
                <span className="flex items-center gap-2">
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
            <p className="text-sm text-red-400 font-mono px-1">{error}</p>
          )}

          {/* Example repos */}
          <div className="flex flex-wrap gap-2">
            <span className="text-xs text-white/30 font-mono pt-1">Try:</span>
            {EXAMPLE_REPOS.map((repo) => (
              <button
                key={repo.url}
                onClick={() => { setUrl(repo.url); setError(""); }}
                disabled={scanning}
                className="px-3 py-1 rounded-full text-xs font-mono border border-white/10 bg-white/[0.03] text-white/50 hover:text-white/80 hover:border-white/20 transition-all disabled:opacity-40"
              >
                {repo.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Shared-scan banner ── */}
        {isSharedView && result && (
          <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.06] px-4 py-3 flex items-center justify-between gap-3">
            <p className="text-sm text-cyan-300">
              Viewing a shared scan of <span className="font-mono">{result.repo_url.replace("https://github.com/", "")}</span>
              {result.sharedAt && ` · shared ${Math.max(0, Math.round((Date.now() - result.sharedAt) / 3_600_000))}h ago`}
            </p>
            <button
              onClick={() => { setIsSharedView(false); setResult(null); window.history.replaceState({}, "", "/playground"); }}
              className="text-xs font-mono text-cyan-300/70 hover:text-cyan-300 shrink-0"
            >
              Run a new scan →
            </button>
          </div>
        )}

        {/* ── Progress bar — live during a streaming scan ── */}
        {scanning && totalModules > 0 && (
          <ProgressBar completed={liveModules.length + lockedModules.length} total={totalModules} />
        )}

        {/* ── Terminal + Results ── */}
        {(scanning || lines.length > 0) && (
          <div className="space-y-6">
            <TerminalWindow lines={lines} scanning={scanning} />

            {/* Results panel — shown after scan completes */}
            {result && !scanning && (
              <div className="space-y-8 animate-in fade-in duration-700">

                {/* Health score + module grid */}
                <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-8 items-start">
                  <GradeRing grade={result.grade} score={result.healthScore} animating={gradeAnimating} />

                  <div className="space-y-3">
                    <div className="flex items-baseline gap-3">
                      <h2 className="text-xl font-bold text-white">
                        {result.totalIssues === 0
                          ? "Clean — no issues found"
                          : `${result.totalIssues} issue${result.totalIssues !== 1 ? "s" : ""} found`}
                      </h2>
                      <span className="text-xs font-mono text-white/30">
                        {(result.duration / 1000).toFixed(1)}s · quick tier
                      </span>
                    </div>

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

                {/* Top findings — severity colour-coded, with a Fix This PR CTA per finding */}
                {result.topFindings.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-white/50 uppercase tracking-widest font-mono">
                        Top Findings
                      </h3>
                      <button
                        onClick={handleShare}
                        className="text-xs font-mono text-white/40 hover:text-white/70 transition-colors flex items-center gap-1.5"
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
                                <span className="text-xs font-bold text-white/50 font-mono uppercase">{f.module}</span>
                              </div>
                              <p className="text-sm text-white/70 break-all">{f.message}</p>
                            </div>
                            {!isSharedView && (
                              <Link
                                href={`/checkout?tier=scan_fix&repo=${encodeURIComponent(result.repo_url)}&module=${encodeURIComponent(f.module)}`}
                                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold border border-white/15 text-white/70 hover:border-emerald-500/50 hover:text-emerald-400 transition-all whitespace-nowrap"
                                title="Unlock AI-generated fixes with the Scan + Fix tier"
                              >
                                Fix This PR →
                              </Link>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Upgrade CTA */}
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-white/70">{result.upgradeNote}</p>
                    <p className="text-xs text-white/40">
                      The full scan adds N+1 queries, race conditions, money float bugs, TLS bypasses,
                      secret rotation age, PR size enforcement, and {totalModuleCount() - QUICK_MODULES.length} more battle-tested checks.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Link
                      href={`/checkout?tier=quick&repo=${encodeURIComponent(result.repo_url)}`}
                      className="px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all"
                      style={{ background: "linear-gradient(135deg, #059669, #0891b2)" }}
                    >
                      Full Scan — $29
                    </Link>
                    <Link
                      href={`/checkout?tier=scan_fix&repo=${encodeURIComponent(result.repo_url)}`}
                      className="px-5 py-2.5 rounded-xl text-sm font-bold border border-white/20 text-white/80 hover:border-white/40 transition-all"
                    >
                      Scan + Fix — $199
                    </Link>
                    <Link
                      href={`/checkout?tier=nuclear&repo=${encodeURIComponent(result.repo_url)}`}
                      className="px-5 py-2.5 rounded-xl text-sm font-bold border border-white/20 text-white/80 hover:border-white/40 transition-all"
                    >
                      Forensic — $399
                    </Link>
                  </div>
                  <p className="text-xs text-white/25">
                    One-time payment · No subscription · Results in minutes
                  </p>
                </div>

                {/* Badge embed section */}
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-3">
                  <h3 className="text-sm font-bold text-white/70">Add a live badge to your README</h3>
                  <p className="text-xs text-white/40">
                    Shows your live GateTest grade — updates after every scan.
                  </p>
                  <div className="rounded-xl bg-black/40 border border-white/10 p-3 font-mono text-xs text-white/60 overflow-x-auto">
                    {`[![GateTest](https://gatetest.ai/badge/${
                      result.repo_url.replace("https://github.com/", "")
                    })](https://gatetest.ai)`}
                  </div>
                </div>

              </div>
            )}
          </div>
        )}

        {/* ── Initial state — feature callouts ── */}
        {!scanning && lines.length === 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                icon: "⚡",
                title: "4 modules, real results",
                body: "Syntax validation, lint rules, secret detection, and code quality — the four checks that catch the most critical issues.",
              },
              {
                icon: "🎯",
                title: "Same engine, full power",
                body: "This isn't a demo. It's the identical engine that runs in production for paid scans — just limited to the quick tier.",
              },
              {
                icon: "🔒",
                title: "Nothing stored",
                body: "Your code is fetched from GitHub's public API, scanned in memory, and discarded. We store nothing from playground scans.",
              },
            ].map((card) => (
              <div
                key={card.title}
                className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 space-y-2"
              >
                <span className="text-2xl">{card.icon}</span>
                <h3 className="text-sm font-bold text-white/80">{card.title}</h3>
                <p className="text-xs text-white/40 leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Footer links ── */}
        <div className="text-center text-xs text-white/25 font-mono space-x-4">
          <Link href="/" className="hover:text-white/50 transition-colors">Home</Link>
          <Link href="/#pricing" className="hover:text-white/50 transition-colors">Pricing</Link>
          <Link href="/badge" className="hover:text-white/50 transition-colors">README Badge</Link>
          <Link href="/docs/api" className="hover:text-white/50 transition-colors">API Docs</Link>
        </div>
      </div>
    </div>
  );
}
