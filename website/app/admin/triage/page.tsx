"use client";

/**
 * Triage dashboard — paste a repo URL + a live website URL, get a
 * localised verdict: SOURCE, SERVER, BROWSER, BUILD, MIXED, or UNKNOWN.
 *
 * Boss-Rule respect: this surface NEVER acts on the verdict. It
 * presents heuristic findings; the operator decides next steps.
 *
 * Auth: assumes the operator has already authenticated as admin via
 * /admin. The POST will 401 otherwise — handled with a clear message.
 */

import { useState } from "react";

type Layer = "source" | "server" | "browser" | "build" | "mixed" | "unknown";
type Confidence = "high" | "medium" | "low";
type Severity = "error" | "warning" | "info";

interface Finding {
  module: string;
  severity: Severity;
  detail: string;
}

interface LayerResult {
  ok: boolean;
  totalIssues: number;
  failedModules: number;
  topFindings: Finding[];
  error?: string;
}

interface TriageResponse {
  ok: true;
  triagedAt: string;
  durationMs: number;
  inputs: { repoUrl: string; liveUrl: string; serverUrl: string };
  verdict: {
    layer: Layer;
    confidence: Confidence;
    headline: string;
    rationale: string;
    recommendedNext: string;
  };
  layers: {
    source: LayerResult;
    server: LayerResult;
    browser: LayerResult;
  };
  markdown: string;
}

const LAYER_BADGE: Record<Layer, string> = {
  source: "bg-blue-100 text-blue-800",
  server: "bg-red-100 text-red-800",
  browser: "bg-amber-100 text-amber-800",
  build: "bg-purple-100 text-purple-800",
  mixed: "bg-orange-100 text-orange-800",
  unknown: "bg-gray-100 text-gray-700",
};

const CONFIDENCE_BADGE: Record<Confidence, string> = {
  high: "bg-emerald-100 text-emerald-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-gray-100 text-gray-600",
};

const SEVERITY_DOT: Record<Severity, string> = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-gray-400",
};

