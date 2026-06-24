import type { Metadata } from "next";
import Link from "next/link";
import { BLOG_POSTS } from "./blog-catalog";
import {
  contentMetadata,
  collectionPageSchema,
  breadcrumbSchema,
  jsonLd,
} from "../lib/seo/schema";

export const metadata: Metadata = contentMetadata({
  title: "Blog — code quality & application security | GateTest",
  description:
    "Deep technical writing on shipping safe software in the AI era: why AI-generated code needs a gate, SAST vs DAST vs SCA, and cutting static-analysis false positives without missing real bugs.",
  path: "/blog",
  keywords: ["code quality blog", "application security blog", "sast", "ai code review"],
});

export default function BlogIndexPage() {
  const items = BLOG_POSTS.map((p) => ({ name: p.title, path: `/blog/${p.slug}` }));

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(collectionPageSchema({ name: "GateTest blog", description: "Deep technical writing on code quality and application security.", path: "/blog", items })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Blog" }])) }} />

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

      <main className="px-6 py-16 max-w-3xl mx-auto">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Blog</span>
        </nav>

        <div className="mb-12">
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-5">The GateTest blog</h1>
          <p className="text-lg text-white/70 leading-relaxed">
            Deep technical writing on shipping safe software when AI writes most of it.
          </p>
        </div>

        <div className="space-y-5">
          {BLOG_POSTS.map((p) => (
            <Link key={p.slug} href={`/blog/${p.slug}`} className="block rounded-xl border border-white/[0.08] p-6 hover:border-teal-500/30 transition-colors" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center gap-3 text-xs text-white/40 mb-3">
                <time dateTime={p.datePublished}>
                  {new Date(p.datePublished).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                </time>
                <span>·</span>
                <span>{p.readTime}</span>
              </div>
              <h2 className="text-xl font-bold text-white mb-2 leading-snug">{p.title}</h2>
              <p className="text-white/60 text-sm leading-relaxed">{p.description.slice(0, 170)}…</p>
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
