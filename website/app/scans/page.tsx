import Link from "next/link";
import type { Metadata } from "next";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import StatTiles from "../components/site/StatTiles";

export const metadata: Metadata = {
  title: "Hall of Scans — Real Results from Real Codebases | GateTest",
  description:
    "GateTest ran against real codebases with the current 120-module engine — including its own repo and our own false positives, published and then fixed. 2,607 errors and 10,101 warnings across four platforms. No demo data.",
};

interface Finding {
  severity: "critical" | "error" | "warning";
  module: string;
  description: string;
}

interface Chain {
  severity: "critical" | "high";
  label: string;
  description: string;
}

interface ScanEntry {
  repo: string;
  url: string;
  tier: string;
  date: string;
  modules: { passed: number; total: number };
  errors: number;
  warnings: number;
  topFindings: Finding[];
  chains?: Chain[];
  highlight?: string;
}

// Dated evidence. Every number, engine label and count below records what
// was true when the scan ran — never rewritten to the current module count.
const SCANS: ScanEntry[] = [
  {
    repo: "GateTest — self-scan (this product's own repo)",
    url: "https://github.com/crclabs-hq/gatetest",
    tier: "Full suite · 120-module engine · self-scan",
    date: "2026-07-12",
    modules: { passed: 76, total: 88 },
    errors: 137,
    warnings: 1963,
    topFindings: [
      { severity: "error", module: "authBypass", description: "84 of the 137 errors are this module reading route-shaped pattern strings inside our own scanner source — a false-positive class we're fixing next. Publishing it anyway: the correlator doesn't get to hide our own noise." },
      { severity: "error", module: "security", description: "Math.random() used where a security-sensitive value belongs — crypto.randomBytes is the fix" },
      { severity: "error", module: "seo", description: "Corpus/demo HTML files missing meta descriptions and Open Graph tags" },
      { severity: "warning", module: "errorSwallow", description: "Catch blocks that log without re-throwing — visible in logs, invisible to callers" },
    ],
    highlight: "Same-day proof: the morning quick-suite gate found 85 blocking issues in our own repo — a crashed ESLint config, a real fs TOCTOU race, 45 undocumented error swallows. All fixed at root cause by evening; the gate now passes 41/41. Every fix is in the public git history.",
  },
  {
    repo: "Vapron — production scheduling platform (dogfood)",
    url: "#",
    tier: "Full suite · 120-module engine · dogfood",
    date: "2026-07-12",
    modules: { passed: 56, total: 88 },
    errors: 1697,
    warnings: 7128,
    topFindings: [
      { severity: "critical", module: "security", description: "innerHTML assignments from non-constant sources — XSS surface" },
      { severity: "error", module: "errorSwallow", description: "113 silent error swallows — empty catches, .catch(() => {}), log-without-rethrow across API and auth paths" },
      { severity: "error", module: "envVars", description: "143 env vars read in code but absent from .env.example — the config contract doesn't know they exist" },
      { severity: "error", module: "accessibility", description: "278 findings — unlabeled inputs, animations without prefers-reduced-motion" },
      { severity: "error", module: "bashSafety", description: "382 shell-safety findings across ops scripts" },
    ],
    highlight: "1,697 errors on a pre-launch production platform under the current 120-module engine. Exact file/line detail is withheld here until the fixes land — these are live systems — but the counts are unedited. This is the queue GateTest's own CI gate is now grinding down on every push.",
  },
  {
    repo: "Gluecron.com — git hosting platform (dogfood)",
    url: "#",
    tier: "Forensic suite · April 2026 engine (39 modules) · dogfood",
    date: "2026-04-26",
    modules: { passed: 26, total: 39 },
    errors: 649,
    warnings: 743,
    topFindings: [
      { severity: "critical", module: "secrets", description: "Hardcoded API key in workflow file AND missing from .env.example — rotation is structurally impossible" },
      { severity: "error", module: "asyncIteration", description: "forEach(async ...) in webhook handler — errors swallowed, events processed out of order" },
      { severity: "error", module: "moneyFloat", description: "parseFloat() on billing amounts — sub-cent drift accumulates across high-volume cron runs" },
      { severity: "error", module: "raceCondition", description: "findOne → insert pattern on job table with no transaction or ON CONFLICT guard — duplicate-job race" },
    ],
    chains: [
      {
        severity: "critical",
        label: "Secret rotation is structurally impossible",
        description: "Hardcoded WORKFLOW_SECRETS_KEY in CI + missing from .env.example → the env contract doesn't even know the key exists → any rotation attempt breaks CI silently",
      },
      {
        severity: "high",
        label: "Billing drift + duplicate job race",
        description: "parseFloat on cron billing amounts + duplicate-job race on insert → a race creates two billing events, both use float arithmetic → double-charge with rounding error",
      },
    ],
    highlight: "The cleverest chain of this batch: hardcoded secret + missing from .env.example. Neither finding alone is alarming. Together they mean you cannot rotate the secret even if you wanted to — the rotation attempt itself would break production.",
  },
  {
    repo: "public legal-tech platform",
    url: "#",
    tier: "Forensic suite · April 2026 engine (39 modules) · consented scan",
    date: "2026-04-26",
    modules: { passed: 31, total: 39 },
    errors: 124,
    warnings: 267,
    topFindings: [
      { severity: "critical", module: "moneyFloat", description: "parseFloat() on trust-account transaction amounts in TrustActions.tsx — a legal-tech product handling client trust money" },
      { severity: "error", module: "errorSwallow", description: "Multiple .catch(() => {}) on payment promise chains — failed payments silently succeed from the caller's perspective" },
      { severity: "error", module: "logPii", description: "console.log(req.body) in auth endpoint — logs contain SSN and bank routing numbers from form submissions" },
      { severity: "warning", module: "raceCondition", description: "findOne → update race on trust-account balance with no transaction guard" },
    ],
    chains: [],
    highlight: "The correlator returned 0 chains on this repo — findings were genuinely independent. We didn't pad. But the money-float finding in a legal-tech trust-account handler is, in isolation, a textbook fintech bug that regulators call fraud when it accumulates at scale.",
  },
];

