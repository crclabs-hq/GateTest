import type { Metadata } from "next";
import Link from "next/link";
import ComparisonReviewed from "@/app/components/ComparisonReviewed";
import PageHero from "../../components/site/PageHero";
import { TOTAL_MODULES } from "@/app/lib/module-count";

export const metadata: Metadata = {
  title: "GateTest vs SonarQube — The Smarter Alternative in 2026",
  description:
    `GateTest replaces SonarQube with ${TOTAL_MODULES} AI-powered modules, AI auto-fix PRs at the Scan + Fix tier and above, and per-scan pricing. No complex setup. No per-seat licensing. Just results.`,
  keywords: [
    "SonarQube alternative",
    "SonarQube vs GateTest",
    "better than SonarQube",
    "SonarQube replacement",
    "AI code quality",
    "automated code review",
    "static analysis alternative",
  ],
  alternates: {
    canonical: "/compare/sonarqube",
  },
  openGraph: {
    title: "GateTest vs SonarQube — The Smarter Alternative in 2026",
    description:
      `GateTest replaces SonarQube with ${TOTAL_MODULES} AI-powered modules, AI auto-fix PRs at the Scan + Fix tier and above, and per-scan pricing. No complex setup. No per-seat licensing.`,
    url: "/compare/sonarqube",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "Does GateTest replace SonarQube completely?",
    a: "Yes. GateTest covers everything SonarQube does — code quality, security patterns, technical debt, and duplication — plus 50+ modules SonarQube doesn't have: AI code review, visual regression, mutation testing (via the GitHub Action, which has a CI runner to drive it), accessibility (WCAG 2.2 AA + AAA-aligned automated audit), performance, Kubernetes manifest scanning, and more. One tool, one dashboard, one gate.",
  },
  {
    q: "How does GateTest pricing compare to SonarQube?",
    a: "SonarQube Cloud and Server are priced by lines of code — tiers jump as your codebase grows, so a 5% increase in LOC can move you up a whole tier. SonarQube Community Build is free but you run (and upgrade, back up and tune) the server yourself. GateTest charges per scan — $29 for a quick scan, $99 for the full engine, charged once at checkout. No server to maintain, no LOC tiers, no annual contracts.",
  },
  {
    q: "Does GateTest post commit statuses and PR comments like SonarQube does?",
    a: "Yes. Install the GateTest GitHub App and every push gets a commit status (pass/fail) and every PR gets a formatted comment with per-module results, severity counts, and direct links to the issues. Identical workflow integration — better results.",
  },
  {
    q: "Is GateTest harder to set up than SonarQube?",
    a: "Dramatically easier. SonarQube requires running a server, configuring sonar-project.properties, setting up a scanner in CI, and managing database migrations. GateTest is zero-config: paste your repo URL, pay, get results. The GitHub App auto-scans on every push with no configuration file required.",
  },
  {
    q: "Does GateTest support languages other than JavaScript and TypeScript?",
    a: "Yes, with an honest caveat: GateTest is deepest on JavaScript/TypeScript. The 9 non-JS language modules (Python, Go, Rust, Java, Ruby, PHP, C#, Kotlin, Swift) are pattern-level checks — thinner than SonarQube's semantic per-language analyzers. Where GateTest wins is breadth per run: security, supply chain, a11y, performance, and AI-code checks all ship in the one $99 full scan.",
  },
  {
    q: "Can GateTest fix the issues it finds, like a PR suggestion?",
    a: "GateTest goes further than suggestions. The AI-powered auto-fix mode (Scan + Fix, $199) creates an actual pull request with working code changes. SonarQube shows you the issue; GateTest writes the fix. The Forensic Scan tier ($399) adds Claude-driven diagnosis per finding, attack-chain correlation across findings, a board-ready CISO report, and a CTO-readable executive summary. Mutation testing also ships via the GitHub Action with mutation: true — runs wherever your CI runs.",
  },
];

