"use client";

import React, { useState, FormEvent } from "react";
import Link from "next/link";

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

const SEVERITY_COLORS = {
  error: "text-red-600 bg-red-50 border-red-200",
  warning: "text-amber-700 bg-amber-50 border-amber-200",
  info: "text-slate-600 bg-slate-50 border-slate-200",
};

const SEVERITY_LABELS = {
  error: "ERROR",
  warning: "WARN",
  info: "INFO",
};

export default function PreviewPage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!repoUrl.trim()) return;
    setLoading(true);
    setResult(null);
    setError("");

    try {
      const res = await fetch("/api/scan/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: repoUrl.trim() }),
      });
      const data = (await res.json()) as PreviewResult;
      if (!data.ok) {
        setError(data.hint || data.error || "Preview scan failed");
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const hasErrors = result?.findings?.some((f: PreviewFinding) => f.severity === "error");

  return (
    <main className="min-h-screen bg-background px-6 py-16">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-teal-50 border border-teal-200 text-teal-700 text-sm font-medium mb-5">
            <span className="w-2 h-2 rounded-full bg-teal-500" />
            Free preview &middot; no card required
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3">
            See what&apos;s in your repo
          </h1>
          <p className="text-muted text-base leading-relaxed max-w-xl mx-auto">
            Paste any public GitHub repo URL. GateTest runs four checks —
            syntax, lint, secrets, code quality — and shows you up to 5 real findings.
            Your code is scanned in memory and never stored.
          </p>
        </div>

        {/* Trust strip */}
        <div className="flex flex-wrap justify-center gap-4 mb-8 text-xs text-muted">
          <span className="flex items-center gap-1.5">🔒 Code never stored</span>
          <span className="flex items-center gap-1.5">⚡ Results in ~15s</span>
          <span className="flex items-center gap-1.5">🔓 Public repos only</span>
          <span className="flex items-center gap-1.5">🤖 Powered by Claude Sonnet 4</span>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="card rounded-2xl p-6 mb-8">
          <label className="block text-sm font-semibold mb-2 text-foreground" htmlFor="repo-url-input">
            GitHub repo URL
          </label>
          <div className="flex gap-3">
            <input
              id="repo-url-input"
              type="url"
              value={repoUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 px-4 py-3 rounded-xl border border-border bg-surface-dark text-foreground placeholder:text-muted text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/40"
              disabled={loading}
              required
            />
            <button
              type="submit"
              disabled={loading || !repoUrl.trim()}
              className="px-5 py-3 rounded-xl bg-accent text-white font-semibold text-sm hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Scanning…
                </span>
              ) : (
                "Preview scan"
              )}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Works on any public GitHub repository. Private repos require the{" "}
            <Link href="/github/setup" className="text-accent hover:underline">GitHub App</Link>.
          </p>
        </form>

        {/* Error state */}
        {error && (
          <div className="card rounded-xl p-5 border border-amber-200 bg-amber-50/50 mb-8">
            <p className="text-sm font-semibold text-amber-700 mb-1">Scan failed</p>
            <p className="text-sm text-amber-600">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6">
            {/* Summary bar */}
            <div className="card rounded-2xl p-5">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <p className="font-mono text-sm font-semibold text-foreground">{result.repo}</p>
                  <p className="text-xs text-muted mt-0.5">
                    {result.durationMs != null ? `${(result.durationMs / 1000).toFixed(1)}s` : ""} &middot; quick suite (4 modules)
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-2xl font-bold ${(result.total ?? 0) === 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {result.total ?? 0}
                  </div>
                  <div className="text-xs text-muted">issues found</div>
                </div>
              </div>

              {/* Module breakdown */}
              <div className="grid grid-cols-2 gap-2">
                {result.moduleSummary?.map((m: ModuleSummary) => (
                  <div key={m.module}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                      m.status === "passed"
                        ? "bg-emerald-50 border border-emerald-100 text-emerald-700"
                        : m.status === "failed"
                        ? "bg-red-50 border border-red-100 text-red-700"
                        : "bg-slate-50 border border-slate-200 text-slate-600"
                    }`}>
                    <span className="font-bold shrink-0">
                      {m.status === "passed" ? "✓" : m.status === "failed" ? "!" : "–"}
                    </span>
                    <span className="font-mono truncate">{m.module}</span>
                    {m.issues > 0 && (
                      <span className="ml-auto font-bold shrink-0">{m.issues}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Findings */}
            {(result.findings?.length ?? 0) > 0 ? (
              <div className="card rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-border/50">
                  <h2 className="font-semibold text-sm">
                    {result.truncated
                      ? `Top ${result.findings!.length} of ${result.total} findings`
                      : `${result.findings!.length} finding${result.findings!.length !== 1 ? "s" : ""}`}
                  </h2>
                </div>
                <div className="divide-y divide-border/50">
                  {result.findings!.map((f: PreviewFinding, i: number) => {
                    const cfg = SEVERITY_COLORS[f.severity];
                    return (
                      <div key={i} className="px-5 py-4">
                        <div className="flex items-start gap-3">
                          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${cfg}`}>
                            {SEVERITY_LABELS[f.severity]}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-0.5">
                              <span className="text-xs font-mono text-accent">{f.module}</span>
                              {f.file && (
                                <>
                                  <span className="text-muted text-xs">·</span>
                                  <span className="text-xs font-mono text-muted truncate max-w-[200px]">
                                    {f.file}{f.line != null ? `:${f.line}` : ""}
                                  </span>
                                </>
                              )}
                            </div>
                            <p className="text-sm text-foreground leading-snug">{f.message}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="card rounded-2xl p-6 text-center">
                <div className="text-3xl mb-2">✅</div>
                <p className="font-semibold text-emerald-700">No issues found in quick scan</p>
                <p className="text-sm text-muted mt-1">
                  Quick covers 4 modules. Run a Full scan ($99) to check all 110.
                </p>
              </div>
            )}

            {/* Truncation notice + upsell */}
            {result.truncated && (
              <div className="card rounded-2xl p-6 border border-accent/20 bg-accent/5">
                <p className="font-semibold text-foreground mb-1">
                  {result.total! - result.findings!.length} more issue{result.total! - result.findings!.length !== 1 ? "s" : ""} hidden
                </p>
                <p className="text-sm text-muted mb-4">{result.nextStep?.message}</p>
                <div className="flex flex-wrap gap-3">
                  <a
                    href={`/#pricing`}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white font-semibold text-sm hover:bg-accent/90 transition-colors"
                  >
                    See full results — from $29 &rarr;
                  </a>
                  <Link
                    href="/scans"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-border text-foreground font-semibold text-sm hover:bg-surface-dark transition-colors"
                  >
                    Hall of Scans &rarr;
                  </Link>
                </div>
              </div>
            )}

            {/* All clear upsell */}
            {!result.truncated && (result.total ?? 0) === 0 && (
              <div className="card rounded-2xl p-6 border border-border/50">
                <p className="font-semibold mb-1">Quick scan: all clear.</p>
                <p className="text-sm text-muted mb-4">
                  4 modules checked. The Full scan ($99) runs all 110 modules —
                  including security, supply chain, auth flaws, CI hardening,
                  and AI code review.
                </p>
                <a
                  href="/#pricing"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white font-semibold text-sm hover:bg-accent/90 transition-colors"
                >
                  Run full scan — $99 &rarr;
                </a>
              </div>
            )}

            {/* Found errors — stronger upsell */}
            {hasErrors && !result.truncated && (
              <div className="card rounded-2xl p-6 border border-red-200 bg-red-50/30">
                <p className="font-semibold text-red-700 mb-1">Real issues found — these need fixing.</p>
                <p className="text-sm text-muted mb-4">
                  Scan + Fix ($199) opens a pull request with the fixes already written,
                  pair-reviewed by a second Claude, and regression-tested. You review the diff,
                  you click merge.
                </p>
                <a
                  href="/#pricing"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 text-white font-semibold text-sm hover:bg-red-700 transition-colors"
                >
                  Fix these issues — from $99 &rarr;
                </a>
              </div>
            )}
          </div>
        )}

        {/* Static bottom note */}
        {!result && !loading && (
          <div className="text-center text-xs text-muted">
            <p>
              Want to see what GateTest finds before scanning your own repo?{" "}
              <Link href="/scans" className="text-accent hover:underline">
                Hall of Scans &rarr;
              </Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
