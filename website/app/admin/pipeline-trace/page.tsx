"use client";

// Pipeline Trace — paste a repo URL + a live URL and find out where in the
// deploy chain the latest update is stuck. Probes 4 stages in parallel.
// Auth: operator must be logged in via /admin (POST 401s otherwise).
import { useState } from "react";

type Layer =
  | "source"
  | "ci"
  | "deploy"
  | "live"
  | "edge"
  | "synced"
  | "unknown";
type Confidence = "high" | "medium" | "low";
type StageName = "source" | "ci" | "deploy" | "live";
type StageStatus = "in-sync" | "ahead" | "behind" | "unknown";
type DivergencePoint =
  | "ci-not-built"
  | "ci-failed"
  | "deploy-behind"
  | "deploy-failed"
  | "live-stale"
  | "edge-cache"
  | "in-sync"
  | "no-signal";

interface StageState {
  ok: boolean;
  sha: string | null;
  shortSha: string | null;
  timestamp: string | null;
  ageMinutes: number | null;
  conclusion?: string | null;
  state?: string | null;
  url?: string | null;
  details?: string[];
  error?: string;
}

interface Stage {
  name: StageName;
  state: StageState;
  status: StageStatus;
  comparedTo?: "source" | "ci" | "deploy";
}

interface CommitDelta {
  behind: number;
  commits: Array<{ sha: string; message: string; author?: string }>;
}

interface TraceResponse {
  ok: true;
  tracedAt: string;
  durationMs: number;
  inputs: { repoUrl: string; liveUrl: string };
  verdict: {
    layer: Layer;
    confidence: Confidence;
    headline: string;
    rationale: string;
    recommendedNext: string;
    divergencePoint: DivergencePoint;
  };
  stages: Stage[];
  commitDelta: CommitDelta | null;
  markdown: string;
}

const LAYER_BADGE: Record<Layer, string> = {
  source: "bg-blue-100 text-blue-800",
  ci: "bg-purple-100 text-purple-800",
  deploy: "bg-orange-100 text-orange-800",
  live: "bg-amber-100 text-amber-800",
  edge: "bg-pink-100 text-pink-800",
  synced: "bg-emerald-100 text-emerald-800",
  unknown: "bg-gray-100 text-gray-700",
};

const CONFIDENCE_BADGE: Record<Confidence, string> = {
  high: "bg-emerald-100 text-emerald-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-gray-100 text-gray-600",
};

const STATUS_DOT: Record<StageStatus, string> = {
  "in-sync": "bg-emerald-500",
  ahead: "bg-purple-500",
  behind: "bg-red-500",
  unknown: "bg-gray-400",
};

const STATUS_GLYPH: Record<StageStatus, string> = {
  "in-sync": "✓",
  ahead: "↑",
  behind: "↓",
  unknown: "?",
};

const STATUS_TEXT: Record<StageStatus, string> = {
  "in-sync": "text-emerald-700",
  ahead: "text-purple-700",
  behind: "text-red-700",
  unknown: "text-gray-500",
};

const DIVERGENCE_LABEL: Record<DivergencePoint, string> = {
  "ci-not-built": "CI not built",
  "ci-failed": "CI failed",
  "deploy-behind": "Deploy behind",
  "deploy-failed": "Deploy failed",
  "live-stale": "Live stale",
  "edge-cache": "Edge cache",
  "in-sync": "In sync",
  "no-signal": "No signal",
};

const STAGE_ORDER: StageName[] = ["source", "ci", "deploy", "live"];

function GapArrow({ a, b }: { a: Stage | undefined; b: Stage | undefined }) {
  let colour = "text-gray-400";
  let label = "unknown";
  if (a && b) {
    const sameSha = a.state.sha && b.state.sha && a.state.sha === b.state.sha;
    if (sameSha) { colour = "text-emerald-600"; label = "in sync"; }
    else if (a.state.sha && b.state.sha) { colour = "text-red-600"; label = `${b.name} on older SHA`; }
  }
  return (
    <div className={`flex md:flex-col items-center justify-center text-center ${colour} px-1 md:px-0 py-2 md:py-0`}>
      <span className="text-2xl font-bold md:rotate-90 md:my-1" aria-hidden="true">→</span>
      <span className="text-[10px] uppercase tracking-wider font-semibold whitespace-nowrap ml-2 md:ml-0">{label}</span>
    </div>
  );
}