export default function TriageDashboard() {
  const [repoUrl, setRepoUrl] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TriageResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const body: { repoUrl: string; liveUrl: string; serverUrl?: string } = {
        repoUrl: repoUrl.trim(),
        liveUrl: liveUrl.trim(),
      };
      if (serverUrl.trim()) body.serverUrl = serverUrl.trim();
      const res = await fetch("/api/admin/triage", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        setError("Not authenticated — log in via /admin first.");
        return;
      }
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.message || data.error || `HTTP ${res.status}`);
        return;
      }
      setResult(data as TriageResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard write failed — long-press to copy manually.");
    }
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <nav className="border-b border-white/[0.06] px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-500 flex items-center justify-center">
              <span className="text-black font-bold text-sm font-mono">T</span>
            </div>
            <span className="text-lg font-bold tracking-tight">Triage</span>
          </div>
          <a href="/admin" className="text-sm text-white/50 hover:text-white">Back to admin &rarr;</a>
        </div>
      </nav>

      <section className="px-4 sm:px-6 py-6 max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Triage</h1>
          <p className="text-sm text-white/55 mt-1">
            Paste a repo + the live URL. Find out if it&apos;s the source, the server, or the browser.
          </p>
        </header>

        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-6 space-y-4 mb-6"
        >
          <div>
            <label htmlFor="repoUrl" className="block text-xs uppercase tracking-wider text-white/55 font-semibold mb-1.5">
              Repo URL
            </label>
            <input
              id="repoUrl"
              name="repoUrl"
              type="text"
              required
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="w-full px-3 py-2 bg-white/5 border border-white/15 rounded-lg text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div>
            <label htmlFor="liveUrl" className="block text-xs uppercase tracking-wider text-white/55 font-semibold mb-1.5">
              Live website URL
            </label>
            <input
              id="liveUrl"
              name="liveUrl"
              type="text"
              required
              value={liveUrl}
              onChange={(e) => setLiveUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full px-3 py-2 bg-white/5 border border-white/15 rounded-lg text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div>
            <label htmlFor="serverUrl" className="block text-xs uppercase tracking-wider text-white/55 font-semibold mb-1.5">
              Server URL (optional — leave blank to use live URL)
            </label>
            <input
              id="serverUrl"
              name="serverUrl"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://api.example.com"
              className="w-full px-3 py-2 bg-white/5 border border-white/15 rounded-lg text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !repoUrl.trim() || !liveUrl.trim()}
            className="w-full sm:w-auto px-5 py-2.5 bg-teal-500 hover:bg-teal-400 text-black font-semibold rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          >
            {loading && (
              <span
                aria-hidden="true"
                className="inline-block w-3.5 h-3.5 border-2 border-black/30 border-t-black rounded-full animate-spin"
              />
            )}
            {loading ? "Triaging…" : "Run Triage"}
          </button>
        </form>

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-6">
            {/* Verdict card */}
            <article className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-5 sm:p-6">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <span
                  className={`inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${LAYER_BADGE[result.verdict.layer]}`}
                >
                  {result.verdict.layer}
                </span>
                <span
                  className={`inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${CONFIDENCE_BADGE[result.verdict.confidence]}`}
                >
                  {result.verdict.confidence} confidence
                </span>
                <span className="text-xs text-white/40 ml-auto">
                  {(result.durationMs / 1000).toFixed(1)}s
                </span>
              </div>
              <h2 className="text-xl sm:text-2xl font-bold leading-snug mb-3">
                {result.verdict.headline}
              </h2>
              <p className="text-sm text-white/75 leading-relaxed mb-4 whitespace-pre-wrap">
                {result.verdict.rationale}
              </p>
              <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-3">
                <div className="text-[10px] uppercase tracking-wider text-teal-300 font-bold mb-1">
                  Recommended next
                </div>
                <div className="text-sm text-white/90 leading-relaxed whitespace-pre-wrap">
                  {result.verdict.recommendedNext}
                </div>
              </div>
            </article>

            {/* Three-layer grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(["source", "server", "browser"] as const).map((key) => {
                const layer = result.layers[key];
                return (
                  <article
                    key={key}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
                  >
                    <header className="flex items-center justify-between mb-3">
                      <span className="text-xs uppercase tracking-wider font-bold text-white/70">
                        {key}
                      </span>
                      <span
                        className={`text-xs font-semibold ${layer.ok ? "text-emerald-400" : "text-red-400"}`}
                        title={layer.error || undefined}
                      >
                        {layer.ok ? "✓ ran" : "✗ failed"}
                      </span>
                    </header>
                    {!layer.ok && layer.error && (
                      <div className="text-[11px] text-red-300/80 mb-2 break-words">
                        {layer.error}
                      </div>
                    )}
                    <div className="flex items-baseline gap-3 mb-3 text-xs text-white/50">
                      <span>
                        <span className="text-white/85 font-semibold">{layer.totalIssues}</span> issues
                      </span>
                      <span>
                        <span className="text-white/85 font-semibold">{layer.failedModules}</span> failed modules
                      </span>
                    </div>
                    {layer.topFindings.length === 0 ? (
                      <div className="text-xs text-white/35 italic">No findings</div>
                    ) : (
                      <ul className="space-y-1.5">
                        {layer.topFindings.slice(0, 5).map((f, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs">
                            <span
                              className={`inline-block w-2 h-2 rounded-full mt-1 shrink-0 ${SEVERITY_DOT[f.severity]}`}
                              aria-label={f.severity}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="font-mono text-white/55 text-[10px] uppercase tracking-wider">
                                {f.module}
                              </div>
                              <div className="text-white/80 break-words">
                                {f.detail.length > 140 ? `${f.detail.slice(0, 140)}…` : f.detail}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>
                );
              })}
            </div>

            {/* Markdown summary */}
            <article className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-5">
              <header className="flex items-center justify-between mb-3">
                <span className="text-xs uppercase tracking-wider font-bold text-white/70">
                  Markdown summary
                </span>
                <button
                  onClick={handleCopy}
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/15 text-white rounded-md text-xs font-medium border border-white/15"
                >
                  {copied ? "Copied ✓" : "Copy markdown"}
                </button>
              </header>
              <pre className="text-xs text-white/80 leading-relaxed whitespace-pre-wrap break-words font-mono bg-black/40 rounded-lg p-3 max-h-96 overflow-auto">
                {result.markdown}
              </pre>
            </article>
          </div>
        )}

        <footer className="mt-12 text-xs text-white/35 text-center">
          Triage runs all three scans (~30-60s). The verdict is heuristic — confidence reflects how
          strong the signal alignment was. Recommended next is a starting point, not a guarantee.
        </footer>
      </section>
    </main>
  );
}
