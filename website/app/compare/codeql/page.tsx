import type { Metadata } from "next";
import Link from "next/link";
import ComparisonReviewed from "@/app/components/ComparisonReviewed";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import PageHero from "../../components/site/PageHero";

export const metadata: Metadata = {
  title: "GateTest vs CodeQL — minutes, not 30, in 2026",
  description:
    "CodeQL is GitHub's deep taint-analysis engine — best-in-class for multi-hop injection chains, but slow, GitHub-only, and zero auto-fix. GateTest covers the same attack classes in minutes across 121 modules and opens a fix PR.",
  keywords: [
    "CodeQL alternative",
    "CodeQL vs GateTest",
    "GitHub Advanced Security alternative",
    "faster SAST",
    "CodeQL replacement",
    "auto-fix security vulnerabilities",
    "SAST with AI fix",
  ],
  alternates: {
    canonical: "/compare/codeql",
  },
  openGraph: {
    title: "GateTest vs CodeQL — minutes, not 30, in 2026",
    description:
      "CodeQL does deep taint analysis. GateTest does the same security classes plus everything else — 121 modules total — in minutes — and opens the fix PR.",
    url: "/compare/codeql",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "How does GateTest differ from CodeQL?",
    a: "CodeQL is a semantic analysis engine that tracks data flow across function boundaries — it's genuinely excellent at multi-hop taint chains like 'user input enters here, passes through these two functions, reaches a SQL query there.' That depth comes with trade-offs: a CodeQL scan on a medium repo takes 15-30 minutes, it requires GitHub Actions or a local CodeQL runner, and GitHub Advanced Security (required for private repos) adds significant per-seat cost. GateTest covers the same SSRF, SQL injection, and command-injection attack classes in minutes across a broader surface (121 modules including Terraform, K8s, Dockerfile, accessibility, performance, and AI safety), and opens a fix PR on the Scan + Fix tier. The use case is complementary for high-assurance codebases: CodeQL for deep taint chains, GateTest for breadth + speed + fix delivery.",
  },
  {
    q: "Does CodeQL find the same vulnerabilities as GateTest?",
    a: "CodeQL covers a subset of the vulnerability classes GateTest covers, and covers them differently. CodeQL's taint-analysis approach genuinely tracks multi-step data flow chains that GateTest's module-based approach may miss — for example, user input flowing through 4 intermediate functions before reaching a sink. Across GateTest's 121 modules, the large majority address categories CodeQL doesn't touch at all: N+1 queries, race conditions, datetime timezone bugs, money-float errors, PII in logs, stale feature flags, import cycles, Dockerfile security, Kubernetes manifest hardening, CI pipeline permissions, accessibility (WCAG 2.2), and more. Honest answer: both tools have real, different coverage gaps.",
  },
  {
    q: "Does CodeQL require GitHub Advanced Security?",
    a: "For public repositories on GitHub, CodeQL is free via GitHub Actions. For private repositories, CodeQL requires GitHub Advanced Security, which is priced per committer per month — a significant budget line for larger teams. GateTest charges per scan ($99 for all 121 modules, no per-seat licensing) and works with any GitHub repository (public or private) as well as Gluecron-hosted repos.",
  },
  {
    q: "Can CodeQL auto-fix vulnerabilities?",
    a: "CodeQL has no auto-fix capability as of 2026. GitHub Copilot Autofix can suggest patches for CodeQL alerts in GitHub Advanced Security, but these are limited to CodeQL-flagged issues and require manual review. GateTest's Scan + Fix tier ($199) uses Claude to write working code fixes for every issue it finds — not suggestions, but an actual pull request with the guard added, the query restructured, or the config corrected. On the Forensic Scan tier ($399), Claude also reasons about each finding individually and identifies cross-finding attack chains.",
  },
  {
    q: "How long does a CodeQL scan take vs GateTest?",
    a: "A typical CodeQL scan on a 50,000-line JavaScript/TypeScript codebase takes 10-30 minutes in GitHub Actions depending on query suite depth and build time. GateTest targets a full scan (121 modules) in minutes via a direct API call — no CI run required, no build step. For fast iteration (pre-commit, PR review, on-demand audits) the speed difference matters significantly.",
  },
  {
    q: "Does GateTest work without GitHub Actions?",
    a: "Yes. GateTest's website scan (/pricing) runs on-demand via a direct API call — you paste a repo URL, pay, and get results without touching your CI. The GitHub App delivers results as commit statuses and PR comments. The CLI (npm install -g @gatetest/cli) runs locally or in any CI environment. CodeQL requires either GitHub Actions or a local CodeQL runner installed from GitHub's release page.",
  },
];

