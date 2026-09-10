import type { Metadata } from "next";
import Link from "next/link";
import ComparisonReviewed from "@/app/components/ComparisonReviewed";
import PageHero from "../../components/site/PageHero";
import { TOTAL_MODULES } from "@/app/lib/module-count";

export const metadata: Metadata = {
  title: "GateTest vs DeepSource — AI-Native Code Quality in 2026",
  description:
    "DeepSource finds issues. GateTest finds them and — at the Scan + Fix tier ($199) and above — fixes them. 121 modules, per-scan pricing, no per-seat licensing, AI auto-fix PRs opened in minutes.",
  keywords: [
    "DeepSource alternative",
    "DeepSource vs GateTest",
    "beyond DeepSource",
    "AI code quality 2026",
    "auto-fix PRs",
    "code review automation",
    "DeepSource replacement",
  ],
  alternates: {
    canonical: "/compare/deepsource",
  },
  openGraph: {
    title: "GateTest vs DeepSource — AI-Native Code Quality in 2026",
    description:
      "DeepSource finds issues. GateTest finds them and — at the Scan + Fix tier ($199) and above — fixes them. 121 modules, per-scan pricing, no per-seat licensing, AI auto-fix PRs.",
    url: "/compare/deepsource",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "What does GateTest do that DeepSource doesn't?",
    a: "GateTest's key advantages over DeepSource: AI-powered code review using Claude (DeepSource uses static analysis, not generative AI), AI auto-fix PRs at the Scan + Fix tier ($199) and Forensic Scan ($399) that write actual code changes (DeepSource shows issues, not fixes), pay-per-scan pricing (DeepSource is subscription per-seat), coverage of performance/visual regression/chaos testing/mutation testing (DeepSource is code quality and security only; chaos and mutation ship via the GitHub Action, which has a CI runner and headless browser to drive them), and prompt/LLM safety scanning for AI apps.",
  },
  {
    q: "DeepSource has a free tier. Does GateTest?",
    a: "GateTest charges per scan: $29 quick scan (4 modules), $99 full scan (121 modules). The open-source CLI runs quick and full scans locally for free, and the website offers a free preview scan. The key difference: GateTest's $99 scan includes AI code review, performance analysis, accessibility, visual regression, and 60+ other modules that require multi-tool subscriptions to replicate with DeepSource + extras.",
  },
  {
    q: "Does GateTest's AI fix code like DeepSource's Autofix?",
    a: "GateTest's Scan + Fix tier ($199) goes further than DeepSource Autofix. DeepSource Autofix generates fixes for a specific subset of analysis issues. GateTest uses Claude to read your entire codebase context and write fixes for any issue it finds — security misconfigurations, logic bugs, N+1 queries, accessibility violations — and opens a pull request with complete, reviewable code. The Forensic Scan tier ($399) adds attack-chain correlation across findings, a board-ready CISO report, and an executive summary report you can hand to a CTO. Mutation testing on your existing tests also ships via the GitHub Action with mutation: true — runs wherever your CI runs.",
  },
  {
    q: "How do scan speeds compare?",
    a: "GateTest quick scans (4 modules) complete in seconds. Full 121-module scans typically complete in a few minutes, depending on repo size. DeepSource runs asynchronously in the background and varies widely by repo size. GateTest gives you synchronous results within the CI timeout window — no waiting for background workers.",
  },
  {
    q: "Does GateTest cover the same languages as DeepSource?",
    a: "Different shapes of coverage. GateTest is deepest on JavaScript/TypeScript (AST-level analysis), with pattern-level modules for Python, Go, Java, Ruby, PHP, C#, Kotlin, Swift, and Rust — the non-JS depth is honestly thinner than a dedicated per-language analyzer. DeepSource has deeper single-language analyzers for its ~16 supported languages; GateTest covers a wider surface (security, a11y, performance, infra, AI-code checks) in one engine.",
  },
  {
    q: "Can GateTest replace DeepSource for continuous scanning?",
    a: "Yes. Install the GateTest GitHub App and every push to your repo triggers a scan automatically — commit status posted, PR comment added, full report available. The Continuous plan ($49/month, one flat price for every repo in your org) is what enables scans on every push; the one-time tiers are single scans. Continuous includes unlimited deterministic scans plus a monthly AI-review allowance; fix PRs remain a per-scan purchase.",
  },
];

