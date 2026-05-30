import type { MetadataRoute } from "next";
import { getAllModuleSlugs } from "./components/howitworks/module-slugs";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://gatetest.ai";
  const now = new Date();

  const core: MetadataRoute.Sitemap = [
    { url: base, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/github/setup`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/dashboard`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/modules`, lastModified: now, changeFrequency: "weekly", priority: 0.95 },
  ];

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

  // Programmatic module pages — 104 entries from modules-data.ts.
  // Each is a real piece of indexable content tied to a registered
  // module in src/core/registry.js.
  const moduleSlugs = getAllModuleSlugs();
  const modulePages: MetadataRoute.Sitemap = moduleSlugs.map((slug) => ({
    url: `${base}/modules/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.75,
  }));

  // Legal
  const legal: MetadataRoute.Sitemap = [
    { url: `${base}/legal/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/refunds`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/acceptable-use`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  return [...core, ...compares, ...forPages, ...modulePages, ...legal];
}