const comparisonRows = [
  { feature: `${TOTAL_MODULES} scanning modules`, gatetest: true, competitor: false },
  { feature: "AI code review (Claude)", gatetest: true, competitor: false },
  { feature: "Auto-fix pull requests", gatetest: true, competitor: false },
  { feature: "Pay per scan (not per seat)", gatetest: true, competitor: false },
  { feature: "Zero server setup", gatetest: true, competitor: false },
  { feature: "Accessibility scanning (WCAG 2.2, AA + AAA-aligned)", gatetest: true, competitor: false },
  { feature: "Visual regression testing", gatetest: true, competitor: false },
  { feature: "Mutation testing (via GitHub Action)", gatetest: true, competitor: false },
  { feature: "Kubernetes / Terraform / Dockerfile scanning", gatetest: true, competitor: true },
  { feature: "Prompt / LLM safety scanning", gatetest: true, competitor: false },
  { feature: "Per-scan pricing (no per-seat licensing, no annual contract)", gatetest: true, competitor: false },
  { feature: "Code smell & duplication detection", gatetest: true, competitor: true },
  { feature: "Security vulnerability detection", gatetest: true, competitor: true },
  { feature: "CI/CD integration", gatetest: true, competitor: true },
  { feature: "PR / commit status feedback", gatetest: true, competitor: true },
];

export default function SonarQubePage() {
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
            GateTest vs SonarQube
            <br />
            <span className="text-accent">The Smarter Alternative in 2026</span>
          </>
        }
        lede={
          <>
            SonarQube was built in 2006 — before AI, before cloud-native CI/CD, before modern
            security threats. GateTest is built for 2026: {TOTAL_MODULES} AI-powered modules, AI auto-fix PRs at the Scan + Fix tier ($199) and above,
            zero server setup, and per-scan pricing.
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

        {/* Comparison table */}
        <section className="mb-16">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-6">Feature Comparison</h2>
          <div className="rounded-xl border border-border overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-light">
                  <th className="text-left px-5 py-4 text-muted font-medium">Feature</th>
                  <th className="text-center px-5 py-4 text-accent font-semibold">GateTest</th>
                  <th className="text-center px-5 py-4 text-muted font-medium">SonarQube</th>
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
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-8">Why developers are switching</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "AI-native, not AI-bolted-on",
                body: "SonarQube added AI features to a 2006 rule engine. GateTest is built AI-first — Claude reads your actual code, understands context, and finds bugs that pattern matching misses. Real bugs, not rule violations.",
              },
              {
                title: "Auto-fix PRs, not just reports",
                body: "SonarQube tells you what's wrong and leaves you to fix it. At the Scan + Fix tier ($199) and Forensic Scan ($399), GateTest writes the fix and opens a pull request. You review, you merge. No debugging, no manual remediation, no guessing at the right fix.",
              },
              {
                title: "Zero server infrastructure",
                body: "SonarQube requires a running server, a database, and ongoing maintenance. SonarQube Cloud still requires sonar-project.properties and scanner configuration per project. GateTest: paste URL, get results. No config files, no servers, no ops burden.",
              },
              {
                title: "121 modules vs 1 focus",
                body: "SonarQube focuses on code quality and security patterns. GateTest covers those plus accessibility, visual regression, performance, mutation testing (via the GitHub Action, which has a CI runner to drive it), N+1 queries, race conditions, TLS misconfigs, PII in logs, homoglyph attacks, and 40+ more dimensions — all in one scan.",
              },
              {
                title: "Pay per scan, not per seat",
                body: "SonarQube pricing scales with lines of code — the more your codebase grows, the higher the tier. GateTest charges per result: $29 quick scan, $99 full-engine scan. A 2-million-line monorepo pays the same as a weekend project for the same scan.",
              },
              {
                title: "Faster feedback loop",
                body: "SonarQube quality gates can take minutes on large projects. GateTest quick scans complete in well under a minute; full 121-module scans typically complete in a few minutes. Every push gets fast feedback — no waiting for a background worker to catch up.",
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
            Ready to replace SonarQube?
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            Paste your repo URL and get a full 121-module scan in minutes. No server setup,
            no config files, no per-seat pricing. One-time payment per scan.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/playground"
              className="btn-cta inline-flex items-center justify-center px-8 py-4"
            >
              Scan My Repo — From $29
            </Link>
            <Link
              href="/"
              className="btn-secondary inline-flex items-center justify-center px-8 py-4"
            >
              See All Features
            </Link>
          </div>
          <p className="text-muted text-xs mt-6">
            One-time payment per scan via Stripe — scan tiers never auto-renew. Continuous ($49/mo) and hosted MCP ($29/mo) are optional monthly plans.
          </p>
        </section>
        <ComparisonReviewed slug="sonarqube" />
      </div>
    </main>
  );
}
