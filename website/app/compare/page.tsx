import type { Metadata } from "next";
import Link from "next/link";
import {
  contentMetadata,
  collectionPageSchema,
  breadcrumbSchema,
  jsonLd,
} from "../lib/seo/schema";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

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
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(collectionPageSchema({ name: "GateTest comparisons", description: "Honest comparisons of GateTest against the tools it replaces or complements.", path: "/compare", items })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Compare" }])) }} />

      <PageHero
        eyebrow="Compare"
        title="How GateTest compares"
        lede={
          <>
            Most teams duct-tape several quality and security tools together. Here&apos;s
            an honest look at where GateTest replaces them, where it complements them,
            and where the alternative is genuinely the right call.
          </>
        }
      />

      <Section>
        <div className="grid sm:grid-cols-2 gap-4">
          {COMPARISONS.map((c) => (
            <Link key={c.slug} href={`/compare/${c.slug}`} className="card block p-5">
              <h2 className="font-display text-foreground font-semibold leading-snug mb-1.5">GateTest <span className="text-muted">vs</span> {c.name}</h2>
              <p className="text-foreground-secondary text-sm leading-relaxed">{c.tagline}</p>
            </Link>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
          <Link href="/glossary" className="hover:text-foreground transition-colors">Glossary</Link>
          <Link href="/use-cases" className="hover:text-foreground transition-colors">Use cases</Link>
          <Link href="/modules" className="hover:text-foreground transition-colors">Modules</Link>
          <Link href="/#pricing" className="hover:text-foreground transition-colors">Pricing</Link>
        </div>
      </Section>
    </main>
  );
}
