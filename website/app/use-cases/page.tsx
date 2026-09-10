import type { Metadata } from "next";
import Link from "next/link";
import { USE_CASES } from "./use-cases-catalog";
import {
  contentMetadata,
  collectionPageSchema,
  breadcrumbSchema,
  jsonLd,
} from "../lib/seo/schema";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

export const metadata: Metadata = contentMetadata({
  title: "Use cases — what you can gate with GateTest",
  description:
    "Concrete jobs GateTest does: block pull requests on security findings, add a CI/CD quality gate, auto-fix vulnerabilities with an AI PR, scan a monorepo, gate on risky dependencies, and surface findings in GitHub code scanning.",
  path: "/use-cases",
  keywords: [
    "block pr on security findings",
    "ci cd quality gate",
    "auto-fix vulnerabilities",
    "monorepo security scanning",
    "github code scanning sarif",
  ],
});

export default function UseCasesIndexPage() {
  const items = USE_CASES.map((u) => ({ name: u.title, path: `/use-cases/${u.slug}` }));

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(collectionPageSchema({ name: "GateTest use cases", description: "Concrete jobs GateTest does in CI and at the pull request.", path: "/use-cases", items })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Use cases" }])) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">Use cases</span>
        </nav>
      </div>

      <PageHero
        eyebrow="Use cases"
        title="What you can gate with GateTest"
        lede={
          <>
            GateTest is one automated gate between your code and your main branch.
            Here&apos;s the work it actually does — each with the config to wire it up.
          </>
        }
        actions={
          <Link href="/glossary" className="btn-secondary px-5 py-2.5 text-sm">
            Glossary &rarr;
          </Link>
        }
      />

      <Section>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {USE_CASES.map((u) => (
            <Link key={u.slug} href={`/use-cases/${u.slug}`} className="card block p-5">
              <h2 className="font-display text-foreground font-semibold leading-snug mb-1.5">{u.title}</h2>
              <p className="text-accent text-xs mb-2">{u.intent}</p>
              <p className="text-foreground-secondary text-sm leading-relaxed">{u.shortDef.slice(0, 130)}{u.shortDef.length > 130 ? "…" : ""}</p>
            </Link>
          ))}
        </div>
      </Section>
    </main>
  );
}
