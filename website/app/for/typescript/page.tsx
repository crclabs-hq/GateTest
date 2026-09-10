import type { Metadata } from "next";
import Link from "next/link";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

export const metadata: Metadata = {
  title: "TypeScript Code Quality & Strict Mode Enforcement — GateTest",
  description:
    "GateTest enforces TypeScript strict mode, catches @ts-ignore abuse, detects any-type leaks, and flags tsconfig regressions before they reach production. AI auto-fix at the Scan + Fix tier and above.",
  keywords: [
    "TypeScript code quality",
    "TypeScript strict mode enforcement",
    "tsconfig scanning",
    "@ts-ignore detection",
    "TypeScript any type",
    "TypeScript CI gate",
    "TypeScript import cycles",
    "TypeScript security",
  ],
  alternates: {
    canonical: "/for/typescript",
  },
  openGraph: {
    title: "TypeScript Code Quality & Strict Mode Enforcement — GateTest",
    description:
      "GateTest enforces TypeScript strict mode, catches @ts-ignore abuse, detects any-type leaks, and flags tsconfig regressions before they reach production.",
    url: "/for/typescript",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "How does GateTest enforce TypeScript strict mode?",
    a: "GateTest's typescriptStrictness module walks every tsconfig.json in your project (including JSONC with // comments, tsconfig.app.json, tsconfig.node.json). It flags strict: false (error — disables all strict checks at once), noImplicitAny: false (error — allows untyped code), skipLibCheck: true (warning — hides type errors in dependencies), strictNullChecks: false (warning — allows null/undefined anywhere), and strictFunctionTypes: false (warning — breaks function parameter type safety).",
  },
  {
    q: "Can GateTest detect @ts-ignore abuse?",
    a: "Yes. The typescriptStrictness module flags @ts-nocheck at the file level (error — suppresses all type checking in that file) and @ts-ignore / @ts-expect-error annotations that have no explanatory comment on the same line (warning — a reason-less suppress is a ticking time bomb). Test files (*.test.ts, *.spec.ts) and declaration files (*.d.ts) are exempt — these legitimately need type flexibility.",
  },
  {
    q: "Does GateTest find unused TypeScript exports?",
    a: "Yes. The deadCode module detects exported symbols that nothing in the codebase imports, files that nothing imports, and commented-out code blocks of 10+ lines. It understands Next.js App Router conventions so page.tsx, layout.tsx, and route.ts exports are never false-positively flagged.",
  },
  {
    q: "How does GateTest detect circular imports in TypeScript projects?",
    a: "The importCycle module builds a dependency graph from your .ts and .tsx files — resolving relative specifiers through extension fallback and ./x/index.ts lookup. It uses Tarjan's strongly-connected-component algorithm to find every cycle of 2+ files. Type-only imports (import type, export type) are correctly excluded — they're erased at build time and can't cause runtime TDZ errors.",
  },
  {
    q: "Does GateTest catch async/await mistakes in TypeScript?",
    a: "Several modules cover this. asyncIteration catches .forEach(async ...) (warning — forEach doesn't await), .filter(async ...) (error — Promise is always truthy, predicate is meaningless), .reduce(async ...) (error — accumulator becomes a Promise chain), and .map(async ...) not wrapped in Promise.all (warning — unwrapped Promise array). errorSwallow catches fire-and-forget .save()/.send()/.commit() calls without await or .catch().",
  },
  {
    q: "Does GateTest detect money/float precision bugs in TypeScript?",
    a: "Yes. The moneyFloat module flags money-named variables (price, total, amount, tax, fee, subtotal, balance, and currency codes usd/eur/gbp/etc.) assigned from parseFloat() or Number() — both are IEEE-754 floating-point and will accumulate rounding errors in financial calculations. Safe if your file imports decimal.js, big.js, bignumber.js, or dinero.js.",
  },
];

const tsModules = [
  {
    name: "typescriptStrictness",
    checks: ["strict: false in tsconfig", "noImplicitAny: false", "@ts-nocheck (file-wide suppress)", "Unreasoned @ts-ignore", "Exported signatures with : any", "as any casts in source"],
  },
  {
    name: "importCycle",
    checks: ["Circular import chains (Tarjan SCC)", "Type-only imports correctly excluded", "Extension fallback resolution", "index.ts re-export cycles"],
  },
  {
    name: "deadCode",
    checks: ["Unused exported functions/classes", "Orphaned files (nothing imports)", "10+ line commented-out blocks", "Next.js App Router convention-aware"],
  },
  {
    name: "asyncIteration",
    checks: [".forEach(async ...) — swallowed promises", ".filter/.some/.every(async ...) — always truthy", ".reduce(async ...) — silent serialization", ".map(async ...) without Promise.all"],
  },
  {
    name: "errorSwallow",
    checks: ["Empty catch {} blocks", "catch blocks that only console.log", ".catch(() => {}) / .catch(noop)", "Fire-and-forget .save()/.send()/.commit()"],
  },
  {
    name: "moneyFloat",
    checks: ["parseFloat() on money-named variables", "Number() on price/total/amount", ".toFixed(0) / .toFixed(1) on money vars", "Safe if decimal.js / big.js imported"],
  },
];

