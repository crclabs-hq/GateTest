"use client";

import { useState } from "react";
import Link from "next/link";
import { siteUrl, badgeUrl as badgeUrlFor } from "@/app/lib/site-url";

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
  nextStep?: { price: string; message: string };
  error?: string;
  hint?: string;
}

const SEV_TERM = {
  error:   { bg: "bg-red-500/5",   badge: "bg-red-500/10 text-red-700 border border-red-500/30",   label: "ERR" },
  warning: { bg: "bg-amber-500/5", badge: "bg-amber-500/10 text-amber-700 border border-amber-500/30", label: "WARN" },
  info:    { bg: "",               badge: "section-alt text-muted border border-border", label: "INFO" },
};

const INSTALL_CMD = "curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash";

// Terminal-style summaries and commands stay dark panels.
const PANEL = "rounded-xl bg-panel text-panel-foreground border border-panel-border overflow-hidden";
const PANEL_HEAD = "px-5 py-3 border-b border-panel-border bg-panel-alt flex items-center justify-between";
const CMD_ROW = "rounded-lg bg-panel border border-panel-border px-4 py-3 font-mono text-xs text-emerald-300 flex items-start justify-between gap-3";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button type="button" onClick={copy} className="shrink-0 text-panel-muted hover:text-panel-foreground transition-colors mt-0.5" title="Copy" aria-label="Copy">
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

interface Props {
  result: PreviewResult;
  repoUrl: string;
  onTryAnother: (url: string) => void;
  exampleRepos: { label: string; url: string; note: string }[];
}

