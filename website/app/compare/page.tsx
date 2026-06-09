import type { Metadata } from "next";
import Link from "next/link";
import {
  contentMetadata,
  collectionPageSchema,
  breadcrumbSchema,
  jsonLd,
} from "../lib/seo/schema";

export const metadata: Metadata = contentMetadata({
  title: "GateTest vs SonarQube, Snyk, ESLint & more — comparisons",
  description:
    "Honest, side-by-side comparisons of GateTest against the tools it replaces or complements: SonarQube, Snyk, ESLint, GitHub code scanning, DeepSource, Semgrep, and CodeQL. What each does, where it wins, and where GateTest fits.",
  path: "/compare",
  keywords: [
    "sonarqube alternative",
    "snyk alternative",
    "eslint alternative",
    "semgrep alternative",
    "codeql alternative",
    "deepsource alternative",
    "github code scanning alternative",
  ],
});

const COMPARISONS: { slug: string; name: string; tagline: string }[] = [
  { slug: "sonarqube", name: "SonarQube", tagline: "Code quality & static analysis platform — self-hosted, seat-priced." },
  { slug: "snyk", name: "Snyk", tagline: "Developer-first security: SCA, SAST, container, and IaC scanning." },
  { slug: "eslint", name: "ESLint", tagline: "The JavaScript/TypeScript linter — style and a thin slice of correctness." },
  { slug: "github-code-scanning", name: "GitHub code scanning", tagline: "CodeQL-powered scanning wired into pull requests via SARIF." },
  { slug: "deepsource", name: "DeepSource", tagline: "Automated code review with Autofix recipes across several languages." },
  { slug: "semgrep", name: "Semgrep", tagline: "Fast, pattern-based static analysis with custom rules." },
  { slug: "codeql", name: "CodeQL", tagline: "GitHub's semantic code-analysis engine — query code like a database." },
];

export default function CompareIndexPage() {
  const items = COMPARISONS.map((c) => ({ name: `GateTest vs ${c.name}`, path: `/compare/${c.slug}` }));

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(collectionPageSchema({ name: "GateTest comparisons", description: "Honest comparisons of GateTest against the tools it replaces or complements.", path: "/compare", items })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Compare" }])) }} />

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
          <Link href="/modules" className="text-sm text-white/50 hover:text-white transition-colors">
            110 modules &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Compare</span>
        </nav>

        <div className="mb-12 max-w-2xl">
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-5">How GateTest compares</h1>
          <p className="text-lg text-white/70 leading-relaxed">
            Most teams duct-tape several quality and security tools together. Here&apos;s
            an honest look at where GateTest replaces them, where it complements them,
            and where the alternative is genuinely the right call.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {COMPARISONS.map((c) => (
            <Link key={c.slug} href={`/compare/${c.slug}`} className="block rounded-xl border border-white/[0.08] p-5 hover:border-teal-500/30 transition-colors" style={{ background: "rgba(255,255,255,0.02)" }}>
              <h2 className="text-white font-semibold leading-snug mb-1.5">GateTest <span className="text-white/40">vs</span> {c.name}</h2>
              <p className="text-white/55 text-sm leading-relaxed">{c.tagline}</p>
            </Link>
          ))}
        </div>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/glossary" className="hover:text-white/60 transition-colors">Glossary</Link>
            <Link href="/use-cases" className="hover:text-white/60 transition-colors">Use cases</Link>
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
