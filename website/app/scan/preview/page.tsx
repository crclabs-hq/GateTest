"use client";

import React, { useState, FormEvent, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

interface ModuleSummary {
  module: string;
  status: string;
  issues: number;
}

interface PreviewFinding {
  module: string;
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
}

interface PreviewResult {
  ok: boolean;
  repo?: string;
  durationMs?: number;
  moduleSummary?: ModuleSummary[];
  findings?: PreviewFinding[];
  total?: number;
  truncated?: boolean;
  nextStep?: {
    price: string;
    message: string;
  };
  error?: string;
  hint?: string;
}

const EXAMPLE_REPOS = [
  { label: "vercel/next.js", url: "https://github.com/vercel/next.js", note: "React framework" },
  { label: "expressjs/express", url: "https://github.com/expressjs/express", note: "Node.js server" },
  { label: "supabase/supabase", url: "https://github.com/supabase/supabase", note: "Open-source Firebase" },
  { label: "crclabs-hq/gatetest", url: "https://github.com/crclabs-hq/gatetest", note: "GateTest itself" },
];

const QUICK_MODULES = ["syntax", "lint", "secrets", "codeQuality"];

const SEV_TERM = {
  error:   { bg: "bg-red-950/60",   badge: "bg-red-500/20 text-red-400 border border-red-500/30",   label: "ERR" },
  warning: { bg: "bg-amber-950/40", badge: "bg-amber-500/20 text-amber-400 border border-amber-500/30", label: "WARN" },
  info:    { bg: "bg-slate-900/60", badge: "bg-slate-600/30 text-slate-400 border border-slate-600/30", label: "INFO" },
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 text-white/30 hover:text-white transition-colors mt-0.5"
      title="Copy to clipboard"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function PreviewPageContent() {
  const searchParams = useSearchParams();
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState("");
  const [activeModule, setActiveModule] = useState(-1);
  const [doneModules, setDoneModules] = useState<string[]>([]);
  const resultsRef = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);

  // Auto-start when ?repo= is in the URL
  useEffect(() => {
    const repoParam = searchParams.get("repo");
    if (repoParam && !autoStarted.current) {
      autoStarted.current = true;
      setRepoUrl(repoParam);
      runScan(repoParam);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runScan(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setResult(null);
    setError("");
    setActiveModule(0);
    setDoneModules([]);

    // Animate module progress while waiting for the API
    let idx = 0;
    const tick = setInterval(() => {
      if (idx < QUICK_MODULES.length - 1) {
        setDoneModules((d) => [...d, QUICK_MODULES[idx]]);
        idx++;
        setActiveModule(idx);
      }
    }, 3000);

    try {
      const res = await fetch("/api/scan/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: trimmed }),
      });
      const data = (await res.json()) as PreviewResult;
      if (!data.ok) {
        setError(data.hint || data.error || "Preview scan failed");
      } else {
        setResult(data);
        setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — please try again");
    } finally {
      clearInterval(tick);
      setDoneModules([...QUICK_MODULES]);
      setActiveModule(-1);
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await runScan(repoUrl);
  }

  function tryExample(url: string) {
    setRepoUrl(url);
    runScan(url);
  }

  const hasErrors = result?.findings?.some((f: PreviewFinding) => f.severity === "error");
  const issueCount = result?.total ?? 0;

  return (
    <main className="min-h-screen bg-[#0d1117] text-white">

      {/* Top nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-xs font-mono">G</span>
            </div>
            <span className="text-base font-bold tracking-tight">
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>
          <div className="flex items-center gap-4 text-sm text-white/50">
            <Link href="/scans" className="hover:text-white transition-colors">Hall of Scans</Link>
            <Link href="/#pricing" className="hover:text-white transition-colors">Pricing</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 py-14">

        {/* Header */}
        <div className="mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
            Free preview · no card · no signup
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3 leading-tight">
            Real bugs. Real repos.{" "}
            <span className="text-teal-400">Right now.</span>
          </h1>
          <p className="text-white/55 text-base leading-relaxed max-w-xl">
            GateTest runs four modules — syntax, lint, secrets, code quality — against
            any public GitHub repo and shows you up to 5 real findings.
            Scanned in memory. Never stored.
          </p>
        </div>

        {/* Example repos — the "holy shit" moment */}
        <div className="mb-8">
          <p className="text-xs text-white/40 uppercase tracking-wider font-medium mb-3">
            Try a repo you already know
          </p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_REPOS.map((ex) => (
              <button
                key={ex.url}
                type="button"
                onClick={() => tryExample(ex.url)}
                disabled={loading}
                className="group flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] hover:border-teal-500/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-white/40 group-hover:text-teal-400 transition-colors shrink-0">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                <div className="text-left">
                  <div className="text-xs font-mono text-white/80 group-hover:text-white transition-colors">{ex.label}</div>
                  <div className="text-[10px] text-white/35">{ex.note}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex gap-2">
            <input
              id="repo-url-input"
              type="url"
              value={repoUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/10 text-white placeholder:text-white/25 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/50 focus:border-teal-500/50 transition-all"
              disabled={loading}
              required
            />
            <button
              type="submit"
              disabled={loading || !repoUrl.trim()}
              className="px-5 py-3 rounded-xl bg-teal-600 text-white font-semibold text-sm hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {loading ? "Scanning…" : "Scan free →"}
            </button>
          </div>
          <p className="mt-2 text-xs text-white/30">
            Public repos only. Private repos require the{" "}
            <Link href="/github/setup" className="text-teal-400 hover:underline">GitHub App</Link>.
          </p>
        </form>

        {/* Terminal scan progress */}
        {loading && (
          <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden mb-8">
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
              <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-xs text-white/30 font-mono">gatetest --suite quick {repoUrl.replace("https://github.com/", "")}</span>
            </div>
            <div className="p-5 font-mono text-sm space-y-2">
              {QUICK_MODULES.map((mod, i) => {
                const done = doneModules.includes(mod);
                const active = i === activeModule;
                return (
                  <div key={mod} className={`flex items-center gap-3 transition-opacity ${i > activeModule && !done ? "opacity-30" : "opacity-100"}`}>
                    <span className={`shrink-0 ${done ? "text-emerald-400" : active ? "text-teal-400" : "text-white/20"}`}>
                      {done ? "✓" : active ? "▶" : "·"}
                    </span>
                    <span className={`${done ? "text-emerald-400" : active ? "text-teal-300" : "text-white/30"}`}>
                      {mod}
                    </span>
                    {active && (
                      <span className="text-white/40 text-xs">
                        scanning
                        <span className="inline-flex gap-0.5 ml-1">
                          <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                          <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                          <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
                        </span>
                      </span>
                    )}
                    {done && <span className="text-white/25 text-xs">done</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="rounded-xl bg-amber-950/30 border border-amber-500/20 p-5 mb-8">
            <p className="text-sm font-semibold text-amber-400 mb-1">Scan failed</p>
            <p className="text-sm text-amber-500/80">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div ref={resultsRef} className="space-y-5">

            {/* Summary terminal header */}
            <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden">
              <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
                <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                <div className="w-3 h-3 rounded-full bg-[#28c840]" />
                <span className="ml-3 text-xs text-white/30 font-mono">scan complete</span>
              </div>
              <div className="p-5">
                <div className="flex items-start justify-between gap-4 mb-5">
                  <div>
                    <p className="font-mono text-sm font-semibold text-white">{result.repo}</p>
                    <p className="text-xs text-white/35 mt-0.5 font-mono">
                      {result.durationMs != null ? `${(result.durationMs / 1000).toFixed(1)}s` : ""} · quick suite · 4 modules
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-3xl font-bold font-mono ${issueCount === 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {issueCount}
                    </div>
                    <div className="text-xs text-white/35">issues found</div>
                  </div>
                </div>

                {/* Module breakdown — terminal style */}
                <div className="space-y-1.5 font-mono text-sm">
                  {result.moduleSummary?.map((m: ModuleSummary) => (
                    <div key={m.module} className="flex items-center gap-3">
                      <span className={`shrink-0 ${m.status === "passed" ? "text-emerald-400" : m.status === "failed" ? "text-red-400" : "text-white/30"}`}>
                        {m.status === "passed" ? "[PASS]" : m.status === "failed" ? "[FAIL]" : "[ -- ]"}
                      </span>
                      <span className={`${m.status === "passed" ? "text-emerald-300/80" : m.status === "failed" ? "text-red-300/80" : "text-white/40"}`}>
                        {m.module}
                      </span>
                      {m.issues > 0 && (
                        <span className="ml-auto text-red-400 font-bold">{m.issues} issue{m.issues !== 1 ? "s" : ""}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Findings — terminal style */}
            {(result.findings?.length ?? 0) > 0 ? (
              <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden">
                <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
                  <span className="text-xs font-mono text-white/50">
                    {result.truncated
                      ? `showing top ${result.findings!.length} of ${result.total} findings`
                      : `${result.findings!.length} finding${result.findings!.length !== 1 ? "s" : ""}`}
                  </span>
                  {result.truncated && (
                    <span className="text-xs text-amber-400/80 font-mono">{result.total! - result.findings!.length} more hidden</span>
                  )}
                </div>
                <div className="divide-y divide-white/[0.04]">
                  {result.findings!.map((f: PreviewFinding, i: number) => {
                    const cfg = SEV_TERM[f.severity];
                    return (
                      <div key={i} className={`px-5 py-4 ${cfg.bg}`}>
                        <div className="flex items-start gap-3">
                          <span className={`shrink-0 text-[10px] font-bold font-mono px-1.5 py-0.5 rounded ${cfg.badge}`}>
                            {cfg.label}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <span className="text-xs font-mono text-teal-400">{f.module}</span>
                              {f.file && (
                                <span className="text-xs font-mono text-white/40 truncate">
                                  {f.file}{f.line != null ? `:${f.line}` : ""}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-white/80 leading-snug">{f.message}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-emerald-950/30 border border-emerald-500/20 p-6 text-center">
                <p className="font-mono text-emerald-400 font-semibold mb-1">[PASS] all 4 modules — no issues found</p>
                <p className="text-sm text-white/40 mt-2">
                  Quick suite covers 4 modules. Full scan ($99) runs all 110 —
                  including security, supply chain, auth flaws, CI hardening.
                </p>
              </div>
            )}

            {/* Upsell — truncated */}
            {result.truncated && (
              <div className="rounded-xl bg-white/[0.03] border border-teal-500/20 p-6">
                <p className="font-semibold text-white mb-1">
                  {result.total! - result.findings!.length} more issue{result.total! - result.findings!.length !== 1 ? "s" : ""} not shown
                </p>
                <p className="text-sm text-white/50 mb-4">{result.nextStep?.message}</p>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href="/#pricing"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal-600 text-white font-semibold text-sm hover:bg-teal-500 transition-colors"
                  >
                    See full results — from $29 →
                  </Link>
                  <Link
                    href="/scans"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-white/10 text-white/70 font-semibold text-sm hover:bg-white/[0.04] transition-colors"
                  >
                    Hall of Scans →
                  </Link>
                </div>
              </div>
            )}

            {/* All clear upsell */}
            {!result.truncated && issueCount === 0 && (
              <div className="rounded-xl bg-white/[0.03] border border-white/10 p-6">
                <p className="font-semibold text-white mb-1">Quick scan: all clear.</p>
                <p className="text-sm text-white/50 mb-4">
                  4 modules checked. The Full scan ($99) runs all 110 —
                  security, supply chain, auth flaws, CI hardening, AI code review.
                </p>
                <Link
                  href="/#pricing"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal-600 text-white font-semibold text-sm hover:bg-teal-500 transition-colors"
                >
                  Run full scan — $99 →
                </Link>
              </div>
            )}

            {/* Found errors upsell */}
            {hasErrors && !result.truncated && (
              <div className="rounded-xl bg-red-950/30 border border-red-500/20 p-6">
                <p className="font-semibold text-red-400 mb-1">Real issues found — these need fixing.</p>
                <p className="text-sm text-white/50 mb-4">
                  Scan + Fix ($199) opens a pull request with the fixes already written,
                  pair-reviewed by a second Claude, and regression-tested. You review the diff,
                  you click merge.
                </p>
                <Link
                  href="/#pricing"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 text-white font-semibold text-sm hover:bg-red-700 transition-colors"
                >
                  Fix these issues — from $99 →
                </Link>
              </div>
            )}

            {/* Add to CI — the "I want this on my own repo" moment */}
            <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden">
              <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
                <span className="text-xs font-mono text-white/50">add to your CI</span>
                <span className="text-xs text-teal-400/80 font-mono">~30 seconds</span>
              </div>
              <div className="p-5 space-y-4">
                <p className="text-sm text-white/60">
                  Run this against <em>your</em> repo on every push. One curl command drops the workflow, pre-push hook, and protection marker.
                </p>
                <div className="rounded-lg bg-black/40 border border-white/[0.06] px-4 py-3 font-mono text-xs text-emerald-300 flex items-start justify-between gap-3 group">
                  <span className="break-all">curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash</span>
                  <CopyButton text="curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash" />
                </div>
                <p className="text-xs text-white/30">
                  Or install the{" "}
                  <Link href="/github/setup" className="text-teal-400 hover:underline">GitHub App</Link>
                  {" "}for automatic scanning on every push and PR — no config needed.
                </p>
              </div>
            </div>

            {/* Try another repo */}
            <div className="pt-2">
              <p className="text-xs text-white/30 uppercase tracking-wider font-medium mb-3">Try another</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_REPOS.filter((ex) => !repoUrl.includes(ex.label)).map((ex) => (
                  <button
                    key={ex.url}
                    type="button"
                    onClick={() => tryExample(ex.url)}
                    className="text-xs font-mono px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/60 hover:text-white hover:border-teal-500/40 transition-all"
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Bottom note — idle state */}
        {!result && !loading && (
          <div className="text-center">
            <p className="text-xs text-white/30">
              See what GateTest found in real production codebases →{" "}
              <Link href="/scans" className="text-teal-400 hover:underline">
                Hall of Scans
              </Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

export default function PreviewPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-[#0d1117] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-teal-500/40 border-t-teal-400 rounded-full animate-spin" />
      </main>
    }>
      <PreviewPageContent />
    </Suspense>
  );
}