function StageBox({ stage }: { stage: Stage }) {
  return (
    <div className="flex-1 rounded-lg border border-gray-200 bg-gray-50 p-3 sm:p-4 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider font-bold text-gray-700">{stage.name}</span>
        <span
          className={`inline-flex items-center gap-1 text-xs font-semibold ${STATUS_TEXT[stage.status]}`}
          title={stage.comparedTo ? `compared to ${stage.comparedTo}` : undefined}
        >
          <span className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT[stage.status]}`} aria-label={stage.status} />
          <span>{STATUS_GLYPH[stage.status]}</span>
          <span>{stage.status}</span>
        </span>
      </div>
      {!stage.state.ok && stage.state.error && (
        <div className="text-[11px] text-red-600 mb-2 break-words">{stage.state.error}</div>
      )}
      <div className="space-y-1 text-xs">
        <div className="flex items-baseline gap-2">
          <span className="text-gray-500">sha</span>
          <span className="font-mono text-gray-900">{stage.state.shortSha || (stage.state.sha ? stage.state.sha.slice(0, 7) : "—")}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-gray-500">age</span>
          <span className="text-gray-900">{humanAge(stage.state.ageMinutes)}</span>
        </div>
        {stage.name === "ci" && stage.state.conclusion && (
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500">conclusion</span>
            <span className={`font-semibold ${conclusionClass(stage.state.conclusion)}`}>{stage.state.conclusion}</span>
          </div>
        )}
        {stage.name === "deploy" && stage.state.state && (
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500">state</span>
            <span className={`font-semibold ${conclusionClass(stage.state.state)}`}>{stage.state.state}</span>
          </div>
        )}
        {stage.name === "live" && stage.state.details && stage.state.details.length > 0 && (
          <ul className="space-y-0.5 mt-1">
            {stage.state.details.slice(0, 3).map((d, i) => (
              <li key={i} className="text-[11px] text-gray-600 break-words font-mono">{d.length > 60 ? `${d.slice(0, 60)}…` : d}</li>
            ))}
          </ul>
        )}
      </div>
      {stage.state.url && (
        <a href={stage.state.url} target="_blank" rel="noopener noreferrer"
          className="mt-3 inline-block text-xs text-emerald-700 hover:text-emerald-800 font-semibold">
          View &rarr;
        </a>
      )}
    </div>
  );
}

// Human-readable age. null → em-dash; <1 → "just now"; minutes / hours / days.
function humanAge(minutes: number | null): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) {
    return "—";
  }
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hr`;
  return `${Math.round(minutes / 1440)} days`;
}

// Colour-class the CI conclusion / deploy state strings (same palette as status dots).
function conclusionClass(value: string | null | undefined): string {
  if (!value) return "text-gray-500";
  const v = String(value).toLowerCase();
  if (v === "success" || v === "succeeded") return "text-emerald-700";
  if (
    v === "failure" ||
    v === "failed" ||
    v === "error" ||
    v === "cancelled" ||
    v === "timed_out"
  ) {
    return "text-red-700";
  }
  if (v === "in_progress" || v === "pending" || v === "queued" || v === "running") {
    return "text-amber-700";
  }
  return "text-gray-700";
}

