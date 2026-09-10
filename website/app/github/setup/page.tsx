import type { Metadata } from "next";
import Link from "next/link";
import { APP_PERMISSIONS, APP_SLUG, appInstallUrl } from "@/app/lib/github-app-permissions";
import { SITE_URL } from "@/app/lib/site-url";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

export const metadata: Metadata = {
  title: "Install GateTest — GitHub App · Private repo scanning",
  description:
    "Install GateTest on GitHub free. Every push and PR runs the full deterministic engine — secrets, security, CI hardening, supply chain, code quality and more — with results as commit statuses and PR comments. AI code review and auto-fix PRs are paid on gatetest.io.",
};

const AFTER_INSTALL = [
  { t: "info", text: "  GateTest detected push to feature/billing-overhaul" },
  { t: "info", text: "  Running free deterministic gate — full suite, Claude-powered modules skipped..." },
  { t: "fail", text: "  [FAIL] secrets      — 1 issue" },
  { t: "sep",  text: "" },
  { t: "err",  text: "  ERR  secrets › src/billing/invoice.ts:94" },
  { t: "dim",  text: "       hardcoded API key detected" },
  { t: "sep",  text: "" },
  { t: "sum",  text: "  Commit status: 1 error · advisory mode. PR comment posted." },
  { t: "dim",  text: "  Block on it: set mode: strict in .gatetest.json. Want an auto-fix PR? → gatetest.io" },
];

const T: Record<string, string> = {
  info: "text-panel-muted",
  pass: "text-emerald-400",
  fail: "text-red-400",
  err:  "text-red-300",
  dim:  "text-panel-muted",
  sum:  "text-panel-foreground",
  ok:   "text-accent-light font-semibold",
  sep:  "block",
};

// The permission list is NOT written here. GitHub shows the real scopes on the
// install screen, so this page and the App config must agree exactly — a page
// promising less than the install prompt asks for is the disclosure mismatch a
// Marketplace reviewer checks for. Until 2026-08-05 this page said Contents:
// Read while the App path pushes an auto-fix branch (contents: write) and
// omitted Issues entirely (PR comments post via the Issues comments API).
// Source of truth: src/core/github-app-permissions.js, guarded by
// tests/marketplace-sync.test.js.
type AppPermission = { key: string; display: string; label: string; why: string };
const PERMS = (APP_PERMISSIONS as AppPermission[]).map((p) => ({
  perm: p.display,
  level: p.label,
  why: p.why,
}));

const GITHUB_ICON = "M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z";

function InstallButton() {
  return (
    <a
      href={appInstallUrl()}
      className="btn-cta inline-flex items-center gap-2 px-8 py-3.5 text-sm font-semibold rounded-xl"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={GITHUB_ICON} />
      </svg>
      Install GateTest on GitHub →
    </a>
  );
}

export default function GitHubSetup() {
  return (
    <main>
      <PageHero
        eyebrow="GitHub App · free deterministic gate · private repos supported"
        title={<>GateTest on GitHub — <span className="text-accent">install once, forget about config.</span></>}
        lede={<>Free the moment you install: every push and PR runs the full deterministic engine — secrets, security, CI hardening, supply chain, code quality and more; only the Claude-powered modules are skipped — with results posted as commit statuses and PR comments. Want AI code review on every push? Subscribe to Continuous. Want an auto-fix PR? Run a Scan + Fix or Forensic scan at <a href={SITE_URL} className="text-accent hover:underline">gatetest.io</a>.</>}
        actions={<InstallButton />}
      >
        {/* What happens after install — what the CI sees, so it stays a dark panel */}
        <div className="rounded-xl bg-panel text-panel-foreground border border-panel-border overflow-hidden shadow-lg">
          <div className="px-5 py-3 border-b border-panel-border bg-panel-alt">
            <span className="text-xs font-mono text-panel-muted">what happens on the next push</span>
          </div>
          <div className="p-5 font-mono text-xs space-y-1.5 overflow-x-auto">
            {AFTER_INSTALL.map((l, i) =>
              l.t === "sep" ? <div key={i} className="h-1.5" /> : (
                <div key={i} className={`whitespace-pre ${T[l.t]}`}>{l.text}</div>
              )
            )}
          </div>
        </div>
      </PageHero>

      <Section narrow>
        {/* Install card */}
        <div className="card overflow-hidden mb-10">
          <div className="flex items-center gap-1.5 px-4 py-3 border-b border-border section-alt">
            <div className="w-3 h-3 rounded-full bg-danger/80" />
            <div className="w-3 h-3 rounded-full bg-warning/80" />
            <div className="w-3 h-3 rounded-full bg-success/80" />
            <span className="ml-3 text-xs text-muted font-mono">github.com/apps/{APP_SLUG}</span>
          </div>
          <div className="p-8 text-center space-y-4">
            <p className="text-sm text-muted">
              Select which repos GateTest can access. Public or private. You control the scope — single repo or entire org.
            </p>
            <InstallButton />
            <p className="text-xs text-muted">No credit card for the GitHub App install. Scans typically finish in under a minute.</p>
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-3 mb-10">
          {[
            { n: "1", title: "Install the app", desc: "Pick individual repos or the whole org. Takes 30 seconds. Free, no card required." },
            { n: "2", title: "Push or open a PR", desc: "GateTest hooks into GitHub webhooks — no config file needed. The free deterministic gate runs automatically on every push." },
            { n: "3", title: "See results in your PR", desc: "Commit status and a PR comment with what the gate found. Fresh installs run in advisory mode — the check stays green until you set mode: strict in .gatetest.json." },
            { n: "4", title: "Go deeper (optional, paid)", desc: "AI code review on every push with the Continuous subscription, or an auto-fix PR with a Scan + Fix or Forensic scan — both purchased separately at gatetest.io. Fix PRs are not part of Continuous." },
          ].map((s) => (
            <div key={s.n} className="card flex items-start gap-4 p-4">
              <div className="w-7 h-7 rounded-lg bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-accent">{s.n}</span>
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{s.title}</p>
                <p className="text-xs text-muted mt-0.5">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Permissions */}
        <div className="card overflow-hidden mb-8">
          <div className="px-5 py-3 border-b border-border section-alt">
            <span className="text-xs font-mono text-muted">permissions requested</span>
          </div>
          <div className="divide-y divide-border">
            {PERMS.map((p) => (
              <div key={p.perm} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-xs">
                <span className="text-foreground font-mono">{p.perm}</span>
                <span className="text-accent font-mono">{p.level}</span>
                <span className="text-muted flex-1 basis-full sm:basis-auto sm:text-right">{p.why}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Privacy */}
        <div className="rounded-xl bg-accent/5 border border-accent/15 px-5 py-4 mb-10 text-xs text-muted leading-relaxed">
          🔒 <strong className="text-foreground">Code is never stored.</strong> GateTest reads your files, runs them through the modules included in your tier in memory, posts results to GitHub, then discards the source. What we keep is the findings — message, file path, line number — so your report exists. No database of your code. No training on your codebase.
        </div>

        {/* Not on GitHub? */}
        <div className="text-center space-y-3">
          <p className="text-xs text-muted">Not using the GitHub App? Try the CI workflow installer:</p>
          <Link href="/developers" className="text-sm text-accent hover:underline">
            curl | bash install for any git host →
          </Link>
        </div>
      </Section>
    </main>
  );
}
