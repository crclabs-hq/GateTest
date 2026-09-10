import type { Metadata } from "next";
import Link from "next/link";
import ComparisonReviewed from "@/app/components/ComparisonReviewed";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import PageHero from "../../components/site/PageHero";

export const metadata: Metadata = {
  title: "GateTest vs Semgrep — 121 modules vs pattern matching in 2026",
  description:
    "Semgrep matches known patterns. GateTest reasons about your code — 121 modules covering security, quality, accessibility, AI safety, and infra in a single scan. Auto-fix PRs included.",
  keywords: [
    "Semgrep alternative",
    "Semgrep vs GateTest",
    "beyond pattern matching",
    "SAST with auto-fix",
    "AI code review alternative",
    "Semgrep replacement",
    "code security scanning 2026",
  ],
  alternates: {
    canonical: "/compare/semgrep",
  },
  openGraph: {
    title: "GateTest vs Semgrep — 121 modules vs pattern matching in 2026",
    description:
      `Semgrep is excellent at finding patterns you wrote rules for. GateTest uses Claude to find what nobody wrote a rule for — plus ${TOTAL_MODULES - 1} other checks — and opens a fix PR.`,
    url: "/compare/semgrep",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "How does GateTest differ from Semgrep?",
    a: "Semgrep is a pattern-matching engine: it finds code that matches rules written in YAML. It's fast and configurable, and the community has written thousands of rules. The gap is anything nobody wrote a rule for. GateTest uses Claude to read your actual code and reason about what it does — it finds SSRF in an API handler it has never seen before, because Claude understands intent, not just structure. GateTest also runs 121 checks across categories Semgrep doesn't cover: accessibility, performance, N+1 queries, datetime bugs, money-float errors, import cycles, and infra (Dockerfile, K8s, Terraform, CI pipelines).",
  },
  {
    q: "Does Semgrep have auto-fix?",
    a: "Semgrep can apply fix: patterns defined in rules — automated text substitutions paired with the matched pattern. These work for simple, predictable transformations (rename this function call, add this import). They don't work for complex contextual fixes that require understanding the surrounding code. GateTest's Scan + Fix tier ($199) uses Claude to write the actual fix logic — adds the validation guard, restructures the N+1 loop, fixes the datetime call with the correct timezone — and opens a pull request for your review. The fix is code Claude wrote, not a text substitution.",
  },
  {
    q: "What does Semgrep's free tier include vs. paid?",
    a: "Semgrep OSS (open-source core) is free and powerful for security engineers who want to write or import custom rules. Semgrep Code (SAST), Supply Chain (SCA), and Secrets are commercial products with seat-based pricing. GateTest charges per scan: $99 for all 121 modules. No rules to write, no per-developer licensing, no annual contracts.",
  },
  {
    q: "Does GateTest replace Semgrep rules I've already written?",
    a: `GateTest is complementary if you have custom business-logic rules that are deeply specific to your codebase. For the standard vulnerability classes — SSRF, TLS bypass, PII in logs, N+1 queries, insecure cookies, ReDoS, import cycles — GateTest covers them out of the box with modules that reason about your specific code rather than matching patterns. The practical question is whether you spend time maintaining a rule library or buy ${TOTAL_MODULES} maintained checks per scan.`,
  },
  {
    q: "Does GateTest find injection vulnerabilities like Semgrep?",
    a: "Yes. GateTest's SSRF module traces user-controlled input (req.body, req.query, req.params, event.body) through to HTTP client calls (fetch, axios, got, http.request, undici) and flags unvalidated paths. The taint flow is semantic, not pattern-matched — it understands variable aliasing and function returns, not just surface-level string proximity. The same reasoning applies to command injection surfaces. On the Forensic Scan tier ($399), Claude-driven cross-finding correlation can identify chains: 'missing input validation here combines with this overly-permissive IAM role to form a realistic SSRF → privilege-escalation path.'",
  },
  {
    q: "How does GateTest handle false positives?",
    a: "Pattern matchers like Semgrep tend to generate false positives when code matches a pattern structurally but is safe in context. GateTest modules are built with explicit suppression paths: test files downgrade severity, known-safe patterns (e.g. SSRF modules suppress on validateUrl/allowedHosts.includes guards, money-float suppresses when a decimal library is imported). Claude-driven findings on the Forensic Scan tier include reasoning, so you can see why a finding was flagged — not just a rule ID. The confidence-calibrator trainer tracks customer suppressions and flags rules with high dismissal rates as candidates for severity downgrades.",
  },
];

