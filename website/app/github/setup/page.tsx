import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Install GateTest — GitHub App · Private repo scanning",
  description:
    "Install GateTest on GitHub in one click. Auto-scans every push and PR with 110 quality modules. Results posted as commit statuses and PR comments.",
};

const AFTER_INSTALL = [
  { t: "info", text: "  GateTest detected push to feature/billing-overhaul" },
  { t: "info", text: "  Scanning 11 changed files vs main..." },
  { t: "pass", text: "  [PASS] syntax       · lint       · secrets" },
  { t: "fail", text: "  [FAIL] moneyFloat   — 1 issue" },
  { t: "sep",  text: "" },
  { t: "err",  text: "  ERR  moneyFloat › src/billing/invoice.ts:94" },
  { t: "dim",  text: "       parseFloat() on invoice.total — use Decimal.js" },
  { t: "sep",  text: "" },
  { t: "sum",  text: "  Opening auto-fix PR: gatetest/auto-repair-48821..." },
  { t: "ok",   text: "  PR #47 opened — review the fix, merge when ready." },
];

const T: Record<string, string> = {
  info: "text-white/40",
  pass: "text-emerald-400",
  fail: "text-red-400",
  err:  "text-red-300",
  dim:  "text-white/45",
  sum:  "text-white/60",
  ok:   "text-teal-400 font-semibold",
  sep:  "block",
};

const PERMS = [
  { perm: "Contents",       level: "Read",  why: "Read your code to scan it — never stored" },
  { perm: "Pull requests",  level: "Write", why: "Post scan results as PR comments" },
  { perm: "Commit statuses",level: "Write", why: "Green ✅ or red ❌ on each commit" },
  { perm: "Metadata",       level: "Read",  why: "Know which repos to watch" },
];

export default function GitHubSetup() {
  return (
    <main className="min-h-screen bg-[#0d1117] text-white">

      {/* Nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-xs font-mono">G</span>
            </div>
            <span className="text-base font-bold tracking-tight">Gate<span className="text-teal-400">Test</span></span>
          </Link>
          <div className="flex items-center gap-4 text-sm text-white/50">
            <Link href="/developers" className="hover:text-white transition-colors">Developers</Link>
            <Link href="/scan/preview" className="hover:text-white transition-colors">Free Preview</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 py-14">

        {/* Header */}
        <div className="mb-12 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-teal-400" />
            GitHub App · private repos · auto-fix PRs
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3 leading-tight">
            GateTest on GitHub —<br />
            <span className="text-teal-400">install once, forget about config.</span>
          </h1>
          <p className="text-white/50 text-base leading-relaxed max-w-xl mx-auto">
            Every push and PR gets scanned with 120 modules. Findings post as inline PR comments and commit statuses. Auto-fix PR opened automatically when there&apos;s something to fix.
          </p>
        </div>

        {/* Install button */}
        <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden mb-10">
          <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
            <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
            <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <div className="w-3 h-3 rounded-full bg-[#28c840]" />
            <span className="ml-3 text-xs text-white/30 font-mono">github.com/apps/GateTestHQ</span>
          </div>
          <div className="p-8 text-center space-y-4">
            <p className="text-sm text-white/50">
              Select which repos GateTest can access. Public or private. You control the scope — single repo or entire org.
            </p>
            <a
              href="https://github.com/apps/GateTestHQ"
              className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl bg-teal-600 text-white font-semibold text-sm hover:bg-teal-500 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              Install GateTest on GitHub →
            </a>
            <p className="text-xs text-white/25">No credit card for the GitHub App install. Scans under 30s.</p>
          </div>
        </div>

        {/* What happens after install */}
        <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden mb-8">
          <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02]">
            <span className="text-xs font-mono text-white/50">what happens on the next push</span>
          </div>
          <div className="p-5 font-mono text-xs space-y-1.5">
            {AFTER_INSTALL.map((l, i) =>
              l.t === "sep" ? <div key={i} className="h-1.5" /> : (
                <div key={i} className={T[l.t]}>{l.text}</div>
              )
            )}
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-3 mb-10">
          {[
            { n: "1", title: "Install the app", desc: "Pick individual repos or the whole org. Takes 30 seconds." },
            { n: "2", title: "Push or open a PR", desc: "GateTest hooks into GitHub webhooks — no config file needed." },
            { n: "3", title: "See results in your PR", desc: "Inline annotations on the diff, commit status, PR comment with severity breakdown." },
            { n: "4", title: "Auto-fix PR (optional)", desc: "When ANTHROPIC_API_KEY is set on the org, GateTest opens a fix PR automatically. You review, you merge." },
          ].map((s) => (
            <div key={s.n} className="flex items-start gap-4 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
              <div className="w-7 h-7 rounded-lg bg-teal-600/20 border border-teal-500/30 flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-teal-400">{s.n}</span>
              </div>
              <div>
                <p className="text-sm font-semibold text-white">{s.title}</p>
                <p className="text-xs text-white/45 mt-0.5">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Permissions */}
        <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden mb-8">
          <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02]">
            <span className="text-xs font-mono text-white/50">permissions requested</span>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {PERMS.map((p) => (
              <div key={p.perm} className="flex items-center justify-between px-5 py-3 text-xs">
                <span className="text-white/70 font-mono">{p.perm}</span>
                <span className="text-teal-400 font-mono mr-4">{p.level}</span>
                <span className="text-white/35 flex-1 text-right">{p.why}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Privacy */}
        <div className="rounded-xl bg-teal-500/5 border border-teal-500/15 px-5 py-4 mb-10 text-xs text-white/45 leading-relaxed">
          🔒 <strong className="text-white/70">Code is never stored.</strong> GateTest reads your files, runs them through 120 modules in memory, posts results to GitHub, then discards everything. No database of your code. No training on your codebase.
        </div>

        {/* Not on GitHub? */}
        <div className="text-center space-y-3">
          <p className="text-xs text-white/30">Not using the GitHub App? Try the CI workflow installer:</p>
          <Link href="/developers" className="text-sm text-teal-400 hover:underline">
            curl | bash install for any git host →
          </Link>
        </div>

      </div>
    </main>
  );
}