const SEVERITY_CONFIG = {
  critical: { badge: "bg-danger/10 text-danger border border-danger/20", label: "CRITICAL" },
  high: { badge: "bg-orange-500/10 text-orange-700 border border-orange-500/20", label: "HIGH" },
  error: { badge: "bg-warning/10 text-warning border border-warning/20", label: "ERROR" },
  warning: { badge: "bg-yellow-500/10 text-yellow-700 border border-yellow-500/20", label: "WARN" },
};

export default function HallOfScans() {
  return (
    <main>
      <PageHero
        eyebrow="Real scans. Real findings. No demo data."
        align="center"
        title="Hall of Scans"
        lede={
          <>
            Every result on this page came from running GateTest against a real
            codebase. No fabricated numbers. No cherry-picked examples — including
            our own false positives, which we publish and then fix. Each card names
            the engine that ran it: the July 2026 scans used today&apos;s 120-module
            engine (88 modules apply to a repo without a live URL); the archive
            entries ran on the 39-module April engine.
          </>
        }
        actions={
          <p className="text-sm text-muted w-full text-center">
            🔒 Scans run in memory — code is never stored.
            Findings published with platform owner consent.
          </p>
        }
      />

      <Section narrow>
        {/* Aggregate stat bar — sums of the per-card numbers below, update together. */}
        <div className="mb-16">
          <StatTiles
            items={[
              { label: "Errors found", value: "2,607" },
              { label: "Warnings surfaced", value: "10,101" },
              { label: "Repos scanned", value: "4" },
              { label: "Modules in the engine", value: "120" },
            ]}
          />
        </div>

        {/* Scan entries */}
        <div className="space-y-12">
          {SCANS.map((scan) => (
            <article key={scan.repo} className="card overflow-hidden">

              {/* Repo header */}
              <div className="px-6 py-5 border-b border-border flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-4 h-4 text-muted shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    <span className="font-mono text-sm font-semibold text-foreground break-words">{scan.repo}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted">
                    <span>{scan.tier}</span>
                    <span>·</span>
                    <span>{scan.date}</span>
                    <span>·</span>
                    <span>{scan.modules.passed}/{scan.modules.total} modules passed</span>
                  </div>
                </div>
                <div className="flex gap-3 shrink-0">
                  <div className="text-center">
                    <div className="font-display text-xl font-bold text-danger tabular-nums">{scan.errors.toLocaleString()}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted">Errors</div>
                  </div>
                  <div className="text-center">
                    <div className="font-display text-xl font-bold text-warning tabular-nums">{scan.warnings.toLocaleString()}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted">Warnings</div>
                  </div>
                </div>
              </div>

              {/* Highlight quote */}
              {scan.highlight && (
                <div className="px-6 py-4 bg-surface-light border-b border-border">
                  <p className="text-sm text-foreground-secondary italic leading-relaxed">&ldquo;{scan.highlight}&rdquo;</p>
                </div>
              )}

              {/* Top findings */}
              <div className="px-6 py-5">
                <h3 className="text-xs uppercase tracking-wider font-semibold text-muted mb-3">Top Findings</h3>
                <div className="space-y-2.5">
                  {scan.topFindings.map((f, i) => {
                    const cfg = SEVERITY_CONFIG[f.severity];
                    return (
                      <div key={i} className="flex items-start gap-3">
                        <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${cfg.badge}`}>
                          {cfg.label}
                        </span>
                        <div>
                          <span className="text-xs font-mono text-accent">{f.module}</span>
                          <span className="mx-1.5 text-muted text-xs">—</span>
                          <span className="text-sm text-foreground-secondary">{f.description}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Attack chains */}
              {scan.chains && scan.chains.length > 0 && (
                <div className="px-6 py-5 border-t border-border bg-danger/5">
                  <h3 className="text-xs uppercase tracking-wider font-semibold text-danger mb-3">
                    Cross-Finding Attack Chains
                  </h3>
                  <div className="space-y-3">
                    {scan.chains.map((c, i) => {
                      const cfg = SEVERITY_CONFIG[c.severity];
                      return (
                        <div key={i} className="flex items-start gap-3">
                          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${cfg.badge}`}>
                            {cfg.label}
                          </span>
                          <div>
                            <div className="text-sm font-semibold text-foreground mb-0.5">{c.label}</div>
                            <div className="text-sm text-foreground-secondary">{c.description}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* No chains — honest note */}
              {scan.chains && scan.chains.length === 0 && (
                <div className="px-6 py-4 border-t border-border bg-surface-light">
                  <p className="text-xs text-muted">
                    <strong className="text-foreground-secondary">Cross-finding correlation:</strong> 0 chains identified.
                    Findings were genuinely independent — the correlator does not pad results.
                  </p>
                </div>
              )}
            </article>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-16 text-center rounded-2xl border border-accent/20 bg-accent/5 px-6 py-10 sm:p-12">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-3">See what&apos;s in your repo</h2>
          <p className="text-foreground-secondary mb-6 max-w-xl mx-auto">
            Free preview scan — no card required. Quick suite: syntax, lint, secrets,
            code quality. Runs in under 30 seconds on any public repo.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link href="/scan/preview" className="btn-cta inline-flex items-center gap-2 px-6 py-3">
              Free preview scan &rarr;
            </Link>
            <Link href="/#pricing" className="btn-secondary inline-flex items-center gap-2 px-6 py-3">
              See full pricing
            </Link>
          </div>
        </div>
      </Section>
    </main>
  );
}
