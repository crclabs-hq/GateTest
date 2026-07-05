import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GateTest vs Semgrep — 120 modules vs pattern matching in 2026",
  description:
    "Semgrep matches known patterns. GateTest reasons about your code — 120 modules covering security, quality, accessibility, AI safety, and infra in a single scan. Auto-fix PRs included.",
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
    canonical: "https://gatetest.ai/compare/semgrep",
  },
  openGraph: {
    title: "GateTest vs Semgrep — 120 modules vs pattern matching in 2026",
    description:
      "Semgrep is excellent at finding patterns you wrote rules for. GateTest uses Claude to find what nobody wrote a rule for — plus 109 other checks — and opens a fix PR.",
    url: "https://gatetest.ai/compare/semgrep",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "How does GateTest differ from Semgrep?",
    a: "Semgrep is a pattern-matching engine: it finds code that matches rules written in YAML. It's fast and configurable, and the community has written thousands of rules. The gap is anything nobody wrote a rule for. GateTest uses Claude to read your actual code and reason about what it does — it finds SSRF in an API handler it has never seen before, because Claude understands intent, not just structure. GateTest also runs 110 checks across categories Semgrep doesn't cover: accessibility, performance, N+1 queries, datetime bugs, money-float errors, import cycles, and infra (Dockerfile, K8s, Terraform, CI pipelines).",
  },
  {
    q: "Does Semgrep have auto-fix?",
    a: "Semgrep can apply fix: patterns defined in rules — automated text substitutions paired with the matched pattern. These work for simple, predictable transformations (rename this function call, add this import). They don't work for complex contextual fixes that require understanding the surrounding code. GateTest's Scan + Fix tier ($199) uses Claude to write the actual fix logic — adds the validation guard, restructures the N+1 loop, fixes the datetime call with the correct timezone — and opens a pull request for your review. The fix is code Claude wrote, not a text substitution.",
  },
  {
    q: "What does Semgrep's free tier include vs. paid?",
    a: "Semgrep OSS (open-source core) is free and powerful for security engineers who want to write or import custom rules. Semgrep Code (SAST), Supply Chain (SCA), and Secrets are commercial products with seat-based pricing. GateTest charges per scan: $99 for all 120 modules. No rules to write, no per-developer licensing, no annual contracts.",
  },
  {
    q: "Does GateTest replace Semgrep rules I've already written?",
    a: "GateTest is complementary if you have custom business-logic rules that are deeply specific to your codebase. For the standard vulnerability classes — SSRF, TLS bypass, PII in logs, N+1 queries, insecure cookies, ReDoS, import cycles — GateTest covers them out of the box with modules that reason about your specific code rather than matching patterns. The practical question is whether you spend time maintaining a rule library or buy 110 maintained checks per scan.",
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
    <div className="min-h-screen" style={{ background: "#0a0a12" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm font-mono">G</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-white">
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>
          <Link href="/" className="text-sm text-white/50 hover:text-white transition-colors">
            &larr; Back to GateTest
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Compare</span>
          <span>/</span>
          <span className="text-white/60">Semgrep</span>
        </nav>

        {/* Hero */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            Tool Comparison
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            GateTest vs Semgrep
            <br />
            <span className="text-teal-400">120 modules vs Writing Rules in 2026</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            Semgrep is great at finding code that matches patterns you&rsquo;ve written rules for.
            The gap is the bug nobody wrote a rule for yet — the SSRF in a handler that&rsquo;s shaped
            differently, the race condition in a new ORM, the N+1 query introduced last Tuesday.
            GateTest uses Claude to read intent, not patterns.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 mt-8">
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Scan My Repo — From $29
            </Link>
            <Link
              href="/#modules"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
            >
              See All 120 modules
            </Link>
          </div>
        </div>

        {/* The core gap */}
        <section className="mb-16 rounded-xl border border-amber-500/20 p-6" style={{ background: "rgba(245,158,11,0.05)" }}>
          <h2 className="text-lg font-semibold text-amber-300 mb-3">The gap pattern-matching can&rsquo;t close</h2>
          <p className="text-white/60 text-sm mb-4">
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
              <div key={item} className="flex items-start gap-2 text-sm text-white/55">
                <span className="text-red-400/70 shrink-0 mt-0.5">&#10007;</span>
                <span className="text-xs text-white/50">{item}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Comparison table */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-6">Feature Comparison</h2>
          <div className="rounded-xl border border-white/[0.08] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.08]" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <th className="text-left px-5 py-4 text-white/50 font-medium">Feature</th>
                  <th className="text-center px-5 py-4 text-teal-400 font-semibold">GateTest</th>
                  <th className="text-center px-5 py-4 text-white/40 font-medium">Semgrep</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr
                    key={row.feature}
                    className="border-b border-white/[0.05] last:border-0 hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-5 py-3.5 text-white/70">{row.feature}</td>
                    <td className="px-5 py-3.5 text-center">
                      {row.gatetest ? (
                        <span className="text-emerald-400 font-bold text-base">&#10003;</span>
                      ) : (
                        <span className="text-white/20">&#8212;</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {row.competitor ? (
                        <span className="text-emerald-400/60 font-bold text-base">&#10003;</span>
                      ) : (
                        <span className="text-red-400/60">&#10007;</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-white/30 mt-3 px-1">
            Semgrep OSS covers pattern-matching SAST. Semgrep Code / Supply Chain / Secrets are separate paid products.
          </p>
        </section>

        {/* Key differentiators */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">Why GateTest goes further</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                title: "Reasoning vs. pattern matching",
                body: "Semgrep matches code that looks like a known bad pattern. Claude reads your code and understands what it does — so it finds the SSRF that's shaped differently from any rule, the race condition in a new ORM, the N+1 in a loop structure nobody thought to write a rule for. The gap between 'matches pattern' and 'is actually dangerous' is where most real bugs live.",
              },
              {
                title: "110 categories vs. one",
                body: "Semgrep is a SAST engine — security and code quality. GateTest covers those plus accessibility (WCAG 2.2), performance, IaC security (Terraform, K8s, Dockerfile, CI pipelines), dependency hygiene, datetime bugs, money-float errors, import cycles, PII in logs, prompt injection, and more. One gate, one config, one bill.",
              },
              {
                title: "Auto-fix PRs — not text substitutions",
                body: "Semgrep's fix: patterns are text substitutions. GateTest's Scan + Fix tier ($199) uses Claude to write the actual fix logic — adds the SSRF validation guard, restructures the N+1 query into a batched lookup, fixes the datetime call with the correct timezone — then opens a pull request for your review. It's an engineer writing a fix, not a sed replacement.",
              },
              {
                title: "No rules to maintain",
                body: "Semgrep's value scales with your rule library. You either write custom rules (takes time) or use community rules (may be stale). GateTest's 120 modules are maintained for you — and Claude-driven reasoning improves with every scan through the recipe-distillation flywheel. Per-scan pricing means no maintenance overhead.",
              },
            ].map((card) => (
              <div
                key={card.title}
                className="rounded-xl p-5 border border-white/[0.08]"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <h3 className="text-white font-semibold mb-2">{card.title}</h3>
                <p className="text-white/55 text-sm leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">Frequently asked questions</h2>
          <div className="space-y-4">
            {faqItems.map((item) => (
              <div
                key={item.q}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <h3 className="text-white font-semibold mb-3 leading-snug">{item.q}</h3>
                <p className="text-white/55 text-sm leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-4">
            110 checks. No rules to write.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Security, quality, accessibility, performance, IaC, AI safety — in one scan. Claude
            finds what no pattern covers. One-time payment per scan.
          </p>
          <Link
            href="/"
            className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            Scan My Repo — From $29
          </Link>
          <p className="text-white/30 text-xs mt-6">
            One-time payment per scan via Stripe. No subscription, no auto-renew.
          </p>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8 mt-16">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/legal/terms" className="hover:text-white/60 transition-colors">Terms</Link>
            <Link href="/legal/privacy" className="hover:text-white/60 transition-colors">Privacy</Link>
            <Link href="/legal/refunds" className="hover:text-white/60 transition-colors">Refunds</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
