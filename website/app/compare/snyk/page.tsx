import type { Metadata } from "next";
import Link from "next/link";
import ComparisonReviewed from "@/app/components/ComparisonReviewed";
import PageHero from "../../components/site/PageHero";
import { TOTAL_MODULES } from "@/app/lib/module-count";

export const metadata: Metadata = {
  title: "GateTest vs Snyk — One config, every QA tool in 2026",
  description:
    "Snyk ships separate Open Source, Code, Container, and IaC products. GateTest unifies those plus quality, performance, accessibility, and AI safety into a single config and a single bill — 121 modules, per-scan pricing.",
  keywords: [
    "Snyk alternative",
    "Snyk vs GateTest",
    "beyond dependency scanning",
    "code security scanning",
    "AI security review",
    "Snyk replacement",
    "source code security",
  ],
  alternates: {
    canonical: "/compare/snyk",
  },
  openGraph: {
    title: "GateTest vs Snyk — One config, every QA tool in 2026",
    description:
      "Snyk ships separate Open Source, Code, Container, and IaC products. GateTest unifies them — plus quality, performance, accessibility, and AI safety — into a single config and a single bill (121 modules).",
    url: "/compare/snyk",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "How does GateTest compare to Snyk's product family?",
    a: "Snyk covers dependencies (Open Source), code (Snyk Code SAST), containers (Snyk Container), and IaC (Snyk Infrastructure as Code) as four separately-licensed products. GateTest unifies those four areas into a single config plus a single bill, and adds the categories Snyk does not currently ship: AI code review for logic bugs, accessibility, performance, SEO, runtime-error capture, and mutation testing / chaos-fuzz scenarios (both via the GitHub Action, which has a CI runner and headless browser to drive them).",
  },
  {
    q: "Does GateTest also scan dependencies?",
    a: "Yes — GateTest includes a polyglot dependency scanner covering npm, pip, Pipenv, Poetry, go.mod, Cargo, Bundler, Composer, Maven, and Gradle. It flags wildcard pins, 'latest' dependencies, missing lockfiles, and deprecated packages. Dependency scanning is one module out of 121.",
  },
  {
    q: "How does GateTest pricing compare to Snyk?",
    a: "Snyk charges per developer seat per month — pricing scales with headcount and enterprise contracts can reach thousands monthly. GateTest charges per scan: $99 for all 121 modules. No seat licensing, no annual contracts, no per-developer billing. A 100-person team pays the same per scan as a solo developer.",
  },
  {
    q: "Does GateTest include AI-app safety scanning?",
    a: "Yes. GateTest's promptSafety module catches: browser-bundled API keys (NEXT_PUBLIC_* / VITE_* with AI keys), OpenAI/Anthropic calls without max_tokens limits (cost DoS vector), user-input interpolation in prompt templates without delimiters (injection surface), and deprecated AI models (claude-v1, text-davinci-*). Snyk does not advertise a dedicated AI / LLM safety SKU at time of writing.",
  },
  {
    q: "Can GateTest fix vulnerabilities automatically?",
    a: "Yes. The Scan + Fix tier ($199) uses AI to create pull requests with working code changes that address the issues found. Snyk can suggest fix PRs for dependency upgrades in its paid tiers; GateTest auto-fixes source code vulnerabilities — SSRF guards, TLS config fixes, cookie security flags, and more. The Forensic Scan tier ($399) adds Claude-driven diagnosis on every finding, cross-finding attack-chain correlation, a board-ready CISO report, and a CTO-readable executive summary. Mutation testing and chaos / fuzz pass also ship via the GitHub Action (mutation: true / chaos: true) — runs wherever your CI runs.",
  },
  {
    q: "Does GateTest work with private repos?",
    a: "Yes. GateTest scans private repos via the GitHub App (which you install once and grants scoped read-only access per repo) or via direct GitHub API with a PAT. All scans run server-side — your code is read for scanning and never stored permanently.",
  },
];

