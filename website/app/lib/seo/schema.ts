/**
 * Shared SEO schema + metadata builders.
 *
 * Until now every page hand-rolled its JSON-LD (FAQPage, BreadcrumbList,
 * SoftwareApplication, …). These helpers centralise the shapes so the new
 * content hubs (glossary / use-cases / blog) stay consistent and so the
 * structured data we emit is valid schema.org by construction.
 *
 * Nothing here renders — the builders return plain objects. Page components
 * stringify them into <script type="application/ld+json"> tags exactly the
 * way the existing find/[slug] and compare/* pages do. A matching
 * `contentMetadata()` helper produces the Next.js `Metadata` object (canonical
 * + Open Graph + Twitter) so detail pages don't drift on those tags either.
 */

import type { Metadata } from "next";

export const SITE = {
  baseUrl: "https://gatetest.ai",
  name: "GateTest",
  twitter: "@gatetest",
  ogImage: "https://gatetest.ai/og.png",
  locale: "en_US",
} as const;

/** Absolute URL for a site-relative path. */
export function absUrl(path: string): string {
  if (path.startsWith("http")) return path;
  return `${SITE.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

// ─────────────────────────────────────────────────────────────────────────
// JSON-LD schema builders
// ─────────────────────────────────────────────────────────────────────────

export interface FaqItem {
  q: string;
  a: string;
}

/** schema.org FAQPage — feeds Google's "People also ask" / rich results. */
export function faqSchema(items: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export interface Crumb {
  name: string;
  /** Site-relative path, e.g. "/glossary". Omit for the current (last) crumb. */
  path?: string;
}

/** schema.org BreadcrumbList — mirrors the visible breadcrumb trail. */
export function breadcrumbSchema(crumbs: Crumb[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      ...(c.path ? { item: absUrl(c.path) } : {}),
    })),
  };
}

/** schema.org DefinedTerm — the right type for glossary / definitional pages. */
export function definedTermSchema(opts: {
  term: string;
  description: string;
  path: string;
  abbreviation?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: opts.term,
    ...(opts.abbreviation ? { alternateName: opts.abbreviation } : {}),
    description: opts.description,
    url: absUrl(opts.path),
    inDefinedTermSet: {
      "@type": "DefinedTermSet",
      name: "GateTest Software Quality & Security Glossary",
      url: absUrl("/glossary"),
    },
  };
}

/** schema.org BlogPosting — for /blog/[slug]. */
export function blogPostingSchema(opts: {
  headline: string;
  description: string;
  path: string;
  datePublished: string;
  dateModified?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: opts.headline,
    description: opts.description,
    datePublished: opts.datePublished,
    dateModified: opts.dateModified ?? opts.datePublished,
    author: { "@type": "Organization", name: SITE.name, url: SITE.baseUrl },
    publisher: {
      "@type": "Organization",
      name: SITE.name,
      url: SITE.baseUrl,
      logo: { "@type": "ImageObject", url: absUrl("/icon.svg") },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": absUrl(opts.path) },
    url: absUrl(opts.path),
  };
}

/** schema.org TechArticle — for use-case / how-to style pages. */
export function articleSchema(opts: {
  headline: string;
  description: string;
  path: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: opts.headline,
    description: opts.description,
    author: { "@type": "Organization", name: SITE.name },
    publisher: { "@type": "Organization", name: SITE.name, url: SITE.baseUrl },
    mainEntityOfPage: absUrl(opts.path),
  };
}

/** schema.org Organization — the publishing entity behind every page. */
export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.name,
    url: SITE.baseUrl,
    logo: absUrl("/icon.svg"),
    description:
      "GateTest is an AI-powered code quality and security gate. 120 modules scan your codebase for security, supply-chain, accessibility, and reliability issues, then open auto-fix pull requests. Pay per scan, no subscription.",
    sameAs: ["https://github.com/crclabs-hq/gatetest"],
  };
}

/** schema.org WebSite + SearchAction — enables sitelinks search box. */
export function webSiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url: SITE.baseUrl,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE.baseUrl}/modules?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/** schema.org CollectionPage — for hub index pages listing their children. */
export function collectionPageSchema(opts: {
  name: string;
  description: string;
  path: string;
  items: { name: string; path: string }[];
}) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: opts.name,
    description: opts.description,
    url: absUrl(opts.path),
    hasPart: opts.items.map((it) => ({
      "@type": "WebPage",
      name: it.name,
      url: absUrl(it.path),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Metadata helper
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a Next.js Metadata object for a content page. Centralises canonical +
 * Open Graph + Twitter so detail pages stop hand-copying those blocks.
 */
export function contentMetadata(opts: {
  title: string;
  description: string;
  path: string;
  ogType?: "website" | "article";
  keywords?: string[];
  image?: string;
  noindex?: boolean;
}): Metadata {
  const canonical = absUrl(opts.path);
  const image = opts.image ?? SITE.ogImage;
  return {
    title: opts.title,
    description: opts.description,
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
    alternates: { canonical },
    ...(opts.noindex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title: opts.title,
      description: opts.description,
      url: canonical,
      siteName: SITE.name,
      type: opts.ogType ?? "website",
      locale: SITE.locale,
      images: [{ url: image }],
    },
    twitter: {
      card: "summary_large_image",
      title: opts.title,
      description: opts.description,
      images: [image],
    },
  };
}

/** Convenience: serialise a schema object for a <script> tag, &lt;-safe. */
export function jsonLd(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}
