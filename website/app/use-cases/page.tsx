import type { Metadata } from "next";
import Link from "next/link";
import { USE_CASES } from "./use-cases-catalog";
import {
  contentMetadata,
  collectionPageSchema,
  breadcrumbSchema,
  jsonLd,
} from "../lib/seo/schema";

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
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(collectionPageSchema({ name: "GateTest use cases", description: "Concrete jobs GateTest does in CI and at the pull request.", path: "/use-cases", items })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Use cases" }])) }} />

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
          <Link href="/glossary" className="text-sm text-white/50 hover:text-white transition-colors">
            Glossary &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Use cases</span>
        </nav>

        <div className="mb-12 max-w-2xl">
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-5">What you can gate with GateTest</h1>
          <p className="text-lg text-white/70 leading-relaxed">
            GateTest is one automated gate between your code and your main branch.
            Here&apos;s the work it actually does — each with the config to wire it up.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {USE_CASES.map((u) => (
            <Link key={u.slug} href={`/use-cases/${u.slug}`} className="block rounded-xl border border-white/[0.08] p-5 hover:border-teal-500/30 transition-colors" style={{ background: "rgba(255,255,255,0.02)" }}>
              <h2 className="text-white font-semibold leading-snug mb-1.5">{u.title}</h2>
              <p className="text-teal-200/60 text-xs mb-2">{u.intent}</p>
              <p className="text-white/55 text-sm leading-relaxed">{u.shortDef.slice(0, 130)}{u.shortDef.length > 130 ? "…" : ""}</p>
            </Link>
          ))}
        </div>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/glossary" className="hover:text-white/60 transition-colors">Glossary</Link>
            <Link href="/blog" className="hover:text-white/60 transition-colors">Blog</Link>
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