export function PreviewResults({ result, repoUrl, onTryAnother, exampleRepos }: Props) {
  // owner/repo for the badge: from the scan result when the engine echoed
  // it, else parsed from the URL the user typed. Null → no badge block.
  const repoSlug = (() => {
    const fromResult = typeof result.repo === "string" ? result.repo.trim() : "";
    const fromUrl = (repoUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/) || []).slice(1, 3).join("/");
    const slug = /^[\w.-]+\/[\w.-]+$/.test(fromResult) ? fromResult : fromUrl;
    return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null;
  })();
  const badgeImage = repoSlug ? badgeUrlFor(`/badge/${repoSlug}.svg`) : "";
  const badgeMarkdown = repoSlug ? `[![GateTest](${badgeImage})](${siteUrl(`/score/${repoSlug}`)})` : "";
  const hasErrors = result.findings?.some((f) => f.severity === "error");
  const issueCount = result.total ?? 0;

  return (
    <div className="space-y-5">

      {/* Summary — terminal style */}
      <div className={PANEL}>
        <div className="flex items-center gap-1.5 px-4 py-3 border-b border-panel-border bg-panel-alt">
          <div className="w-3 h-3 rounded-full bg-danger/80" />
          <div className="w-3 h-3 rounded-full bg-warning/80" />
          <div className="w-3 h-3 rounded-full bg-success/80" />
          <span className="ml-3 text-xs text-panel-muted font-mono">scan complete</span>
        </div>
        <div className="p-5">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div className="min-w-0">
              <p className="font-mono text-sm font-semibold text-panel-foreground truncate">{result.repo}</p>
              <p className="text-xs text-panel-muted mt-0.5 font-mono">
                {result.durationMs != null ? `${(result.durationMs / 1000).toFixed(1)}s` : ""} · quick suite · 4 modules
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className={`text-3xl font-bold font-mono ${issueCount === 0 ? "text-emerald-400" : "text-red-400"}`}>
                {issueCount}
              </div>
              <div className="text-xs text-panel-muted">issues found</div>
            </div>
          </div>
          <div className="space-y-1.5 font-mono text-sm">
            {result.moduleSummary?.map((m) => (
              <div key={m.module} className="flex items-center gap-3">
                <span className={`shrink-0 ${m.status === "passed" ? "text-emerald-400" : m.status === "failed" ? "text-red-400" : "text-panel-muted"}`}>
                  {m.status === "passed" ? "[PASS]" : m.status === "failed" ? "[FAIL]" : "[ -- ]"}
                </span>
                <span className={`${m.status === "passed" ? "text-emerald-300/80" : m.status === "failed" ? "text-red-300/80" : "text-panel-muted"}`}>
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

      {/* Findings */}
      {(result.findings?.length ?? 0) > 0 ? (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-border section-alt flex items-center justify-between">
            <span className="text-xs font-mono text-muted">
              {result.truncated
                ? `showing top ${result.findings!.length} of ${result.total} findings`
                : `${result.findings!.length} finding${result.findings!.length !== 1 ? "s" : ""}`}
            </span>
            {result.truncated && (
              <span className="text-xs text-warning font-mono">{result.total! - result.findings!.length} more hidden</span>
            )}
          </div>
          <div className="divide-y divide-border">
            {result.findings!.map((f, i) => {
              const cfg = SEV_TERM[f.severity];
              return (
                <div key={i} className={`px-5 py-4 ${cfg.bg}`}>
                  <div className="flex items-start gap-3">
                    <span className={`shrink-0 text-[10px] font-bold font-mono px-1.5 py-0.5 rounded ${cfg.badge}`}>
                      {cfg.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="text-xs font-mono text-accent">{f.module}</span>
                        {f.file && (
                          <span className="text-xs font-mono text-muted truncate">
                            {f.file}{f.line != null ? `:${f.line}` : ""}
                          </span>
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
        <div className="rounded-xl bg-success/5 border border-success/20 p-6 text-center">
          <p className="font-mono text-success font-semibold mb-1">[PASS] all 4 modules — no issues found</p>
          <p className="text-sm text-muted mt-2">
            Quick suite covers 4 modules. Full scan ($99) runs every applicable module of the 121-module engine — security, supply chain, auth flaws, CI hardening.
          </p>
        </div>
      )}

      {/* Upsell: truncated */}
      {result.truncated && (
        <div className="card-highlight p-6">
          <p className="font-semibold text-foreground mb-1">
            {result.total! - result.findings!.length} more issue{result.total! - result.findings!.length !== 1 ? "s" : ""} not shown
          </p>
          <p className="text-sm text-muted mb-4">{result.nextStep?.message}</p>
          <div className="flex flex-wrap gap-3">
            <Link href="/#pricing" className="btn-cta inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl">
              See full results — from $29 →
            </Link>
            <Link href="/scans" className="btn-secondary inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl">
              Hall of Scans →
            </Link>
          </div>
        </div>
      )}

      {/* Upsell: all clear */}
      {!result.truncated && issueCount === 0 && (
        <div className="card p-6">
          <p className="font-semibold text-foreground mb-1">Quick scan: all clear.</p>
          <p className="text-sm text-muted mb-4">
            4 modules checked. Full scan ($99) runs every applicable module of the 121-module engine — security, supply chain, auth flaws, CI hardening.
          </p>
          <Link href="/#pricing" className="btn-cta inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl">
            Run full scan — $99 →
          </Link>
        </div>
      )}

      {/* Upsell: errors found */}
      {hasErrors && !result.truncated && (
        <div className="rounded-xl bg-danger/5 border border-danger/20 p-6">
          <p className="font-semibold text-danger mb-1">Real issues found — these need fixing.</p>
          <p className="text-sm text-muted mb-4">
            Scan + Fix ($199) opens a pull request with fixes written, pair-reviewed, and regression-tested. You review, you merge.
          </p>
          <Link href="/#pricing" className="btn-cta inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl">
            Fix these issues — from $99 →
          </Link>
        </div>
      )}

      {/* Add to CI */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border section-alt flex items-center justify-between">
          <span className="text-xs font-mono text-muted">add to your CI</span>
          <span className="text-xs text-accent font-mono">~30 seconds</span>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-foreground-secondary">
            Run this against <em>your</em> repo on every push. One curl command drops the workflow, pre-push hook, and protection marker.
          </p>
          <div className={CMD_ROW}>
            <span className="break-all">{INSTALL_CMD}</span>
            <CopyButton text={INSTALL_CMD} />
          </div>
          <p className="text-xs text-muted">
            Or install the{" "}
            <Link href="/github/setup" className="text-accent hover:underline">GitHub App</Link>
            {" "}for automatic scanning on every push and PR.
          </p>
        </div>
      </div>

      {/* Your badge — the end of the free scan is a README badge (the Fifty,
          move 36): a permanent backlink someone else maintains, and the one
          artefact of this scan that keeps working after the tab closes. */}
      {repoSlug && (
        <div className="card overflow-hidden">
          <div className={`${PANEL_HEAD} bg-transparent border-border section-alt`}>
            <span className="text-xs font-mono text-muted">your badge</span>
            <span className="text-xs text-accent font-mono">updates after every scan</span>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-sm text-foreground-secondary">
              Put <span className="font-mono text-foreground">{repoSlug}</span>&rsquo;s live GateTest grade in its README. It reads
              &ldquo;not scanned&rdquo; until a full scan is on record, then shows the grade and issue count.
            </p>
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- SVG from our own badge origin */}
              <img src={badgeImage} alt={`GateTest badge for ${repoSlug}`} height={20} />
            </div>
            <div className={CMD_ROW}>
              <span className="break-all">{badgeMarkdown}</span>
              <CopyButton text={badgeMarkdown} />
            </div>
            <p className="text-xs text-muted">
              Markdown shown; HTML and reStructuredText embeds are on the{" "}
              <Link href="/badge" className="text-accent hover:underline">badge page</Link>.
            </p>
          </div>
        </div>
      )}

      {/* Try another */}
      <div className="pt-2">
        <p className="text-xs text-muted uppercase tracking-wider font-medium mb-3">Try another</p>
        <div className="flex flex-wrap gap-2">
          {exampleRepos.filter((ex) => !repoUrl.includes(ex.label)).map((ex) => (
            <button
              key={ex.url}
              type="button"
              onClick={() => onTryAnother(ex.url)}
              className="text-xs font-mono px-3 py-1.5 rounded-lg bg-[var(--surface-solid)] border border-border text-foreground-secondary hover:text-foreground hover:border-accent/50 transition-all"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
