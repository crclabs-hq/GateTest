import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllCweSlugs,
  getCweBySlug,
  getRelatedCwes,
  type CweEntry,
} from "../cwe-catalog";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return getAllCweSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const cwe = getCweBySlug(slug);
  if (!cwe) {
    return { title: "CWE not found — GateTest" };
  }
  const title = `${cwe.name} (CWE-${cwe.id}) — how to detect + fix | GateTest`;
  const description = `${cwe.shortDesc} ${cwe.modules.length > 0 ? `Caught by GateTest's ${cwe.modules.join(", ")} module${cwe.modules.length === 1 ? "" : "s"}.` : "Not currently covered by GateTest."}`;
  const canonical = `https://gatetest.ai/find/${cwe.slug}`;
  return {
    title,
    description,
    keywords: [
      `CWE-${cwe.id}`,
      cwe.name.toLowerCase(),
      `how to detect ${cwe.name.toLowerCase()}`,
      `how to fix ${cwe.name.toLowerCase()}`,
      `${cwe.name.toLowerCase()} scanner`,
      `${cwe.name.toLowerCase()} static analysis`,
      ...cwe.modules.map((m) => `gatetest ${m}`),
    ],
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "GateTest",
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function CwePage({ params }: PageParams) {
  const { slug } = await params;
  const cwe = getCweBySlug(slug);
  if (!cwe) notFound();

  const related = getRelatedCwes(slug, 4);
  const covered = cwe.modules.length > 0;

  const faqs: { q: string; a: string }[] = [
    {
      q: `What is CWE-${cwe.id} (${cwe.name})?`,
      a: cwe.shortDesc,
    },
    {
      q: `How do I fix ${cwe.name.toLowerCase()}?`,
      a: cwe.remediation,
    },
    covered
      ? {
          q: `Does GateTest detect ${cwe.name.toLowerCase()}?`,
          a: `Yes — GateTest's ${cwe.modules.join(", ")} module${cwe.modules.length === 1 ? "" : "s"} catch this class. Findings appear in the standard scan output with file and line numbers. On Scan + Fix and Forensic Scan tiers, Claude opens a pull request with the fix.`,
        }
      : {
          q: `Does GateTest detect CWE-${cwe.id}?`,
          a: `Not directly today. GateTest focuses on web-stack languages (JavaScript, TypeScript, Python, Go, Java, Ruby, PHP) and infrastructure-as-code. ${cwe.name} is most relevant to ${slug.includes("buffer") || slug.includes("memory") || slug.includes("overflow") || slug.includes("null-pointer") || slug.includes("integer") || slug.includes("out-of-bounds") || slug.includes("use-after-free") ? "C / C++" : "lower-level"} code. For full coverage of this class, pair GateTest with CodeQL or a memory-safety analyzer.`,
        },
    {
      q: `What rank is ${cwe.name} in the CWE Top 25?`,
      a: `${cwe.name} is ranked #${cwe.rank} in the MITRE 2023 CWE Top 25 Most Dangerous Software Weaknesses list. The ranking reflects both prevalence (how often it appears in real CVEs) and severity (the typical impact when it's exploited).`,
    },
  ];

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  const techArticleJsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: `${cwe.name} (CWE-${cwe.id}) — detection and remediation`,
    description: cwe.shortDesc,
    author: { "@type": "Organization", name: "GateTest" },
    publisher: { "@type": "Organization", name: "GateTest", url: "https://gatetest.ai" },
    mainEntityOfPage: `https://gatetest.ai/find/${cwe.slug}`,
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(techArticleJsonLd) }} />

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
          <Link href="/find" className="text-sm text-white/50 hover:text-white transition-colors">
            CWE Top 25 &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-4xl mx-auto">
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <Link href="/find" className="hover:text-white/70 transition-colors">Find</Link>
          <span>/</span>
          <span className="text-white/60">CWE-{cwe.id}</span>
        </nav>

        {/* Hero */}
        <div className="mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 font-medium mb-6">
            CWE Top 25 — #{cwe.rank}
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-4">
            {cwe.name}
          </h1>
          <div className="text-sm font-mono text-teal-300/80 mb-6">CWE-{cwe.id}</div>
          <p className="text-lg text-white/70 leading-relaxed">{cwe.shortDesc}</p>
        </div>

        {/* Coverage status */}
        {covered ? (
          <section className="mb-12 rounded-xl border border-teal-500/20 p-6" style={{ background: "rgba(20,184,166,0.05)" }}>
            <h2 className="text-sm uppercase tracking-wider text-teal-400 font-semibold mb-3">GateTest coverage</h2>
            <p className="text-white/80 leading-relaxed">
              Caught by:{" "}
              {cwe.modules.map((m, i) => (
                <span key={m}>
                  <Link href={`/modules/${moduleToSlug(m)}`} className="text-teal-300 hover:text-teal-200 font-mono">{m}</Link>
                  {i < cwe.modules.length - 1 ? ", " : ""}
                </span>
              ))}
            </p>
          </section>
        ) : (
          <section className="mb-12 rounded-xl border border-amber-500/20 p-6" style={{ background: "rgba(245,158,11,0.05)" }}>
            <h2 className="text-sm uppercase tracking-wider text-amber-300 font-semibold mb-3">GateTest coverage</h2>
            <p className="text-white/80 leading-relaxed">
              <strong className="text-amber-200">Not directly covered today.</strong> GateTest focuses on web-stack languages and infrastructure-as-code. For this class of bug, pair GateTest with a C/C++-aware analyzer.
            </p>
          </section>
        )}

        {/* Example */}
        <section className="mb-12 rounded-xl border border-white/[0.08] p-6" style={{ background: "rgba(255,255,255,0.02)" }}>
          <h2 className="text-sm uppercase tracking-wider text-white/40 font-semibold mb-3">Example</h2>
          <pre className="text-sm font-mono text-amber-200/90 whitespace-pre-wrap leading-relaxed">{cwe.example}</pre>
        </section>

        {/* Remediation */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-4">How to fix it</h2>
          <p className="text-white/70 leading-relaxed">{cwe.remediation}</p>
        </section>

        {/* CTA */}
        {covered && (
          <section className="mb-12 rounded-2xl border border-teal-500/20 p-8 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
            <h2 className="text-2xl font-bold text-white mb-3">Scan your repo for CWE-{cwe.id}</h2>
            <p className="text-white/60 mb-6">Free preview of findings. Pay per scan — no subscription. AI auto-fix PR included on the Scan + Fix tier.</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/#pricing"
                className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
                style={{ background: "#2dd4bf", color: "#0a0a12" }}
              >
                Run a scan &mdash; from $29
              </Link>
              <Link
                href="/find"
                className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
              >
                Browse CWE Top 25
              </Link>
            </div>
          </section>
        )}

        {/* FAQ */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-6">Frequently asked questions</h2>
          <div className="space-y-4">
            {faqs.map((f) => (
              <div
                key={f.q}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <h3 className="text-white font-semibold mb-2 leading-snug">{f.q}</h3>
                <p className="text-white/60 text-sm leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Related CWEs */}
        {related.length > 0 && (
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-white mb-6">Related CWEs</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/find/${r.slug}`}
                  className="block rounded-xl border border-white/[0.08] p-4 hover:border-teal-500/30 transition-colors"
                  style={{ background: "rgba(255,255,255,0.02)" }}
                >
                  <div className="text-xs font-mono text-teal-300/70 mb-1">CWE-{r.id} &middot; #{r.rank} in Top 25</div>
                  <div className="text-white font-semibold mb-1">{r.name}</div>
                  <div className="text-white/55 text-sm leading-snug">{r.shortDesc.slice(0, 120)}{r.shortDesc.length > 120 ? "…" : ""}</div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/find" className="hover:text-white/60 transition-colors">CWE index</Link>
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function moduleToSlug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Silence unused-export warnings on the type when imported only for shape
type _Used = CweEntry;
void (null as unknown as _Used);