// Comparison rows — kept narrow to claims that are publicly verifiable
// against Snyk's current product pages (May 2026). Snyk Code does ship
// SAST and Snyk Container ships container scanning — both marked
// "competitor: true" below. The differentiator is unification and price
// model, not "Snyk has nothing."
const comparisonRows = [
  { feature: "Source code SAST", gatetest: true, competitor: true },
  { feature: "Dependency / SCA scanning", gatetest: true, competitor: true },
  { feature: "Container image scanning (OS packages / CVEs)", gatetest: false, competitor: true },
  { feature: "Dockerfile / Compose hardening rules", gatetest: true, competitor: true },
  { feature: "IaC scanning (Terraform / K8s)", gatetest: true, competitor: true },
  { feature: "AI code review for logic bugs (Claude-based)", gatetest: true, competitor: false },
  { feature: "Auto-fix PRs for non-dependency code bugs", gatetest: true, competitor: false },
  { feature: "Prompt injection / AI-app safety scanning", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Race condition / TOCTOU detection", gatetest: true, competitor: false },
  { feature: "PII-in-logs detection", gatetest: true, competitor: false },
  { feature: "Accessibility (WCAG 2.2 automated audit)", gatetest: true, competitor: false },
  { feature: "Performance analysis", gatetest: true, competitor: false },
  { feature: "Mutation testing (via GitHub Action)", gatetest: true, competitor: false },
  { feature: "Single config, single bill across all categories", gatetest: true, competitor: false },
  { feature: "Pay per scan (not per seat)", gatetest: true, competitor: false },
  { feature: "PR / commit status integration", gatetest: true, competitor: true },
];

export default function SnykPage() {
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
            GateTest vs Snyk
            <br />
            <span className="text-accent">Beyond Dependency Scanning in 2026</span>
          </>
        }
        lede={
          <>
            Snyk is excellent at finding known CVEs in your package.json. But the most dangerous
            bugs live in code <em>you wrote</em> — SSRF in your API handlers, N+1 queries in your
            loops, race conditions in your auth flows. Snyk can&rsquo;t see any of that.
            GateTest can.
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

        {/* What Snyk misses callout */}
        <section className="mb-16 rounded-2xl border border-amber-500/20 p-6 bg-amber-500/5">
          <h2 className="text-lg font-semibold text-warning mb-3">What Snyk can&rsquo;t scan</h2>
          <p className="text-foreground-secondary text-sm mb-4">
            Snyk scans your <code className="text-warning bg-amber-500/10 px-1.5 py-0.5 rounded text-xs">package.json</code> for known CVEs. It has zero visibility into your application code. These bugs are invisible to Snyk:
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            {[
              "SSRF: fetch(req.query.url) with no validation",
              "N+1: await db.find() inside a .map() loop",
              "Race condition: fs.exists() then fs.unlink()",
              "TLS bypass: rejectUnauthorized: false left in production",
              "PII leak: console.log(user) in your auth handler",
              "Prompt injection: template.replace('{input}', userMessage)",
              "Cookie vuln: httpOnly: false on session cookies",
              "ReDoS: (a+)+ regex exposed to user input",
            ].map((item) => (
              <div key={item} className="flex items-start gap-2 text-sm text-foreground-secondary">
                <span className="text-danger/70 shrink-0 mt-0.5">&#10007;</span>
                <code className="text-xs text-muted">{item}</code>
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
                  <th className="text-center px-5 py-4 text-muted font-medium">Snyk</th>
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
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-8">Why GateTest goes further</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Source code, not just manifests",
                body: "Snyk reads package.json and compares against CVE databases. GateTest reads your actual TypeScript, JavaScript, Python, and Go — and understands what your code does. That's the difference between 'this library has a known CVE' and 'your API handler passes user input directly to fetch()'.",
              },
              {
                title: "AI safety — the gap Snyk ignores",
                body: "GateTest's promptSafety module catches the new generation of AI app vulnerabilities: browser-exposed API keys, missing max_tokens limits that enable cost DoS attacks, prompt injection surfaces, and deprecated AI models. No other security tool covers this.",
              },
              {
                title: "Auto-fix for source code bugs",
                body: "Snyk can open a PR to bump a dependency version. At the Scan + Fix tier ($199) and Forensic Scan ($399), GateTest writes a fix for the source code bug — adds the SSRF validation guard, removes the TLS bypass, restructures the N+1 query into a batched lookup — and opens the PR for your review.",
              },
              {
                title: "One bill, 121 modules",
                body: "Snyk's seat-based pricing means security costs scale with team size. GateTest is $99 for all 121 modules per scan. Run it daily on a 100-person team or run it once before a major release — the price is the same.",
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
            One config across every QA category.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            Get 121 modules — dependencies, code, containers, IaC, AI safety, accessibility, performance,
            and more — in a single scan. One-time payment per scan.
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
        <ComparisonReviewed slug="snyk" />
      </div>
    </main>
  );
}