export default function PipelineTracePage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TraceResponse | null>(null);
  const [copied, setCopied] = useState<false | "markdown" | "all">(false);
  // Per-stage details accordion, keyed by stage name.
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const body = {
        repoUrl: repoUrl.trim(),
        liveUrl: liveUrl.trim(),
      };
      const res = await fetch("/api/admin/triage/pipeline", {
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
      setResult(data as TraceResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyMarkdown = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.markdown);
      setCopied("markdown");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard write failed — long-press to copy manually.");
    }
  };

  // "Copy all" — flattens verdict + every stage + details into plain text.
  const handleCopyAll = async () => {
    if (!result) return;
    const lines: string[] = [];
    lines.push(
      `Pipeline trace verdict: ${result.verdict.layer.toUpperCase()} (${result.verdict.confidence} confidence)`,
    );
    lines.push(`Divergence: ${DIVERGENCE_LABEL[result.verdict.divergencePoint]}`);
    lines.push(result.verdict.headline);
    lines.push("");
    lines.push(result.verdict.rationale);
    lines.push("");
    lines.push(`Recommended next: ${result.verdict.recommendedNext}`);
    lines.push("");
    lines.push("================================================================");
    for (const stage of result.stages) {
      lines.push("");
      lines.push(`[${stage.name.toUpperCase()}] status=${stage.status}${stage.comparedTo ? ` (vs ${stage.comparedTo})` : ""}`);
      if (!stage.state.ok && stage.state.error) {
        lines.push(`  error: ${stage.state.error}`);
      }
      lines.push(`  sha: ${stage.state.shortSha || stage.state.sha || "—"}`);
      lines.push(`  age: ${humanAge(stage.state.ageMinutes)}`);
      if (stage.state.timestamp) {
        lines.push(`  timestamp: ${stage.state.timestamp}`);
      }
      if (stage.state.conclusion) {
        lines.push(`  conclusion: ${stage.state.conclusion}`);
      }
      if (stage.state.state) {
        lines.push(`  state: ${stage.state.state}`);
      }
      if (stage.state.url) {
        lines.push(`  url: ${stage.state.url}`);
      }
      if (stage.state.details && stage.state.details.length > 0) {
        lines.push(`  details:`);
        for (const d of stage.state.details) {
          lines.push(`    - ${d}`);
        }
      }
    }
    lines.push("");
    if (result.commitDelta && result.commitDelta.behind > 0) {
      lines.push(`COMMIT DELTA: ${result.commitDelta.behind} commit(s) stuck in pipeline`);
      for (const c of result.commitDelta.commits) {
        lines.push(`  [${c.sha}] ${c.message}${c.author ? ` — ${c.author}` : ""}`);
      }
      lines.push("");
    }
    lines.push(`Traced at ${result.tracedAt} (${(result.durationMs / 1000).toFixed(1)}s)`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied("all");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard write failed — long-press to copy manually.");
    }
  };

  // Order stages by canonical pipeline order (orchestrator may be unordered).
  const orderedStages: Stage[] = result
    ? STAGE_ORDER.map((name) => result.stages.find((s) => s.name === name)).filter(
        (s): s is Stage => Boolean(s),
      )
    : [];

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <nav className="border-b border-gray-200 bg-white px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center shadow-sm">
              <span className="text-white font-bold text-base font-mono">P</span>
            </div>
            <span className="text-lg font-semibold tracking-tight text-gray-900">Pipeline Trace</span>
          </div>
          <a href="/admin" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">
            Back to admin &rarr;
          </a>
        </div>
      </nav>

      <section className="px-4 sm:px-6 py-6 max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">Pipeline Trace</h1>
          <p className="text-sm text-gray-600 mt-1 leading-relaxed">
            Trace the deploy pipeline. Paste a repo + the live URL. We&apos;ll check what&apos;s on the default
            branch, what CI did with it, what last deployed, and what the live URL is actually
            serving — then tell you where the chain diverged.
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
              Live URL
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
            {loading ? "Tracing…" : "Trace pipeline"}
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
                <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider bg-gray-100 text-gray-700">
                  {DIVERGENCE_LABEL[result.verdict.divergencePoint]}
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
                <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-bold mb-1">Recommended next</div>
                <div className="text-sm text-gray-900 leading-relaxed whitespace-pre-wrap">
                  {result.verdict.recommendedNext}
                </div>
              </div>
            </article>

            {/* Pipeline visualisation — horizontal on md+, vertical on mobile */}
            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 sm:p-6">
              <header className="mb-4">
                <span className="text-xs uppercase tracking-wider font-bold text-gray-700">Pipeline flow</span>
              </header>
              <div className="flex flex-col md:flex-row md:items-stretch md:gap-0 gap-0">
                {orderedStages.map((stage, idx) => {
                  const isLast = idx === orderedStages.length - 1;
                  const next = orderedStages[idx + 1];
                  return (
                    <div key={stage.name} className="flex flex-col md:flex-row md:flex-1 md:items-stretch">
                      <StageBox stage={stage} />
                      {!isLast && <GapArrow a={stage} b={next} />}
                    </div>
                  );
                })}
              </div>
            </article>

            {/* Commit delta — shows commits stuck between deploy and source */}
            {result.commitDelta && result.commitDelta.behind > 0 && (
              <article className="rounded-xl border border-amber-200 bg-amber-50 shadow-sm p-4 sm:p-5">
                <header className="flex items-center gap-2 mb-3">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                  <span className="text-xs uppercase tracking-wider font-bold text-amber-800">
                    {result.commitDelta.behind} commit{result.commitDelta.behind !== 1 ? "s" : ""} stuck in pipeline
                  </span>
                </header>
                <p className="text-xs text-amber-700 mb-3 leading-relaxed">
                  These commits are on the source branch but have not yet reached the deployed version.
                </p>
                <ul className="space-y-1.5">
                  {result.commitDelta.commits.map((c) => (
                    <li key={c.sha} className="flex items-start gap-2 text-xs">
                      <span className="font-mono text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded text-[11px] shrink-0">{c.sha}</span>
                      <span className="text-gray-800 break-words">{c.message}</span>
                      {c.author && <span className="text-gray-400 shrink-0 hidden sm:inline">— {c.author}</span>}
                    </li>
                  ))}
                </ul>
              </article>
            )}

            {/* Per-stage details accordion */}
            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 sm:p-5">
              <header className="mb-3">
                <span className="text-xs uppercase tracking-wider font-bold text-gray-700">Per-stage details</span>
              </header>
              <div className="divide-y divide-gray-100">
                {orderedStages.map((stage) => {
                  const isOpen = Boolean(expandedDetails[stage.name]);
                  const hasDetails = stage.state.details && stage.state.details.length > 0;
                  return (
                    <div key={stage.name} className="py-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedDetails((s) => ({ ...s, [stage.name]: !s[stage.name] }))
                        }
                        className="w-full flex items-center justify-between text-left text-sm hover:bg-gray-50 rounded px-2 py-1.5 transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wider font-bold text-gray-700 w-16">
                            {stage.name}
                          </span>
                          <span className={`text-xs font-semibold ${STATUS_TEXT[stage.status]}`}>
                            {STATUS_GLYPH[stage.status]} {stage.status}
                          </span>
                          {!hasDetails && (
                            <span className="text-[11px] text-gray-400 italic ml-2">no details</span>
                          )}
                        </span>
                        <span className="text-xs text-gray-400">{isOpen ? "−" : "+"}</span>
                      </button>
                      {isOpen && (
                        <div className="px-2 pb-2 pt-1">
                          {hasDetails ? (
                            <ul className="space-y-1">
                              {stage.state.details!.map((d, i) => (
                                <li key={i} className="text-xs text-gray-700 font-mono break-words">
                                  {d}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="text-xs text-gray-400 italic">No additional details for this stage.</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </article>

            {/* Markdown summary + copy buttons */}
            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 sm:p-5">
              <header className="flex items-center justify-between mb-3">
                <span className="text-xs uppercase tracking-wider font-bold text-gray-700">Markdown summary</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopyAll}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-semibold border border-emerald-600 transition-colors"
                    title="Copy verdict + every stage + every stage's details as plain text"
                  >
                    {copied === "all" ? "Copied ✓" : "Copy all"}
                  </button>
                  <button
                    onClick={handleCopyMarkdown}
                    className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-md text-xs font-medium border border-emerald-200 transition-colors"
                    title="Copy the markdown summary verbatim"
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

        <footer className="mt-12 text-xs text-gray-400 text-center leading-relaxed">
          Pipeline trace reads GitHub&apos;s branch/runs/deployments APIs and probes the live URL
          directly. It can&apos;t see inside the host (Vercel/Netlify build logs require host-level
          auth). The &lsquo;deploy&rsquo; stage uses GitHub Deployments — Vercel and similar hosts
          register there.
        </footer>
      </section>
    </main>
  );
}
