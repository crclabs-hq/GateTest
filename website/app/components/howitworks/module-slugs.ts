/**
 * Module → slug conversion + lookup utilities for /modules/[slug] routes.
 *
 * The module names in modules-data.ts are camelCase (e.g. "moneyFloat",
 * "tlsSecurity"). For SEO we want kebab-case slugs that match how
 * searchers actually type queries ("money float", "tls security").
 *
 * The slug is the canonical URL form. Lookups go in both directions so
 * that internal links can be authored using the module name and resolve
 * to the slug at build time.
 */

import { MODULE_CATEGORIES, type ModuleDef, type ModuleCategory } from "./modules-data";

/**
 * Convert camelCase / PascalCase to a URL-safe kebab-case slug.
 *
 * Internal — used by buildModuleIndex below. The all-urls.js worker
 * re-implements this in plain JS to avoid pulling TypeScript into the
 * runtime; if the algorithm changes here, mirror the change there.
 */
function moduleNameToSlug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Internal — the shape returned by getModuleBySlug / getRelatedModules /
 * getModulesByCategory. Callers receive it via inferred return types.
 */
interface ResolvedModule {
  slug: string;
  name: string;
  description: string;
  example: string;
  category: { id: string; title: string; blurb: string };
}

/**
 * Build a flat lookup of all modules keyed by slug. Internal — consumed
 * by getAllModuleSlugs / getModuleBySlug / getRelatedModules below.
 */
function buildModuleIndex(): Map<string, ResolvedModule> {
  const out = new Map<string, ResolvedModule>();
  for (const cat of MODULE_CATEGORIES) {
    for (const mod of cat.modules) {
      const slug = moduleNameToSlug(mod.name);
      // Avoid silent collisions — first definition wins.
      if (out.has(slug)) continue;
      out.set(slug, {
        slug,
        name: mod.name,
        description: mod.description,
        example: mod.example,
        category: { id: cat.id, title: cat.title, blurb: cat.blurb },
      });
    }
  }
  return out;
}

/**
 * All slugs in deterministic order for generateStaticParams.
 */
export function getAllModuleSlugs(): string[] {
  const idx = buildModuleIndex();
  return Array.from(idx.keys()).sort();
}

/**
 * Resolve a single slug to its module record (or null if unknown).
 */
export function getModuleBySlug(slug: string): ResolvedModule | null {
  const idx = buildModuleIndex();
  return idx.get(slug) || null;
}

/**
 * Get related modules — same category, excluding the current one.
 * Used for cross-linking on each module page.
 */
export function getRelatedModules(slug: string, limit = 6): ResolvedModule[] {
  const idx = buildModuleIndex();
  const me = idx.get(slug);
  if (!me) return [];
  const related: ResolvedModule[] = [];
  for (const m of idx.values()) {
    if (m.slug === slug) continue;
    if (m.category.id !== me.category.id) continue;
    related.push(m);
    if (related.length >= limit) break;
  }
  return related;
}

/**
 * Flatten all categories with their modules — used for the /modules
 * index page.
 */
export function getModulesByCategory(): Array<Omit<ModuleCategory, "modules"> & { modules: ResolvedModule[] }> {
  return MODULE_CATEGORIES.map((cat) => ({
    ...cat,
    modules: cat.modules.map((mod) => ({
      slug: moduleNameToSlug(mod.name),
      name: mod.name,
      description: mod.description,
      example: mod.example,
      category: { id: cat.id, title: cat.title, blurb: cat.blurb },
    })),
  }));
}

/**
 * Total module count — single source of truth for the index page.
 */
export function getTotalModuleCount(): number {
  return buildModuleIndex().size;
}

// Re-export for convenience
export type { ModuleDef, ModuleCategory };
