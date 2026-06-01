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

interface ModuleBrief {
  name: string;
  status: string;
  issues: number;
}

interface LayerResult {
  ok: boolean;
  totalIssues: number;
  failedModules: number;
  topFindings: Finding[];
  modulesBrief?: ModuleBrief[];
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
  const [copied, setCopied] = useState<false | "markdown" | "all">(false);
  // Per-layer "show all findings" toggle. Map keyed by layer name so the
  // three cards expand independently — pressing "Show all 42" on the source
  // card shouldn't auto-expand the server card.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
      setCopied("markdown");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard write failed — long-press to copy manually.");
    }
  };

  // "Copy all findings" — flattens every layer's full findings list into a
  // plain-text block (no markdown formatting). Useful for pasting into a bug
  // tracker, Slack, or an email. Includes per-module breakdown so the
  // recipient can see all 42 issues in the source layer even when the API
  // didn't return a detail string for every one.
  const handleCopyAll = async () => {
    if (!result) return;
    const lines: string[] = [];
    lines.push(`Triage verdict: ${result.verdict.layer.toUpperCase()} (${result.verdict.confidence} confidence)`);
    lines.push(result.verdict.headline);
    lines.push("");
    lines.push(result.verdict.rationale);
    lines.push("");
    lines.push(`Recommended next: ${result.verdict.recommendedNext}`);
    lines.push("");
    lines.push("================================================================");
    for (const key of ["source", "server", "browser"] as const) {
      const layer = result.layers[key];
      lines.push("");
      lines.push(`[${key.toUpperCase()}] ${layer.ok ? "ran successfully" : `failed: ${layer.error || "unknown"}`}`);
      lines.push(`  ${layer.totalIssues} issues across ${layer.failedModules} failed modules`);
      if (layer.modulesBrief && layer.modulesBrief.length > 0) {
        lines.push(`  Module breakdown:`);
        for (const m of layer.modulesBrief) {
          lines.push(`    - ${m.name} (${m.status}): ${m.issues} issue${m.issues === 1 ? "" : "s"}`);
        }
      }
      if (layer.topFindings.length > 0) {
        lines.push(`  Findings:`);
        for (const f of layer.topFindings) {
          lines.push(`    [${f.severity}] ${f.module}: ${f.detail}`);
        }
      }
    }
    lines.push("");
    lines.push(`Triaged at ${result.triagedAt} (${(result.durationMs / 1000).toFixed(1)}s)`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied("all");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard write failed — long-press to copy manually.");
    }
  };

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <nav className="border-b border-gray-200 bg-white px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center shadow-sm">
              <span className="text-white font-bold text-base font-mono">T</span>
            </div>
            <span className="text-lg font-semibold tracking-tight text-gray-900">Triage</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/admin/pipeline-trace" className="text-sm text-emerald-700 hover:text-emerald-800 font-semibold transition-colors">
              Pipeline Trace
            </a>
            <a href="/admin" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">
              Back to admin &rarr;
            </a>
          </div>
        </div>
      </nav>

      <section className="px-4 sm:px-6 py-6 max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">Triage</h1>
          <p className="text-sm text-gray-600 mt-1">
            Paste a repo + the live URL. Find out if it&apos;s the source, the server, or the browser.
          </p>
        </header>

        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 sm:p-6 space-y-4 mb-6"
        >
          <div>
            <label htmlFor="repoUrl" className="block text-xs uppercase tracking-wider text-gray-600 font-semibold mb-1.5">
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
              className="w-full px-3 py-2 bg-white border border-gray-300 text-gray-900 placeholder:text-gray-400 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="liveUrl" className="block text-xs uppercase tracking-wider text-gray-600 font-semibold mb-1.5">
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
              className="w-full px-3 py-2 bg-white border border-gray-300 text-gray-900 placeholder:text-gray-400 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="serverUrl" className="block text-xs uppercase tracking-wider text-gray-600 font-semibold mb-1.5">
              Server URL (optional — leave blank to use live URL)
            </label>
            <input
              id="serverUrl"
              name="serverUrl"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://api.example.com"
              className="w-full px-3 py-2 bg-white border border-gray-300 text-gray-900 placeholder:text-gray-400 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !repoUrl.trim() || !liveUrl.trim()}
            className="w-full sm:w-auto px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          >
            {loading && (
              <span
                aria-hidden="true"
                className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin"
              />
            )}
            {loading ? "Triaging…" : "Run Triage"}
          </button>
        </form>

        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-6">
            {/* Verdict card */}
            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-5 sm:p-6">
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
                <span className="text-xs text-gray-400 ml-auto">
                  {(result.durationMs / 1000).toFixed(1)}s
                </span>
              </div>
              <h2 className="text-xl sm:text-2xl font-bold leading-snug mb-3 text-gray-900">
                {result.verdict.headline}
              </h2>
              <p className="text-sm text-gray-700 leading-relaxed mb-4 whitespace-pre-wrap">
                {result.verdict.rationale}
              </p>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-bold mb-1">
                  Recommended next
                </div>
                <div className="text-sm text-gray-900 leading-relaxed whitespace-pre-wrap">
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
                    className="rounded-xl border border-gray-200 bg-white shadow-sm p-4"
                  >
                    <header className="flex items-center justify-between mb-3">
                      <span className="text-xs uppercase tracking-wider font-bold text-gray-700">
                        {key}
                      </span>
                      <span
                        className={`text-xs font-semibold ${layer.ok ? "text-emerald-600" : "text-red-600"}`}
                        title={layer.error || undefined}
                      >
                        {layer.ok ? "✓ ran" : "✗ failed"}
                      </span>
                    </header>
                    {!layer.ok && layer.error && (
                      <div className="text-[11px] text-red-600 mb-2 break-words">
                        {layer.error}
                      </div>
                    )}
                    <div className="flex items-baseline gap-3 mb-3 text-xs text-gray-500">
                      <span>
                        <span className="text-gray-900 font-semibold">{layer.totalIssues}</span> issues
                      </span>
                      <span>
                        <span className="text-gray-900 font-semibold">{layer.failedModules}</span> failed modules
                      </span>
                    </div>
                    {/* Per-module breakdown — always shown when there ARE
                        failed modules. This is the answer to "what are the
                        42 issues?" when /api/scan/run can't return a detail
                        string for every single issue. */}
                    {layer.modulesBrief && layer.modulesBrief.length > 0 && (
                      <div className="mb-3">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5">
                          Module breakdown
                        </div>
                        <ul className="space-y-0.5">
                          {layer.modulesBrief.map((m, i) => (
                            <li key={i} className="flex items-baseline gap-2 text-xs">
                              <span
                                className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                                  m.status === "failed" ? "bg-red-500" : m.status === "warning" ? "bg-amber-500" : "bg-gray-300"
                                }`}
                                aria-label={m.status}
                              />
                              <span className="font-mono text-gray-700 truncate">{m.name}</span>
                              <span className="text-gray-400 ml-auto whitespace-nowrap">
                                {m.issues} issue{m.issues === 1 ? "" : "s"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {layer.topFindings.length === 0 ? (
                      (!layer.modulesBrief || layer.modulesBrief.length === 0) && (
                        <div className="text-xs text-gray-400 italic">No findings</div>
                      )
                    ) : (
                      <>
                        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5">
                          Top findings
                        </div>
                        <ul className="space-y-1.5">
                          {layer.topFindings.slice(0, expanded[key] ? layer.topFindings.length : 5).map((f, i) => (
                            <li key={i} className="flex items-start gap-2 text-xs">
                              <span
                                className={`inline-block w-2 h-2 rounded-full mt-1 shrink-0 ${SEVERITY_DOT[f.severity]}`}
                                aria-label={f.severity}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-gray-500 text-[10px] uppercase tracking-wider">
                                  {f.module}
                                </div>
                                <div className="text-gray-700 break-words">
                                  {f.detail.length > 140 ? `${f.detail.slice(0, 140)}…` : f.detail}
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                        {layer.topFindings.length > 5 && (
                          <button
                            type="button"
                            onClick={() => setExpanded((s) => ({ ...s, [key]: !s[key] }))}
                            className="mt-2 text-xs text-emerald-700 hover:text-emerald-800 font-medium"
                          >
                            {expanded[key]
                              ? `Show top 5`
                              : `Show all ${layer.topFindings.length} findings →`}
                          </button>
                        )}
                      </>
                    )}
                  </article>
                );
              })}
            </div>

            {/* Markdown summary */}
            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 sm:p-5">
              <header className="flex items-center justify-between mb-3">
                <span className="text-xs uppercase tracking-wider font-bold text-gray-700">
                  Markdown summary
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopyAll}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-semibold border border-emerald-600 transition-colors"
                    title="Copy verdict + every layer + every finding as plain text"
                  >
                    {copied === "all" ? "Copied ✓" : "Copy all findings"}
                  </button>
                  <button
                    onClick={handleCopy}
                    className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-md text-xs font-medium border border-emerald-200 transition-colors"
                    title="Copy the markdown summary only"
                  >
                    {copied === "markdown" ? "Copied ✓" : "Copy markdown"}
                  </button>
                </div>
              </header>
              <pre className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap break-words font-mono bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-96 overflow-auto">
                {result.markdown}
              </pre>
            </article>
          </div>
        )}

        <footer className="mt-12 text-xs text-gray-400 text-center">
          Triage runs all three scans (~30-60s). The verdict is heuristic — confidence reflects how
          strong the signal alignment was. Recommended next is a starting point, not a guarantee.
        </footer>
      </section>
    </main>
  );
}
