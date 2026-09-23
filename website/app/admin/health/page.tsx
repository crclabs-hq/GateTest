"use client";

import { useState } from "react";

interface Check {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "pending";
  detail?: string;
  duration?: number;
}

interface HealthReport {
  ready: boolean;
  summary: { ok: number; warn: number; fail: number; total: number };
  checks: Check[];
  duration: number;
  fingerprint: string;
  generated_at: string;
}

const EXPECTED: Array<{ id: string; label: string }> = [
  { id: "env", label: "Environment variables" },
  { id: "db", label: "Database (Neon Postgres)" },
  { id: "github", label: "Git host auth" },
  { id: "stripe", label: "Stripe API" },
  { id: "anthropic", label: "Anthropic API (Claude)" },
  { id: "modules", label: "Scan modules" },
  { id: "scan", label: "Live scan (in-memory test)" },
  { id: "auth", label: "Auth providers" },
];

/** Actionable suggestions for known failure patterns. */
const SUGGESTIONS: Record<string, Record<string, string>> = {
  env: {
    fail: "Set the missing environment variables in Tallrig → Platform secrets, then Apply to live app and restart gatetest-web. Required: STRIPE_SECRET_KEY, NEXT_PUBLIC_BASE_URL, DATABASE_URL, SESSION_SECRET.",
    warn: "Optional variables improve functionality. Set GLUECRON_BASE_URL + GLUECRON_API_TOKEN for git host access. Set ANTHROPIC_API_KEY for AI review.",
  },
  db: {
    fail: "Check DATABASE_URL in Tallrig → Platform secrets. If the database exists but tables are missing, visit /api/db/init to create them.",
    warn: "Database connected but some tables missing. POST to /api/db/init to create the required tables (scans, customers, api_keys, api_calls, installations, scan_queue).",
  },
  github: {
    fail: "Git host auth failed. Verify GLUECRON_BASE_URL and GLUECRON_API_TOKEN are set correctly, or check GATETEST_APP_ID + GATETEST_PRIVATE_KEY for GitHub fallback.",
    warn: "Git host not configured. Set GLUECRON_BASE_URL + GLUECRON_API_TOKEN for Gluecron, or GATETEST_APP_ID + GATETEST_PRIVATE_KEY for GitHub.",
  },
  stripe: {
    fail: "Stripe API rejected the key. Check STRIPE_SECRET_KEY in Tallrig → Platform secrets. Test keys start with sk_test_, live keys with sk_live_. Currently pre-launch: use sk_test_ until ready.",
    warn: "Stripe not configured. Set STRIPE_SECRET_KEY to enable paid scans.",
  },
  anthropic: {
    fail: "Claude API rejected the request. Check ANTHROPIC_API_KEY in Tallrig → Platform secrets. Get one at console.anthropic.com.",
    warn: "Anthropic not configured. AI code review will skip gracefully but won't find real bugs. Set ANTHROPIC_API_KEY when ready.",
  },
  modules: {
    fail: "Some scan modules failed to load. Run `node bin/gatetest.js --list` locally to see which module crashes and why.",
  },
  scan: {
    fail: "The in-memory test scan crashed. This means the scan engine has a bug. Run locally to debug.",
    warn: "Scan ran but some modules crashed internally. Check the module list for details.",
  },
  auth: {
    fail: "Auth system is misconfigured. Check admin password or OAuth credentials.",
    warn: "Some auth providers not configured. Set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET for customer OAuth, or GATETEST_ADMIN_PASSWORD for password admin.",
  },
};

function getSuggestion(check: Check): string | null {
  const map = SUGGESTIONS[check.id];
  if (!map) return null;
  return map[check.status] || null;
}

function formatCheckForCopy(check: Check): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _icon = check.status === "ok" ? "✅" : check.status === "warn" ? "⚠️" : check.status === "fail" ? "❌" : "⏳";
  const suggestion = getSuggestion(check);
  let text = `[${check.status.toUpperCase()}] ${check.label}`;
  if (check.detail) text += `\nDetail: ${check.detail}`;
  if (suggestion) text += `\nSuggestion: ${suggestion}`;
  if (typeof check.duration === "number") text += `\nDuration: ${check.duration}ms`;
  return text;
}