const caughtExamples = [
  {
    code: '// tsconfig.json\n{ "compilerOptions": { "strict": false } }',
    module: "typescriptStrictness",
    severity: "error",
    fix: "Remove strict: false to re-enable all strict type checks",
  },
  {
    code: 'const cost = parseFloat(req.body.amount);\nthis.subtotal = parseFloat(rawAmount);', // money-float-ok — demo description
    module: "moneyFloat",
    severity: "error",
    fix: "Use Decimal or Big for financial calculations — IEEE-754 float loses cents at scale",
  },
  {
    code: 'users.forEach(async (user) => {\n  await sendEmail(user.email);\n});',
    module: "asyncIteration",
    severity: "warning",
    fix: "await Promise.all(users.map(async (user) => sendEmail(user.email)))",
  },
  {
    code: '// @ts-ignore\nconst result = dangerousFunction();',
    module: "typescriptStrictness",
    severity: "warning",
    fix: "Add explanation: // @ts-ignore: dangerousFunction is untyped — fix in #1234",
  },
];

const severityTone = (severity: string) =>
  severity === "error" ? "text-danger bg-danger/10 border-danger/20" : "text-warning bg-warning/10 border-warning/20";

const INLINE_CODE = "text-warning bg-warning/10 px-1 rounded text-xs";

export default function TypeScriptPage() {
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

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <Link href="/for" className="hover:text-foreground transition-colors">For</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">TypeScript</span>
        </nav>
      </div>

      <PageHero
        eyebrow="Language-specific scanning"
        title={
          <>
            TypeScript Code Quality
            <br />
            <span className="text-accent">&amp; Strict Mode Enforcement</span>
          </>
        }
        lede={
          <>
            TypeScript gives you a type system. GateTest makes sure it stays honest — catching
            tsconfig regressions, @ts-ignore abuse, any-type leaks, circular imports, async
            anti-patterns, and 60+ more failure modes before they reach production.
          </>
        }
        actions={
          <>
            <Link href="/" className="btn-cta px-6 py-3 text-sm">
              Scan My TypeScript Repo — From $29
            </Link>
            <Link href="/" className="btn-secondary px-6 py-3 text-sm">
              See All {TOTAL_MODULES} Modules
            </Link>
          </>
        }
      />

      <Section title="TypeScript-specific modules">
        {/* The strictness erosion problem */}
        <div className="mb-12 rounded-xl border border-warning/25 bg-warning/5 p-6">
          {/* fake-fix-ok — demo page showing examples of what GateTest catches */}
          <h3 className="font-display text-lg font-semibold text-warning mb-3">The strictness erosion problem</h3>
          <p className="text-foreground-secondary text-sm mb-4 leading-relaxed">
            TypeScript strict mode exists to catch a whole class of runtime errors at compile time.
            But it&rsquo;s trivially easy to erode: one PR adds <code className={INLINE_CODE}>{'// @ts-ignore'}</code> to unblock a merge,
            another sets <code className={INLINE_CODE}>skipLibCheck: true</code> to silence a noisy dependency,
            a third disables <code className={INLINE_CODE}>strictNullChecks</code> to speed up a deadline.
            Six months later, the type system is decorative.
          </p>
          <p className="text-foreground-secondary text-sm leading-relaxed">
            GateTest makes strictness erosion impossible to merge silently — every tsconfig regression
            is a gate failure that blocks the PR, and every reason-less suppression annotation surfaces
            as a warning on the diff.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          {tsModules.map((mod) => (
            <div key={mod.name} className="card p-5">
              <code className="text-accent text-sm font-mono block mb-3">{mod.name}</code>
              <ul className="space-y-1.5">
                {mod.checks.map((check) => (
                  <li key={check} className="flex items-start gap-2 text-xs text-foreground-secondary">
                    <span className="text-success shrink-0 mt-0.5" aria-hidden="true">&#10003;</span>
                    {check}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section alt title="What GateTest catches in TypeScript">
        <div className="space-y-4">
          {caughtExamples.map((item) => (
            <div key={item.code} className="card p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${severityTone(item.severity)}`}>{item.severity}</span>
                <code className="text-accent text-xs">{item.module}</code>
              </div>
              <pre className="text-xs font-mono bg-panel text-panel-foreground border border-panel-border rounded-lg p-3 mb-3 overflow-x-auto leading-relaxed">{item.code}</pre>
              <p className="text-muted text-xs">
                <span className="text-success">Fix: </span>{item.fix}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Frequently asked questions">
        <div className="space-y-4">
          {faqItems.map((item) => (
            <div key={item.q} className="card p-5">
              <h3 className="text-foreground font-semibold mb-3 leading-snug">{item.q}</h3>
              <p className="text-foreground-secondary text-sm leading-relaxed">{item.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section alt>
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 sm:p-10 text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-4">
            Keep TypeScript strict. Ship with confidence.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            Gate every PR against strictness regressions, circular imports, async anti-patterns, and 60+ more failure modes. One price per scan, no seats.
          </p>
          <Link href="/" className="btn-cta px-8 py-4">
            Scan My TypeScript Repo — From $29
          </Link>
          <p className="text-muted text-xs mt-6">
            One-time charge at checkout for per-scan tiers — no per-seat licensing. Continuous ($49/mo) is optional if you want every push scanned.
          </p>
        </div>
        <p className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
          <span>Also for:</span>
          <Link href="/for/nextjs" className="hover:text-accent transition-colors">Next.js</Link>
          <Link href="/for/nodejs" className="hover:text-accent transition-colors">Node.js</Link>
        </p>
      </Section>
    </main>
  );
}
