"use client";

import React, { useState, FormEvent, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PreviewResults } from "./PreviewResults";

interface PreviewResult {
  ok: boolean;
  repo?: string;
  durationMs?: number;
  findings?: { module: string; severity: "error" | "warning" | "info"; file: string | null; line: number | null; message: string }[];
  moduleSummary?: { module: string; status: string; issues: number }[];
  total?: number;
  truncated?: boolean;
  nextStep?: { price: string; message: string };
  error?: string;
  hint?: string;
}

const EXAMPLE_REPOS = [
  { label: "vercel/next.js",      url: "https://github.com/vercel/next.js",      note: "React framework" },
  { label: "expressjs/express",   url: "https://github.com/expressjs/express",   note: "Node.js server" },
  { label: "supabase/supabase",   url: "https://github.com/supabase/supabase",   note: "Open-source Firebase" },
  { label: "crclabs-hq/gatetest", url: "https://github.com/crclabs-hq/gatetest", note: "GateTest itself" },
];

const QUICK_MODULES = ["syntax", "lint", "secrets", "codeQuality"];

async function fetchPreview(repoUrl: string): Promise<PreviewResult> {
  const res = await fetch("/api/scan/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });
  return res.json() as Promise<PreviewResult>;
}

function PreviewPageContent() {
  const searchParams = useSearchParams();
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState("");
  const [activeModule, setActiveModule] = useState(-1);
  const [doneModules, setDoneModules] = useState<string[]>([]);
  const autoStarted = useRef(false);

  async function runScan(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setResult(null);
    setError("");
    setActiveModule(0);
    setDoneModules([]);

    let idx = 0;
    const tick = setInterval(() => {
      if (idx < QUICK_MODULES.length - 1) {
        setDoneModules((d) => [...d, QUICK_MODULES[idx]]);
        idx++;
        setActiveModule(idx);
      }
    }, 3000);

    try {
      const data = await fetchPreview(trimmed);
      if (!data.ok) {
        setError(data.hint || data.error || "Preview scan failed");
      } else {
        setResult(data);
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

  // Auto-start when ?repo= is present — runs once on mount only
  useEffect(() => {
    if (autoStarted.current) return;
    const repoParam = searchParams.get("repo");
    if (!repoParam) return;
    autoStarted.current = true;
    setRepoUrl(repoParam);
    runScan(repoParam);
  }, [searchParams]); // runScan is defined above; searchParams is stable from Next.js

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await runScan(repoUrl);
  }

  function tryExample(url: string) {
    setRepoUrl(url);
    runScan(url);
  }

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

        {/* Example repo chips */}
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-white/40 group-hover:text-teal-400 transition-colors shrink-0" aria-hidden="true">
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

        {/* Terminal progress */}
        {loading && (
          <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden mb-8">
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
              <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-xs text-white/30 font-mono">
                gatetest --suite quick {repoUrl.replace("https://github.com/", "")}
              </span>
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

        {/* Error */}
        {error && (
          <div className="rounded-xl bg-amber-950/30 border border-amber-500/20 p-5 mb-8">
            <p className="text-sm font-semibold text-amber-400 mb-1">Scan failed</p>
            <p className="text-sm text-amber-500/80">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <PreviewResults
            result={result}
            repoUrl={repoUrl}
            onTryAnother={tryExample}
            exampleRepos={EXAMPLE_REPOS}
          />
        )}

        {/* Idle note */}
        {!result && !loading && (
          <div className="text-center">
            <p className="text-xs text-white/30">
              See what GateTest found in real codebases →{" "}
              <Link href="/scans" className="text-teal-400 hover:underline">Hall of Scans</Link>
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
