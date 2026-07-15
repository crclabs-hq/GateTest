import type { MetadataRoute } from "next";
import { getAllModuleSlugs } from "./components/howitworks/module-slugs";
import { getAllCweSlugs } from "./find/cwe-catalog";
import { getAllRegulationSlugs } from "./regulation/catalog";
import { getAllCountrySlugs } from "./for/countries";
import { getAllGlossarySlugs } from "./glossary/glossary-catalog";
import { getAllUseCaseSlugs } from "./use-cases/use-cases-catalog";
import { getAllBlogSlugs } from "./blog/blog-catalog";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://gatetest.ai";
  const now = new Date();

  const core: MetadataRoute.Sitemap = [
    { url: base, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/github/setup`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/dashboard`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/modules`, lastModified: now, changeFrequency: "weekly", priority: 0.95 },
    { url: `${base}/how-it-works`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/trust`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/quickstart`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
  ];

  // Comparison hub index — links every "X alternative" page.
  const compareIndex: MetadataRoute.Sitemap = [
    { url: `${base}/compare`, lastModified: now, changeFrequency: "monthly", priority: 0.85 },
  ];

  // Glossary — definitional pages (DefinedTerm schema) targeting "what is X".
  const glossaryIndex: MetadataRoute.Sitemap = [
    { url: `${base}/glossary`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
  ];
  const glossaryPages: MetadataRoute.Sitemap = getAllGlossarySlugs().map((slug) => ({
    url: `${base}/glossary/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  // Use-case pages — high-intent "how do I X" queries.
  const useCaseIndex: MetadataRoute.Sitemap = [
    { url: `${base}/use-cases`, lastModified: now, changeFrequency: "monthly", priority: 0.85 },
  ];
  const useCasePages: MetadataRoute.Sitemap = getAllUseCaseSlugs().map((slug) => ({
    url: `${base}/use-cases/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.75,
  }));

  // Blog — deep technical posts (BlogPosting schema).
  const blogIndex: MetadataRoute.Sitemap = [
    { url: `${base}/blog`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
  ];
  const blogPages: MetadataRoute.Sitemap = getAllBlogSlugs().map((slug) => ({
    url: `${base}/blog/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  // Comparison pages — high-intent "X alternative" searches
  const comparisonSlugs = [
    "sonarqube",
    "snyk",
    "eslint",
    "github-code-scanning",
    "deepsource",
    "semgrep",
    "codeql",
  ];
  const compares: MetadataRoute.Sitemap = comparisonSlugs.map((slug) => ({
    url: `${base}/compare/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.9,
  }));

  // Use-case pages — framework/language targeting
  const forSlugs = ["nextjs", "typescript", "nodejs"];
  const forPages: MetadataRoute.Sitemap = forSlugs.map((slug) => ({
    url: `${base}/for/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.85,
  }));

  // Country-specific landing pages — compliance + stack framed by market.
  // Each is a real piece of indexable content tied to a country in
  // for/countries.ts.
  const countrySlugs = getAllCountrySlugs();
  const forIndex: MetadataRoute.Sitemap = [
    { url: `${base}/for`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
  ];
  const countryPages: MetadataRoute.Sitemap = countrySlugs.map((slug) => ({
    url: `${base}/for/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  // Programmatic module pages — 120 entries from modules-data.ts.
  // Each is a real piece of indexable content tied to a registered
  // module in src/core/registry.js.
  const moduleSlugs = getAllModuleSlugs();
  const modulePages: MetadataRoute.Sitemap = moduleSlugs.map((slug) => ({
    url: `${base}/modules/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.75,
  }));

  // CWE Top 25 pages — 25 entries sourced from MITRE's annual list.
  // Content is original (our descriptions + GateTest module mappings).
  const cweSlugs = getAllCweSlugs();
  const cweIndex: MetadataRoute.Sitemap = [
    { url: `${base}/find`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
  ];
  const cwePages: MetadataRoute.Sitemap = cweSlugs.map((slug) => ({
    url: `${base}/find/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  // Regulation pages — compliance regime landing pages.
  // Each is a real piece of indexable content tied to a regulation
  // in regulation/catalog.ts.
  const regulationSlugs = getAllRegulationSlugs();
  const regulationIndex: MetadataRoute.Sitemap = [
    { url: `${base}/regulation`, lastModified: now, changeFrequency: "monthly", priority: 0.85 },
  ];
  const regulationPages: MetadataRoute.Sitemap = regulationSlugs.map((slug) => ({
    url: `${base}/regulation/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  // Legal
  const legal: MetadataRoute.Sitemap = [
    { url: `${base}/legal/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/refunds`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/acceptable-use`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  return [
    ...core,
    ...compareIndex,
    ...compares,
    ...glossaryIndex,
    ...glossaryPages,
    ...useCaseIndex,
    ...useCasePages,
    ...blogIndex,
    ...blogPages,
    ...forPages,
    ...forIndex,
    ...countryPages,
    ...modulePages,
    ...cweIndex,
    ...cwePages,
    ...regulationIndex,
    ...regulationPages,
    ...legal,
  ];
}
