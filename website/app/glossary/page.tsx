import type { Metadata } from "next";
import Link from "next/link";
import { GLOSSARY } from "./glossary-catalog";
import {
  contentMetadata,
  collectionPageSchema,
  breadcrumbSchema,
  jsonLd,
} from "../lib/seo/schema";

export const metadata: Metadata = contentMetadata({
  title: "Software Quality & Security Glossary | GateTest",
  description:
    "Plain-English definitions of the software quality and application-security terms developers actually search for — SAST, DAST, SCA, SARIF, quality gates, mutation testing, SBOM, and more, grounded in how GateTest scans for them.",
  path: "/glossary",
  keywords: [
    "software security glossary",
    "application security terms",
    "code quality glossary",
    "what is SAST",
    "what is DAST",
    "what is SCA",
  ],
});

export default function GlossaryIndexPage() {
  const items = GLOSSARY.map((g) => ({ name: g.term, path: `/glossary/${g.slug}` }));

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(collectionPageSchema({ name: "GateTest Software Quality & Security Glossary", description: "Definitions of the software quality and application-security terms developers search for.", path: "/glossary", items })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Glossary" }])) }} />

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
            120 modules &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Glossary</span>
        </nav>

        <div className="mb-12 max-w-2xl">
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-5">
            Software quality &amp; security glossary
          </h1>
          <p className="text-lg text-white/70 leading-relaxed">
            The terms that show up in every security review and every AI-generated
            pull request — defined in plain English, and tied back to exactly how
            GateTest scans for them.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {GLOSSARY.map((g) => (
            <Link key={g.slug} href={`/glossary/${g.slug}`} className="block rounded-xl border border-white/[0.08] p-5 hover:border-teal-500/30 transition-colors" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center gap-2 mb-2">
                {g.abbreviation && (
                  <span className="text-xs font-mono text-teal-300/80 px-2 py-0.5 rounded bg-teal-500/10 border border-teal-500/20">{g.abbreviation}</span>
                )}
                <h2 className="text-white font-semibold leading-snug">{g.term}</h2>
              </div>
              <p className="text-white/55 text-sm leading-relaxed">{g.shortDef.slice(0, 140)}{g.shortDef.length > 140 ? "…" : ""}</p>
            </Link>
          ))}
        </div>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/use-cases" className="hover:text-white/60 transition-colors">Use cases</Link>
            <Link href="/blog" className="hover:text-white/60 transition-colors">Blog</Link>
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