const comparisonRows = [
  { feature: "Multi-hop taint-flow analysis (SQL injection, path traversal)", gatetest: true, competitor: true },
  { feature: "SSRF detection", gatetest: true, competitor: true },
  { feature: "Command injection detection", gatetest: true, competitor: true },
  { feature: "Auto-fix PR (working code changes)", gatetest: true, competitor: false },
  { feature: "Scan time under 2 minutes", gatetest: true, competitor: false },
  { feature: "Works on private repos without per-seat licensing", gatetest: true, competitor: false },
  { feature: "IaC security (Terraform, K8s, Dockerfile, CI)", gatetest: true, competitor: false },
  { feature: "Dependency / SCA scanning", gatetest: true, competitor: false },
  { feature: "Accessibility (WCAG 2.2 automated audit)", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Race condition / TOCTOU detection", gatetest: true, competitor: false },
  { feature: "PII-in-logs detection", gatetest: true, competitor: false },
  { feature: "Prompt injection / AI-app safety scanning", gatetest: true, competitor: false },
  { feature: "Mutation testing (via GitHub Action)", gatetest: true, competitor: false },
  { feature: "Cross-finding attack-chain correlation (Forensic tier)", gatetest: true, competitor: false },
  { feature: "Pay per scan (no per-seat licensing)", gatetest: true, competitor: false },
  { feature: "Works outside GitHub (Gluecron, CLI, any CI)", gatetest: true, competitor: false },
  { feature: "PR / commit status integration", gatetest: true, competitor: true },
];

export default function CodeQLPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <PageHero
        eyebrow="Tool Comparison"
        title={
          <>
            GateTest vs CodeQL
            <br />
            <span className="text-accent">Minutes of Breadth vs 30 Minutes of Depth in 2026</span>
          </>
        }
        lede={
          <>
            CodeQL is GitHub&rsquo;s deep taint engine — genuinely excellent at tracking data flow
            across function boundaries. The trade-offs are real: 15-30 minute scan times, GitHub
            Advanced Security required for private repos, no auto-fix, and zero coverage of
            accessibility, performance, IaC, or AI safety. GateTest covers {TOTAL_MODULES} categories in
            minutes and opens a fix PR.
          </>
        }
        actions={
          <>
            <Link href="/playground" className="btn-cta inline-flex items-center justify-center px-6 py-3 text-sm">
              Scan My Repo — From $29
            </Link>
            <Link href="/#modules" className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm">
              See All {TOTAL_MODULES} modules
            </Link>
          </>
        }
      />

      <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">

        {/* Honest comparison callout */}
        <section className="mb-16 rounded-2xl border border-blue-500/20 p-6 bg-blue-500/5">
          <h2 className="text-lg font-semibold text-blue-700 mb-3">Where CodeQL is genuinely stronger</h2>
          <p className="text-foreground-secondary text-sm mb-4">
            We believe in honesty. CodeQL&rsquo;s taint-analysis engine has real advantages for specific scenarios:
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            {[
              "Multi-hop injection: user input → function A → function B → SQL sink",
              "Custom QL queries for codebase-specific invariants",
              "Deep Java/C++ taint flows that cross compilation units",
              "Dataflow precision that exceeds heuristic module detection",
            ].map((item) => (
              <div key={item} className="flex items-start gap-2 text-sm text-foreground-secondary">
                <span className="text-blue-600 shrink-0 mt-0.5">&#10003;</span>
                <span className="text-xs text-muted">{item}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted mt-4">
            For high-assurance security audits where scan time doesn&rsquo;t matter, CodeQL&rsquo;s depth is real. GateTest is the better choice for breadth, speed, auto-fix, and everything outside security.
          </p>
        </section>

        {/* What CodeQL can't do */}
        <section className="mb-16 rounded-2xl border border-amber-500/20 p-6 bg-amber-500/5">
          <h2 className="text-lg font-semibold text-warning mb-3">What CodeQL doesn&rsquo;t cover</h2>
          <p className="text-foreground-secondary text-sm mb-4">
            CodeQL is a security SAST engine. These entire categories are outside its scope:
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            {[
              "Accessibility (WCAG 2.2) — zero coverage",
              "Performance — Lighthouse-grade analysis not available",
              "IaC security — Terraform, K8s manifests, Dockerfiles",
              "CI pipeline hardening — unpinned actions, permissions hygiene",
              "N+1 queries — ORM-level loop detection",
              "Dependency hygiene — lockfile drift, wildcard pins, deprecated packages",
              "AI / prompt injection safety — client-bundled API keys",
              "Auto-fix — no PR generation, no code changes",
            ].map((item) => (
              <div key={item} className="flex items-start gap-2 text-sm text-foreground-secondary">
                <span className="text-danger/70 shrink-0 mt-0.5">&#10007;</span>
                <span className="text-xs text-muted">{item}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Comparison table */}
        <section className="mb-16">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-6">Feature Comparison</h2>
          <div className="rounded-xl border border-border overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-light">
                  <th className="text-left px-5 py-4 text-muted font-medium">Feature</th>
                  <th className="text-center px-5 py-4 text-accent font-semibold">GateTest</th>
                  <th className="text-center px-5 py-4 text-muted font-medium">CodeQL</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr
                    key={row.feature}
                    className="border-b border-border last:border-0 hover:bg-surface-light transition-colors"
                  >
                    <td className="px-5 py-3.5 text-foreground-secondary">{row.feature}</td>
                    <td className="px-5 py-3.5 text-center">
                      {row.gatetest ? (
                        <span className="text-success font-bold text-base">&#10003;</span>
                      ) : (
                        <span className="text-muted">&#8212;</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {row.competitor ? (
                        <span className="text-success/70 font-bold text-base">&#10003;</span>
                      ) : (
                        <span className="text-danger/70">&#10007;</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted mt-3 px-1">
            CodeQL is free for public repos via GitHub Actions. Private repos require GitHub Advanced Security (per-committer pricing).
          </p>
        </section>

        {/* Key differentiators */}
        <section className="mb-16">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-8">Where GateTest wins</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Minutes vs. 30 minutes",
                body: "CodeQL scans take 10-30 minutes on typical codebases. A developer waiting 25 minutes for security results between commits isn't going to run the scan often — and 'run it once in CI' means bugs ship to PR review before anyone saw them. GateTest targets a few minutes, making it practical as a pre-commit hook, a per-PR gate, and an on-demand audit tool.",
              },
              {
                title: "Auto-fix PR — CodeQL can't do this",
                body: "CodeQL shows you what's wrong. GateTest fixes it. The Scan + Fix tier ($199) uses Claude to write working code changes and open a pull request — not just a suggestion, but a commit with the guard added and a regression test written. The Forensic Scan tier ($399) adds per-finding Claude diagnosis and cross-finding attack-chain correlation.",
              },
              {
                title: "No Advanced Security licence required",
                body: "CodeQL on private repos requires GitHub Advanced Security, which is priced per committer per month. A 20-person team pays hundreds of dollars monthly before running a single scan. GateTest charges $99 per scan for all 121 modules — no seat licensing, no annual contracts. The price is identical for a solo developer and a 500-person team.",
              },
              {
                title: `${TOTAL_MODULES} categories vs. security-only`,
                body: "CodeQL is a security engine. The 80% of code quality problems that aren't CVEs — N+1 queries, race conditions, accessibility failures, stale feature flags, PII in logs, import cycles, IaC misconfigurations — are invisible to CodeQL. GateTest runs them all in the same scan.",
              },
            ].map((card) => (
              <div
                key={card.title}
                className="card p-5"
              >
                <h3 className="text-foreground font-semibold mb-2">{card.title}</h3>
                <p className="text-foreground-secondary text-sm leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="mb-16">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-8">Frequently asked questions</h2>
          <div className="space-y-4">
            {faqItems.map((item) => (
              <div
                key={item.q}
                className="card p-5"
              >
                <h3 className="text-foreground font-semibold mb-3 leading-snug">{item.q}</h3>
                <p className="text-foreground-secondary text-sm leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="rounded-2xl border border-accent/20 bg-accent/5 px-6 py-10 sm:p-12 text-center">
          <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4">
            121 modules. Minutes, not 30. Fix PR included.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            Security, quality, accessibility, IaC, AI safety — in one scan, no CI required, no
            per-seat licensing. Claude opens the fix PR on Scan + Fix and Forensic Scan tiers.
          </p>
          <Link
            href="/playground"
            className="btn-cta inline-flex items-center justify-center px-8 py-4"
          >
            Scan My Repo — From $29
          </Link>
          <p className="text-muted text-xs mt-6">
            One-time payment per scan via Stripe. No subscription, no auto-renew.
          </p>
        </section>
        <ComparisonReviewed slug="codeql" />
      </div>
    </main>
  );
}
