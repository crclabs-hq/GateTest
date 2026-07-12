import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllBlogSlugs,
  getBlogPostBySlug,
  getRelatedPosts,
} from "../blog-catalog";
import {
  contentMetadata,
  blogPostingSchema,
  faqSchema,
  breadcrumbSchema,
  jsonLd,
} from "../../lib/seo/schema";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams(): { slug: string }[] {
  return getAllBlogSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPostBySlug(slug);
  if (!post) return { title: "Post not found — GateTest blog" };
  return contentMetadata({
    title: `${post.title} | GateTest blog`,
    description: post.description.slice(0, 180),
    path: `/blog/${post.slug}`,
    ogType: "article",
    keywords: post.tags,
  });
}

export default async function BlogPostPage({ params }: PageParams) {
  const { slug } = await params;
  const post = getBlogPostBySlug(slug);
  if (!post) notFound();

  const related = getRelatedPosts(slug, 2);
  const crumbs = [
    { name: "GateTest", path: "/" },
    { name: "Blog", path: "/blog" },
    { name: post.title },
  ];

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(blogPostingSchema({ headline: post.title, description: post.description, path: `/blog/${post.slug}`, datePublished: post.datePublished, dateModified: post.dateModified })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqSchema(post.faqs)) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema(crumbs)) }} />

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
          <Link href="/blog" className="text-sm text-white/50 hover:text-white transition-colors">
            Blog &rarr;
          </Link>
        </div>
      </nav>

      <article className="px-6 py-16 max-w-3xl mx-auto">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <Link href="/blog" className="hover:text-white/70 transition-colors">Blog</Link>
          <span>/</span>
          <span className="text-white/60 truncate max-w-[40vw]">{post.title}</span>
        </nav>

        <header className="mb-10">
          <div className="flex items-center gap-3 text-xs text-white/40 mb-5">
            <time dateTime={post.datePublished}>
              {new Date(post.datePublished).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
            </time>
            <span>·</span>
            <span>{post.readTime}</span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-5">{post.title}</h1>
          <p className="text-lg text-white/70 leading-relaxed">{post.description}</p>
          <div className="flex flex-wrap gap-2 mt-6">
            {post.tags.map((t) => (
              <span key={t} className="text-xs font-mono text-teal-300/80 px-2 py-0.5 rounded bg-teal-500/10 border border-teal-500/20">{t}</span>
            ))}
          </div>
        </header>

        <div className="space-y-8">
          {post.sections.map((s, i) => (
            <section key={i}>
              {s.heading && <h2 className="text-2xl font-bold text-white mb-4">{s.heading}</h2>}
              {s.paragraphs?.map((p, j) => (
                <p key={j} className="text-white/70 leading-relaxed mb-4">{p}</p>
              ))}
              {s.code && (
                <pre className="text-sm font-mono text-teal-100/90 whitespace-pre-wrap leading-relaxed rounded-xl border border-white/[0.08] p-5 overflow-x-auto my-4" style={{ background: "rgba(255,255,255,0.02)" }}>{s.code.content}</pre>
              )}
              {s.bullets && (
                <ul className="space-y-2 mt-3">
                  {s.bullets.map((b, j) => (
                    <li key={j} className="flex gap-3 text-white/70 leading-relaxed">
                      <span className="text-teal-400 mt-1.5 flex-shrink-0">•</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>

        <section className="mt-14 mb-12">
          <h2 className="text-2xl font-bold text-white mb-6">Frequently asked questions</h2>
          <div className="space-y-4">
            {post.faqs.map((f) => (
              <div key={f.q} className="rounded-xl border border-white/[0.08] p-5" style={{ background: "rgba(255,255,255,0.02)" }}>
                <h3 className="text-white font-semibold mb-2 leading-snug">{f.q}</h3>
                <p className="text-white/60 text-sm leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12 rounded-2xl border border-teal-500/20 p-8 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-2xl font-bold text-white mb-3">Put a gate between your AI and your main branch</h2>
          <p className="text-white/60 mb-6">120 modules. Pay per scan, no subscription. AI auto-fix PR on the Scan + Fix tier.</p>
          <Link href="/#pricing" className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm" style={{ background: "#2dd4bf", color: "#0a0a12" }}>
            Run a scan &mdash; from $29
          </Link>
        </section>

        {related.length > 0 && (
          <section className="mb-4">
            <h2 className="text-2xl font-bold text-white mb-6">Keep reading</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link key={r.slug} href={`/blog/${r.slug}`} className="block rounded-xl border border-white/[0.08] p-4 hover:border-teal-500/30 transition-colors" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-white font-semibold mb-1 leading-snug">{r.title}</div>
                  <div className="text-white/55 text-sm leading-snug">{r.description.slice(0, 110)}…</div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </article>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/blog" className="hover:text-white/60 transition-colors">Blog</Link>
            <Link href="/glossary" className="hover:text-white/60 transition-colors">Glossary</Link>
            <Link href="/use-cases" className="hover:text-white/60 transition-colors">Use cases</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