const comparisonRows = [
  { feature: "Finds known vulnerability patterns (OWASP rules)", gatetest: true, competitor: true },
  { feature: "Semantic taint-flow analysis (multi-file)", gatetest: true, competitor: false },
  { feature: "AI reasoning — finds bugs no rule covers", gatetest: true, competitor: false },
  { feature: "Auto-fix PR (working code, not text substitution)", gatetest: true, competitor: false },
  { feature: "Dependency / SCA scanning", gatetest: true, competitor: true },
  { feature: "IaC security (Terraform, K8s, Dockerfile, CI)", gatetest: true, competitor: false },
  { feature: "Accessibility (WCAG 2.2 automated audit)", gatetest: true, competitor: false },
  { feature: "N+1 query detection", gatetest: true, competitor: false },
  { feature: "Datetime timezone bug detection", gatetest: true, competitor: false },
  { feature: "Money-float safety (parseFloat on currency)", gatetest: true, competitor: false },
  { feature: "Import cycle / circular dependency detection", gatetest: true, competitor: false },
  { feature: "PII-in-logs detection", gatetest: true, competitor: false },
  { feature: "Prompt injection / AI-app safety scanning", gatetest: true, competitor: false },
  { feature: "Mutation testing (via GitHub Action)", gatetest: true, competitor: false },
  { feature: "Cross-finding attack-chain correlation", gatetest: true, competitor: false },
  { feature: "Pay per scan (no rules to maintain)", gatetest: true, competitor: false },
  { feature: "PR / commit status integration", gatetest: true, competitor: true },
];

export default function SemgrepPage() {
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
            GateTest vs Semgrep
            <br />
            <span className="text-accent">121 modules vs Writing Rules in 2026</span>
          </>
        }
        lede={
          <>
            Semgrep is great at finding code that matches patterns you&rsquo;ve written rules for.
            The gap is the bug nobody wrote a rule for yet — the SSRF in a handler that&rsquo;s shaped
            differently, the race condition in a new ORM, the N+1 query introduced last Tuesday.
            GateTest uses Claude to read intent, not patterns.
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

        {/* The core gap */}
        <section className="mb-16 rounded-2xl border border-amber-500/20 p-6 bg-amber-500/5">
          <h2 className="text-lg font-semibold text-warning mb-3">The gap pattern-matching can&rsquo;t close</h2>
          <p className="text-foreground-secondary text-sm mb-4">
            Semgrep needs a rule to find a bug. These real bug classes ship every week — and no pattern covers them all:
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            {[
              "N+1: await repo.find() nested in a .map() with a different ORM every time",
              "Race condition: check-then-act spread across 3 functions",
              "Money-float: parseFloat(req.body.amount) anywhere on a payment path",
              "Datetime: new Date(year, month, day) — JS months are 0-indexed",
              "Circular import: A imports B imports C imports A — undefined at runtime",
              "Stale feature flag: const FEATURE_X = true hardcoded for 6 months",
              "TLS bypass: rejectUnauthorized: false buried in a config helper",
              "PII leak: console.log(user) — 'user' is a generic name Semgrep rules miss",
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
                  <th className="text-center px-5 py-4 text-muted font-medium">Semgrep</th>
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
            Semgrep OSS covers pattern-matching SAST. Semgrep Code / Supply Chain / Secrets are separate paid products.
          </p>
        </section>

        {/* Key differentiators */}
        <section className="mb-16">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-8">Why GateTest goes further</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Reasoning vs. pattern matching",
                body: "Semgrep matches code that looks like a known bad pattern. Claude reads your code and understands what it does — so it finds the SSRF that's shaped differently from any rule, the race condition in a new ORM, the N+1 in a loop structure nobody thought to write a rule for. The gap between 'matches pattern' and 'is actually dangerous' is where most real bugs live.",
              },
              {
                title: `${TOTAL_MODULES} categories vs. one`,
                body: "Semgrep is a SAST engine — security and code quality. GateTest covers those plus accessibility (WCAG 2.2), performance, IaC security (Terraform, K8s, Dockerfile, CI pipelines), dependency hygiene, datetime bugs, money-float errors, import cycles, PII in logs, prompt injection, and more. One gate, one config, one bill.",
              },
              {
                title: "Auto-fix PRs — not text substitutions",
                body: "Semgrep's fix: patterns are text substitutions. GateTest's Scan + Fix tier ($199) uses Claude to write the actual fix logic — adds the SSRF validation guard, restructures the N+1 query into a batched lookup, fixes the datetime call with the correct timezone — then opens a pull request for your review. It's an engineer writing a fix, not a sed replacement.",
              },
              {
                title: "No rules to maintain",
                body: "Semgrep's value scales with your rule library. You either write custom rules (takes time) or use community rules (may be stale). GateTest's 121 modules are maintained for you — and Claude-driven reasoning improves with every scan through the recipe-distillation flywheel. Per-scan pricing means no maintenance overhead.",
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
            121 checks. No rules to write.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            Security, quality, accessibility, performance, IaC, AI safety — in one scan. Claude
            finds what no pattern covers. One-time payment per scan.
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
        <ComparisonReviewed slug="semgrep" />
      </div>
    </main>
  );
}
