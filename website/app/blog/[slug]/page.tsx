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
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";
import siteStats from "../../data/site-stats.json";

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
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(blogPostingSchema({ headline: post.title, description: post.description, path: `/blog/${post.slug}`, datePublished: post.datePublished, dateModified: post.dateModified })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqSchema(post.faqs)) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema(crumbs)) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <Link href="/blog" className="hover:text-foreground transition-colors">Blog</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary truncate max-w-[60vw]">{post.title}</span>
        </nav>
      </div>

      <PageHero
        eyebrow={
          <>
            <time dateTime={post.datePublished}>
              {new Date(post.datePublished).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
            </time>
            <span aria-hidden="true">·</span>
            <span>{post.readTime}</span>
          </>
        }
        title={post.title}
        lede={post.description}
        actions={post.tags.map((t) => (
          <span key={t} className="text-xs font-mono text-accent px-2 py-0.5 rounded bg-accent/10 border border-accent/20">{t}</span>
        ))}
      />

      <Section narrow>
        <article className="space-y-8">
          {post.sections.map((s, i) => (
            <section key={i}>
              {s.heading && <h2 className="font-display text-2xl font-bold text-foreground mb-4">{s.heading}</h2>}
              {s.paragraphs?.map((p, j) => (
                <p key={j} className="text-foreground-secondary leading-relaxed mb-4">{p}</p>
              ))}
              {s.code && (
                <pre className="text-sm font-mono whitespace-pre-wrap leading-relaxed rounded-xl bg-panel text-panel-foreground border border-panel-border p-5 overflow-x-auto my-4">{s.code.content}</pre>
              )}
              {s.bullets && (
                <ul className="space-y-2 mt-3">
                  {s.bullets.map((b, j) => (
                    <li key={j} className="flex gap-3 text-foreground-secondary leading-relaxed">
                      <span className="text-accent mt-1.5 flex-shrink-0" aria-hidden="true">•</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </article>
      </Section>

      <Section alt narrow title="Frequently asked questions">
        <div className="space-y-4">
          {post.faqs.map((f) => (
            <div key={f.q} className="card p-5">
              <h3 className="text-foreground font-semibold mb-2 leading-snug">{f.q}</h3>
              <p className="text-foreground-secondary text-sm leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section narrow>
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 text-center">
          <h2 className="font-display text-2xl font-bold text-foreground mb-3">Put a gate between your AI and your main branch</h2>
          <p className="text-foreground-secondary mb-6">{siteStats.modules.total} modules. Pay per scan — no subscription required. AI auto-fix PR on the Scan + Fix tier.</p>
          <Link href="/#pricing" className="btn-cta px-6 py-3 text-sm">
            Run a scan &mdash; from $29
          </Link>
        </div>

        {related.length > 0 && (
          <div className="mt-12">
            <h2 className="font-display text-2xl font-bold text-foreground mb-6">Keep reading</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link key={r.slug} href={`/blog/${r.slug}`} className="card block p-4">
                  <div className="text-foreground font-semibold mb-1 leading-snug">{r.title}</div>
                  <div className="text-foreground-secondary text-sm leading-snug">{r.description.slice(0, 110)}…</div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </Section>
    </main>
  );
}
