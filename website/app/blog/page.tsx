import type { Metadata } from "next";
import Link from "next/link";
import { BLOG_POSTS } from "./blog-catalog";
import {
  contentMetadata,
  collectionPageSchema,
  breadcrumbSchema,
  jsonLd,
} from "../lib/seo/schema";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

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
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(collectionPageSchema({ name: "GateTest blog", description: "Deep technical writing on code quality and application security.", path: "/blog", items })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Blog" }])) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">Blog</span>
        </nav>
      </div>

      <PageHero
        eyebrow="Blog"
        title="The GateTest blog"
        lede="Deep technical writing on shipping safe software when AI writes most of it."
        actions={
          <Link href="/glossary" className="btn-secondary px-5 py-2.5 text-sm">
            Glossary &rarr;
          </Link>
        }
      />

      <Section narrow>
        <div className="space-y-5">
          {BLOG_POSTS.map((p) => (
            <Link key={p.slug} href={`/blog/${p.slug}`} className="card block p-6">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted mb-3">
                <time dateTime={p.datePublished}>
                  {new Date(p.datePublished).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                </time>
                <span aria-hidden="true">·</span>
                <span>{p.readTime}</span>
              </div>
              <h2 className="font-display text-xl font-bold text-foreground mb-2 leading-snug">{p.title}</h2>
              <p className="text-foreground-secondary text-sm leading-relaxed">{p.description.slice(0, 170)}…</p>
            </Link>
          ))}
        </div>
      </Section>
    </main>
  );
}
