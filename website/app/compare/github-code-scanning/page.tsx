import type { Metadata } from "next";
import Link from "next/link";
import ComparisonReviewed from "@/app/components/ComparisonReviewed";
import PageHero from "../../components/site/PageHero";
import { TOTAL_MODULES } from "@/app/lib/module-count";

export const metadata: Metadata = {
  title: "GateTest vs GitHub Code Scanning — The Complete QA Platform",
  description:
    `GitHub Code Scanning covers security basics. GateTest covers ${TOTAL_MODULES} quality dimensions: security, performance, accessibility, AI safety, visual regression, chaos testing (via GitHub Action), and auto-fix at the Scan + Fix tier and above.`,
  keywords: [
    "GitHub Code Scanning alternative",
    "GitHub Advanced Security alternative",
    "CodeQL alternative",
    "beyond GitHub security",
    "complete QA platform",
    "GateTest vs GitHub",
    "GHAS alternative",
  ],
  alternates: {
    canonical: "/compare/github-code-scanning",
  },
  openGraph: {
    title: "GateTest vs GitHub Code Scanning — The Complete QA Platform",
    description:
      `GitHub Code Scanning covers security basics. GateTest covers ${TOTAL_MODULES} quality dimensions: security, performance, accessibility, AI safety, visual regression, chaos testing (via GitHub Action), and auto-fix at the Scan + Fix tier and above.`,
    url: "/compare/github-code-scanning",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "Does GateTest work alongside GitHub Code Scanning, or replace it?",
    a: "GateTest can replace GitHub Code Scanning entirely — it posts the same commit statuses, creates the same PR comments, and covers all the security patterns CodeQL finds plus 60+ additional quality dimensions. If you already have GHAS and want to keep it, GateTest adds everything GitHub Code Scanning doesn't cover (performance, accessibility, visual regression, chaos testing via the GitHub Action, AI code review, and more).",
  },
  {
    q: "GitHub Code Scanning is included in my GitHub plan. Why would I pay extra for GateTest?",
    a: "GitHub Code Scanning (CodeQL) is a security-only tool with a well-defined scope: known vulnerability patterns in your code. It has zero coverage of performance, accessibility, visual regression, mutation testing (GateTest ships this via the GitHub Action), AI safety, N+1 queries, datetime bugs, money/float precision, feature flag hygiene, or any of the 40+ other dimensions GateTest covers. The cost of one accessibility lawsuit, one performance-related churn, or one money-float audit exceeds a year of GateTest scans.",
  },
  {
    q: "Does GateTest post commit statuses and PR comments like GitHub Code Scanning does?",
    a: "Yes — identical workflow integration. Install the GateTest GitHub App once, and every push gets a commit status (pass/fail) with a link to the full report. Every PR gets a formatted comment with per-module results, severity counts, file references, and line numbers. The developer workflow is indistinguishable from GitHub Code Scanning — but with 121 modules instead of CodeQL's security-only scope.",
  },
  {
    q: "GitHub Code Scanning is free for public repos. Does GateTest offer anything similar?",
    a: "Yes, two things are free: the preview scan on this site (4 modules, no account) and the local CLI, which runs every module on your own machine. Hosted scans are per scan ($29 quick / $99 full, every applicable module of 121) with no per-seat billing — a public-repo open-source project pays exactly the same as an enterprise. $99 for a full scan including AI code review is substantially cheaper than what GitHub Advanced Security costs at enterprise scale.",
  },
  {
    q: "Does GateTest work with repos on git hosts other than GitHub?",
    a: "Yes. GateTest was built with a host-agnostic HostBridge abstraction. It supports GitHub natively and Gluecron via the Signal Bus. Support for additional git hosts is in the roadmap. GitHub Code Scanning is GitHub-exclusive.",
  },
  {
    q: "Can GateTest auto-fix the issues it finds?",
    a: "Yes. The Scan + Fix tier ($199) creates a pull request with code changes that fix the issues found. GitHub Code Scanning shows you security alerts and leaves fixing to you. GateTest writes the fix. The Forensic Scan tier ($399) adds Claude-driven per-finding diagnosis, cross-finding attack-chain correlation, a board-ready CISO report, and a CTO-readable executive summary. Mutation testing and chaos / fuzz pass also ship via the GitHub Action (mutation: true / chaos: true) — runs wherever your CI runs.",
  },
];