function formatFullReport(report: HealthReport): string {
  const lines: string[] = [];
  lines.push("# GateTest Health Check Report");
  lines.push(`Generated: ${new Date(report.generated_at).toLocaleString()}`);
  lines.push(`Total time: ${report.duration}ms | Fingerprint: ${report.fingerprint}`);
  lines.push("");
  lines.push(`## Summary: ${report.summary.ok} passed · ${report.summary.warn} warnings · ${report.summary.fail} failures`);
  lines.push("");

  const passed = report.checks.filter((c) => c.status === "ok");
  const warnings = report.checks.filter((c) => c.status === "warn");
  const failures = report.checks.filter((c) => c.status === "fail");

  if (failures.length > 0) {
    lines.push("## ❌ Failures");
    for (const c of failures) {
      lines.push(`- **${c.label}**: ${c.detail || "No detail"}`);
      const s = getSuggestion(c);
      if (s) lines.push(`  - 💡 Fix: ${s}`);
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("## ⚠️ Warnings");
    for (const c of warnings) {
      lines.push(`- **${c.label}**: ${c.detail || "No detail"}`);
      const s = getSuggestion(c);
      if (s) lines.push(`  - 💡 Fix: ${s}`);
    }
    lines.push("");
  }

  if (passed.length > 0) {
    lines.push("## ✅ Passed");
    for (const c of passed) {
      lines.push(`- ${c.label}: ${c.detail || "OK"}${typeof c.duration === "number" ? ` (${c.duration}ms)` : ""}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("Paste this into Claude Code or your issue tracker for diagnosis.");
  return lines.join("\n");
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / non-HTTPS
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      return true;
    } catch {
      return false;
    }
  }
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button
      onClick={handleCopy}
      title={label || "Copy to clipboard"}
      className="px-2 py-1 text-xs rounded-md border border-border hover:bg-slate-100 transition-colors shrink-0"
    >
      {copied ? "Copied!" : "📋 Copy"}
    </button>
  );
}

export default function HealthPage() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  function toggleExpand(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function runSelfTest() {
    setRunning(true);
    setError("");
    setReport(null);
    setExpanded({});
    try {
      const res = await fetch("/api/admin/health", { cache: "no-store" });
      if (!res.ok) {
        const text = await res.text();
        setError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        return;
      }
      const data = (await res.json()) as HealthReport;
      setReport(data);
      // Auto-expand failures and warnings so Craig sees them immediately
      const autoExpand: Record<string, boolean> = {};
      for (const c of data.checks) {
        if (c.status === "fail" || c.status === "warn") {
          autoExpand[c.id] = true;
        }
      }
      setExpanded(autoExpand);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Self-test failed");
    } finally {
      setRunning(false);
    }
  }

  // Merge running skeleton with real results so the list is stable order.
  const displayChecks: Check[] = EXPECTED.map((e) => {
    const real = report?.checks.find((c) => c.id === e.id);
    if (real) return real;
    return { id: e.id, label: e.label, status: running ? "pending" as const : "pending" as const };
  });

  const allGreen = report?.ready === true && report.summary.warn === 0;
  const ready = report?.ready === true;

  return (
    <div className="gt-admin-page">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="mb-8">
          <p className="text-xs font-mono uppercase tracking-wider text-accent mb-2">
            System Self-Test
          </p>
          <h1 className="text-3xl font-bold mb-2">End-to-End Health Check</h1>
          <p className="text-muted text-sm">
            Every subsystem, verified live. No fake-pass. Tap any item to expand details. Copy anything.
          </p>
        </div>

        {/* The big button */}
        <div className="mb-8">
          <button
            onClick={runSelfTest}
            disabled={running}
            className={`w-full py-6 rounded-2xl text-lg font-bold transition-all shadow-lg disabled:opacity-60 ${
              allGreen
                ? "bg-gradient-to-r from-green-500 to-emerald-600 text-white shadow-green-500/30"
                : ready
                ? "bg-gradient-to-r from-green-500 to-teal-500 text-white shadow-green-500/25"
                : report && report.summary.fail > 0
                ? "bg-gradient-to-r from-amber-500 to-red-500 text-white shadow-amber-500/25"
                : "bg-gradient-to-r from-green-500 to-emerald-600 text-white shadow-green-500/25 hover:shadow-green-500/40"
            }`}
          >
            <div className="flex items-center justify-center gap-3">
              {running ? (
                <>
                  <span className="w-5 h-5 border-2 border-white/80 border-t-transparent rounded-full animate-spin" />
                  <span>Running preflight…</span>
                </>
              ) : allGreen ? (
                <>
                  <span className="text-2xl">✓</span>
                  <span>All Systems Go — Click to Re-run</span>
                </>
              ) : ready ? (
                <>
                  <span className="text-2xl">✓</span>
                  <span>Ready with Warnings — Click to Re-run</span>
                </>
              ) : report && report.summary.fail > 0 ? (
                <>
                  <span className="text-2xl">!</span>
                  <span>{report.summary.fail} Failure{report.summary.fail > 1 ? "s" : ""} — Click to Re-run</span>
                </>
              ) : (
                <>
                  <span className="text-2xl">▶</span>
                  <span>Run Full Self-Test</span>
                </>
              )}
            </div>
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="card p-4 mb-6 border-l-4 border-l-red-500 bg-red-50/50">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-red-700">Self-test error</p>
                <p className="text-xs text-red-600 font-mono mt-1">{error}</p>
              </div>
              <CopyButton text={error} label="Copy error" />
            </div>
          </div>
        )}

        {/* Copy Full Report button */}
        {report && (
          <div className="flex items-center justify-between mb-6">
            <div className="grid grid-cols-4 gap-3 flex-1 mr-4">
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-foreground">{report.summary.total}</p>
                <p className="text-xs text-muted mt-1">Checks</p>
              </div>
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-green-600">{report.summary.ok}</p>
                <p className="text-xs text-muted mt-1">OK</p>
              </div>
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-amber-600">{report.summary.warn}</p>
                <p className="text-xs text-muted mt-1">Warn</p>
              </div>
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-red-600">{report.summary.fail}</p>
                <p className="text-xs text-muted mt-1">Fail</p>
              </div>
            </div>
            <CopyButton
              text={formatFullReport(report)}
              label="Copy full report as markdown — paste into Claude Code for diagnosis"
            />
          </div>
        )}

        {/* Checklist — now expandable + copyable */}
        <div className="space-y-2 mb-8">
          {displayChecks.map((c, i) => {
            const isExpanded = expanded[c.id] ?? false;
            const suggestion = getSuggestion(c);
            const hasDetail = c.detail || suggestion;

            const statusColor =
              c.status === "ok"
                ? "bg-green-50 border-green-200"
                : c.status === "warn"
                ? "bg-amber-50 border-amber-200"
                : c.status === "fail"
                ? "bg-red-50 border-red-200"
                : running
                ? "bg-slate-50 border-slate-200 opacity-80"
                : "bg-white border-border opacity-50";

            const iconBg =
              c.status === "ok"
                ? "bg-green-100 text-green-600"
                : c.status === "warn"
                ? "bg-amber-100 text-amber-600"
                : c.status === "fail"
                ? "bg-red-100 text-red-600"
                : "bg-slate-100 text-slate-400";

            const icon =
              c.status === "ok" ? "✓" :
              c.status === "warn" ? "!" :
              c.status === "fail" ? "✕" :
              running && i === 0 ? <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin block" /> :
              "○";

            return (
              <div
                key={c.id}
                className={`rounded-xl border transition-all ${statusColor}`}
              >
                {/* Header row — clickable to expand */}
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer select-none"
                  onClick={() => hasDetail && toggleExpand(c.id)}
                  style={running && !report ? { animation: `slide-in 0.3s ease-out ${i * 80}ms both` } : undefined}
                >
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-base font-bold ${iconBg}`}>
                    {icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-foreground">{c.label}</p>
                    {c.detail && !isExpanded && (
                      <p className={`text-xs mt-0.5 font-mono truncate ${
                        c.status === "ok" ? "text-green-700" :
                        c.status === "warn" ? "text-amber-700" :
                        c.status === "fail" ? "text-red-700" :
                        "text-muted"
                      }`}>
                        {c.detail}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {typeof c.duration === "number" && (
                      <span className="text-xs text-muted font-mono">{c.duration}ms</span>
                    )}
                    {hasDetail && (
                      <span className="text-xs text-muted">{isExpanded ? "▲" : "▼"}</span>
                    )}
                  </div>
                </div>

                {/* Expanded detail + suggestion + copy */}
                {isExpanded && hasDetail && (
                  <div className="px-4 pb-4 pt-0 border-t border-inherit">
                    {c.detail && (
                      <div className="mt-3">
                        <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Detail</p>
                        <p className={`text-sm font-mono whitespace-pre-wrap break-words ${
                          c.status === "ok" ? "text-green-700" :
                          c.status === "warn" ? "text-amber-700" :
                          c.status === "fail" ? "text-red-700" :
                          "text-muted"
                        }`}>
                          {c.detail}
                        </p>
                      </div>
                    )}

                    {suggestion && (
                      <div className="mt-3">
                        <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">💡 How to fix</p>
                        <p className="text-sm text-foreground">
                          {suggestion}
                        </p>
                      </div>
                    )}

                    <div className="mt-3 flex justify-end">
                      <CopyButton
                        text={formatCheckForCopy(c)}
                        label="Copy this check's details"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {report && (
          <div className="flex items-center justify-between text-xs text-muted">
            <span>Total time: <span className="font-mono">{report.duration}ms</span></span>
            <span className="font-mono">fp: {report.fingerprint}</span>
            <span>{new Date(report.generated_at).toLocaleString()}</span>
          </div>
        )}

        <div className="mt-10 text-center">
          <a href="/admin" className="text-sm text-muted hover:text-foreground">&larr; Back to admin</a>
        </div>
      </div>
    </div>
  );
}