const comparisonRows = [
  { feature: "Static code analysis", gatetest: true, competitor: true },
  { feature: "Security vulnerability detection", gatetest: true, competitor: true },
  { feature: "Multi-language support", gatetest: true, competitor: true },
  { feature: "AI code review (generative AI, not patterns)", gatetest: true, competitor: false },
  { feature: "Auto-fix PRs for any issue type", gatetest: true, competitor: false },
  { feature: "Performance analysis", gatetest: true, competitor: false },
  { feature: "Accessibility scanning (WCAG 2.2, AA + AAA-aligned)", gatetest: true, competitor: false },
  { feature: "Visual regression testing", gatetest: true, competitor: false },
  { feature: "Mutation testing (via GitHub Action)", gatetest: true, competitor: false },
  { feature: "Chaos testing (via GitHub Action)", gatetest: true, competitor: false },
  { feature: "Prompt / LLM safety scanning", gatetest: true, competitor: false },
  { feature: "Race condition / TOCTOU detection", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Pay per scan (not per seat subscription)", gatetest: true, competitor: false },
  { feature: "121 modules in one gate", gatetest: true, competitor: false },
];

export default function DeepSourcePage() {
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
            GateTest vs DeepSource
            <br />
            <span className="text-accent">AI-Native Code Quality in 2026</span>
          </>
        }
        lede={
          <>
            DeepSource is a solid static analysis tool. GateTest is an AI-native quality platform:
            121 modules, generative AI code review using Claude, AI auto-fix PRs that write real code at the Scan + Fix tier ($199) and Forensic Scan ($399),
            and per-scan pricing with no per-seat subscriptions.
          </>
        }
        actions={
          <>
            <Link href="/playground" className="btn-cta inline-flex items-center justify-center px-6 py-3 text-sm">
              Scan My Repo — From $29
            </Link>
            <Link href="/modules" className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm">
              See All {TOTAL_MODULES} Modules
            </Link>
          </>
        }
      />

      <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">

        {/* AI advantage callout */}
        <section className="mb-16 rounded-2xl border border-accent/20 p-6 bg-accent/5">
          <h2 className="text-lg font-semibold text-accent mb-3">The AI difference</h2>
          <div className="grid sm:grid-cols-2 gap-6">
            <div>
              <div className="text-muted text-xs font-semibold uppercase tracking-wider mb-3">DeepSource approach</div>
              <p className="text-sm text-foreground-secondary leading-relaxed">
                Rules-based static analysis. Detects patterns defined in analyzer rules — useful, but limited to what the rule authors anticipated. Can&rsquo;t reason about intent, context, or emergent bugs from code interaction.
              </p>
            </div>
            <div>
              <div className="text-accent text-xs font-semibold uppercase tracking-wider mb-3">GateTest AI approach</div>
              <p className="text-sm text-foreground-secondary leading-relaxed">
                Claude reads your code with full context — the function, its callers, the data it processes — and reasons about what the code <em>does</em>, not just how it looks. Catches logic bugs, off-by-one errors in financial code, and security issues that emerge from how code components interact.
              </p>
            </div>
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
                  <th className="text-center px-5 py-4 text-muted font-medium">DeepSource</th>
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
        </section>

        {/* Key differentiators */}
        <section className="mb-16">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-8">Why teams switch from DeepSource</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Fixes, not just findings",
                body: "DeepSource Autofix covers a subset of its own analysis rules. At the Scan + Fix tier ($199) and Forensic Scan ($399), GateTest's AI auto-fix covers everything it finds: security misconfigs, N+1 queries, accessibility violations, code quality issues, TypeScript strictness regressions — any issue GateTest detects, it can write a fix for and open as a PR.",
              },
              {
                title: "Pay for what you use",
                body: "DeepSource charges a monthly subscription per seat. A 10-person team might run 5 scans a month or 500 — the bill is the same. GateTest charges per result: $99 for all 121 modules per scan. Scan before releases, scan after major features, scan daily — you control the spend.",
              },
              {
                title: "Coverage beyond code quality",
                body: "DeepSource focuses on code quality and security. GateTest adds visual regression (screenshot comparison between deploys), mutation testing (validates your tests actually catch bugs), chaos testing — both via the GitHub Action, which has a CI runner and headless browser to drive them — performance analysis, accessibility audits, and AI safety scanning — dimensions no static analyzer covers.",
              },
              {
                title: "Faster synchronous results",
                body: "DeepSource runs asynchronously — you push, wait for the background scan to complete, then check the dashboard. GateTest returns results synchronously within the CI window: commit status posted, PR comment added, full report available before your CI pipeline finishes.",
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
            Find issues. Fix issues. Ship faster.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            121 modules and AI-powered review on Full ($99) and above. AI auto-fix PRs at Scan + Fix ($199) and Forensic Scan ($399). One-time payment per scan.
          </p>
          <Link
            href="/playground"
            className="btn-cta inline-flex items-center justify-center px-8 py-4"
          >
            Scan My Repo — From $29
          </Link>
          <p className="text-muted text-xs mt-6">
            One-time payment per scan via Stripe — scan tiers never auto-renew. Continuous ($49/mo) and hosted MCP ($29/mo) are optional monthly plans.
          </p>
        </section>
        <ComparisonReviewed slug="deepsource" />
      </div>
    </main>
  );
}