const comparisonRows = [
  { feature: "Security vulnerability detection", gatetest: true, competitor: true },
  { feature: "AI code review (semantic bug detection)", gatetest: true, competitor: false },
  { feature: "Auto-fix pull requests", gatetest: true, competitor: false },
  { feature: "Performance analysis", gatetest: true, competitor: false },
  { feature: "Accessibility scanning (WCAG 2.2, AA + AAA-aligned)", gatetest: true, competitor: false },
  { feature: "Visual regression testing", gatetest: true, competitor: false },
  { feature: "Mutation testing (via GitHub Action)", gatetest: true, competitor: false },
  { feature: "Chaos testing (via GitHub Action)", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Race condition / TOCTOU detection", gatetest: true, competitor: false },
  { feature: "Prompt / LLM safety scanning", gatetest: true, competitor: false },
  { feature: "Works with non-GitHub git hosts", gatetest: true, competitor: false },
  { feature: "Pay per scan (no per-seat licensing)", gatetest: true, competitor: false },
  { feature: `${TOTAL_MODULES} scanning modules total`, gatetest: true, competitor: false },
  { feature: "PR / commit status integration", gatetest: true, competitor: true },
  { feature: "SARIF output format", gatetest: true, competitor: true },
];

export default function GitHubCodeScanningPage() {
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
            GateTest vs GitHub Code Scanning
            <br />
            <span className="text-accent">The Complete QA Platform</span>
          </>
        }
        lede={
          <>
            GitHub Code Scanning (CodeQL) is a well-engineered security tool with one job: finding
            known vulnerability patterns. It&rsquo;s good at that job. But security is one of {TOTAL_MODULES}
            quality dimensions your code needs — and GitHub Code Scanning covers exactly one of them.
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

        {/* Coverage gap visual */}
        <section className="mb-16">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-6">What GitHub Code Scanning doesn&rsquo;t cover</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              { label: "Performance", items: ["Core Web Vitals", "Bundle size", "N+1 queries", "Lighthouse scores"] },
              { label: "Accessibility", items: ["WCAG 2.2 automated audit", "ARIA checks", "Color contrast", "Keyboard nav"] },
              { label: "Code Quality", items: ["Cyclomatic complexity", "Dead code", "Import cycles", "TypeScript strictness"] },
              { label: "Reliability", items: ["Race conditions", "Resource leaks", "Retry hygiene", "Error swallowing"] },
              { label: "AI Safety", items: ["Prompt injection", "Cost DoS (no max_tokens)", "Browser-exposed keys", "Deprecated models"] },
              { label: "Visual & UX", items: ["Screenshot regression", "Responsive layout", "Mutation testing (via Action)", "Chaos testing (via Action)"] },
            ].map((group) => (
              <div
                key={group.label}
                className="rounded-xl border border-red-500/15 p-4 bg-red-500/5"
              >
                <div className="text-danger text-xs font-semibold uppercase tracking-wider mb-3">
                  &#10007; GitHub CS misses: {group.label}
                </div>
                <ul className="text-xs text-muted space-y-1">
                  {group.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
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
                  <th className="text-center px-5 py-4 text-muted font-medium">GitHub Code Scanning</th>
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
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-8">The complete picture</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: `Same workflow, ${TOTAL_MODULES} modules of coverage`,
                body: "GateTest posts commit statuses and PR comments in exactly the same format as GitHub Code Scanning. The developer experience is identical — install the GitHub App, push code, see results on the PR. But instead of security-only CodeQL alerts, you get 121 modules: security, performance, accessibility, AI safety, visual regression, and more.",
              },
              {
                title: "AI code review CodeQL can't do",
                body: "CodeQL works from a database of query patterns. GateTest sends your code to Claude for semantic reasoning — understanding what the code intends, identifying logic bugs, spotting off-by-one errors in financial calculations, flagging race conditions in auth flows. Pattern databases can't catch logic errors. AI can.",
              },
              {
                title: "Auto-fix, not just alerts",
                body: "GitHub Code Scanning shows you security alerts. You investigate, understand the issue, write the fix, test it. GateTest writes the fix and opens a pull request. The Scan + Fix tier covers both finding and fixing — security issues, code quality problems, configuration misconfigurations. The Forensic Scan tier adds attack-chain correlation, a board-ready CISO report, and a CTO-readable executive summary on top. Mutation testing and chaos / fuzz pass also ship via the GitHub Action where a CI runner is present.",
              },
              {
                title: "Host-agnostic by design",
                body: "GitHub Code Scanning is permanently tied to GitHub. GateTest's HostBridge architecture means it works across git hosts — GitHub today, Gluecron and others as the ecosystem evolves. If you ever migrate away from GitHub, your quality gate moves with you.",
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
            Security is just the beginning.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            Get {TOTAL_MODULES} quality dimensions in one scan — security, performance, accessibility, AI safety,
            visual regression, and more. Same PR workflow as GitHub Code Scanning.
          </p>
          <Link
            href="/playground"
            className="btn-cta inline-flex items-center justify-center px-8 py-4"
          >
            Scan My Repo — From $29
          </Link>
          <p className="text-muted text-xs mt-6">
            One-time charge at checkout for scan tiers — no per-seat licensing. Continuous ($49/mo, org-flat) is the optional every-push plan.
          </p>
        </section>
        <ComparisonReviewed slug="github-code-scanning" />
      </div>
    </main>
  );
}
