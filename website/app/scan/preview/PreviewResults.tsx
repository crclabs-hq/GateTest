"use client";

import { useState } from "react";
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
  nextStep?: { price: string; message: string };
  error?: string;
  hint?: string;
}

const SEV_TERM = {
  error:   { bg: "bg-red-950/60",   badge: "bg-red-500/20 text-red-400 border border-red-500/30",   label: "ERR" },
  warning: { bg: "bg-amber-950/40", badge: "bg-amber-500/20 text-amber-400 border border-amber-500/30", label: "WARN" },
  info:    { bg: "bg-slate-900/60", badge: "bg-slate-600/30 text-slate-400 border border-slate-600/30", label: "INFO" },
};

const INSTALL_CMD = "curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button type="button" onClick={copy} className="shrink-0 text-white/30 hover:text-white transition-colors mt-0.5" title="Copy">
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
  const hasErrors = result.findings?.some((f) => f.severity === "error");
  const issueCount = result.total ?? 0;

  return (
    <div className="space-y-5">

      {/* Summary — terminal style */}
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
          <div className="space-y-1.5 font-mono text-sm">
            {result.moduleSummary?.map((m) => (
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

      {/* Findings */}
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
            Quick suite covers 4 modules. Full scan ($99) runs all 110 — security, supply chain, auth flaws, CI hardening.
          </p>
        </div>
      )}

      {/* Upsell: truncated */}
      {result.truncated && (
        <div className="rounded-xl bg-white/[0.03] border border-teal-500/20 p-6">
          <p className="font-semibold text-white mb-1">
            {result.total! - result.findings!.length} more issue{result.total! - result.findings!.length !== 1 ? "s" : ""} not shown
          </p>
          <p className="text-sm text-white/50 mb-4">{result.nextStep?.message}</p>
          <div className="flex flex-wrap gap-3">
            <Link href="/#pricing" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal-600 text-white font-semibold text-sm hover:bg-teal-500 transition-colors">
              See full results — from $29 →
            </Link>
            <Link href="/scans" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-white/10 text-white/70 font-semibold text-sm hover:bg-white/[0.04] transition-colors">
              Hall of Scans →
            </Link>
          </div>
        </div>
      )}

      {/* Upsell: all clear */}
      {!result.truncated && issueCount === 0 && (
        <div className="rounded-xl bg-white/[0.03] border border-white/10 p-6">
          <p className="font-semibold text-white mb-1">Quick scan: all clear.</p>
          <p className="text-sm text-white/50 mb-4">
            4 modules checked. Full scan ($99) runs all 110 — security, supply chain, auth flaws, CI hardening.
          </p>
          <Link href="/#pricing" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal-600 text-white font-semibold text-sm hover:bg-teal-500 transition-colors">
            Run full scan — $99 →
          </Link>
        </div>
      )}

      {/* Upsell: errors found */}
      {hasErrors && !result.truncated && (
        <div className="rounded-xl bg-red-950/30 border border-red-500/20 p-6">
          <p className="font-semibold text-red-400 mb-1">Real issues found — these need fixing.</p>
          <p className="text-sm text-white/50 mb-4">
            Scan + Fix ($199) opens a pull request with fixes written, pair-reviewed, and regression-tested. You review, you merge.
          </p>
          <Link href="/#pricing" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 text-white font-semibold text-sm hover:bg-red-700 transition-colors">
            Fix these issues — from $99 →
          </Link>
        </div>
      )}

      {/* Add to CI */}
      <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden">
        <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
          <span className="text-xs font-mono text-white/50">add to your CI</span>
          <span className="text-xs text-teal-400/80 font-mono">~30 seconds</span>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-white/60">
            Run this against <em>your</em> repo on every push. One curl command drops the workflow, pre-push hook, and protection marker.
          </p>
          <div className="rounded-lg bg-black/40 border border-white/[0.06] px-4 py-3 font-mono text-xs text-emerald-300 flex items-start justify-between gap-3">
            <span className="break-all">{INSTALL_CMD}</span>
            <CopyButton text={INSTALL_CMD} />
          </div>
          <p className="text-xs text-white/30">
            Or install the{" "}
            <Link href="/github/setup" className="text-teal-400 hover:underline">GitHub App</Link>
            {" "}for automatic scanning on every push and PR.
          </p>
        </div>
      </div>

      {/* Try another */}
      <div className="pt-2">
        <p className="text-xs text-white/30 uppercase tracking-wider font-medium mb-3">Try another</p>
        <div className="flex flex-wrap gap-2">
          {exampleRepos.filter((ex) => !repoUrl.includes(ex.label)).map((ex) => (
            <button
              key={ex.url}
              type="button"
              onClick={() => onTryAnother(ex.url)}
              className="text-xs font-mono px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/60 hover:text-white hover:border-teal-500/40 transition-all"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
