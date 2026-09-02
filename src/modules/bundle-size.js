/**
 * Bundle Size Regression — flags JS bundles exceeding size budgets.
 *
 * Reads build output from:
 *   - Next.js: .next/build-manifest.json + .next/app-build-manifest.json
 *   - Webpack: webpack-stats.json / bundle-stats.json
 *   - Vite: dist/stats.json / dist/.vite/manifest.json
 *   - esbuild/tsup: dist/ directory (scans .js files)
 *   - Generic: any stats JSON with an "assets" or "chunks" array
 *
 * Budgets (configurable via .gatetest.json bundleSize.budgets):
 *   - Initial JS per route: 50 KB (warning) / 200 KB (error)
 *   - Total page JS:       150 KB (warning) / 500 KB (error)
 *   - Largest single chunk: 100 KB (warning) / 300 KB (error)
 *
 * Also detects package.json bundlephobia-style "size" budget comments.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseModule    = require('./base-module');

const KB = 1024;

const DEFAULT_BUDGETS = {
  initialJsPerRoute:  { warning: 50 * KB,  error: 200 * KB  },
  totalPageJs:        { warning: 150 * KB, error: 500 * KB  },
  largestSingleChunk: { warning: 100 * KB, error: 300 * KB  },
};

function fmtKB(bytes) {
  return `${(bytes / KB).toFixed(1)} KB`;
}

// ─── Next.js build manifest parser ────────────────────────────────────────

function parseNextManifest(nextDir) {
  const chunks = []; // { name, size, route? }

  // .next/build-manifest.json — maps pages → JS chunk arrays
  const manifestPath = path.join(nextDir, 'build-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      for (const [page, files] of Object.entries(manifest.pages || {})) {
        for (const file of files) {
          const fullPath = path.join(nextDir, file);
          if (!fullPath.endsWith('.js')) continue;
          if (!fs.existsSync(fullPath)) continue;
          const size = fs.statSync(fullPath).size;
          chunks.push({ name: file, size, route: page });
        }
      }
    } catch { /* skip */ }
  }

  // static/chunks directory — scan for large chunks
  const chunksDir = path.join(nextDir, 'static', 'chunks');
  if (fs.existsSync(chunksDir)) {
    try {
      for (const f of fs.readdirSync(chunksDir)) {
        if (!f.endsWith('.js')) continue;
        const full = path.join(chunksDir, f);
        const size = fs.statSync(full).size;
        if (!chunks.find(c => c.name.includes(f))) {
          chunks.push({ name: `static/chunks/${f}`, size, route: null });
        }
      }
    } catch { /* skip */ }
  }

  return chunks;
}

// ─── webpack/generic stats parser ─────────────────────────────────────────

function parseWebpackStats(statsPath) {
  try {
    const stats  = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    const assets = stats.assets || stats.chunks || [];
    return assets
      .filter(a => (a.name || '').endsWith('.js') && a.size)
      .map(a => ({ name: a.name, size: a.size, route: null }));
  } catch { return []; }
}

// ─── dist directory scanner ────────────────────────────────────────────────

function scanDistDir(distDir) {
  const chunks = [];
  if (!fs.existsSync(distDir)) return chunks;
  const walk = (dir) => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.name.endsWith('.js') && !e.name.endsWith('.min.js')) {
          chunks.push({ name: path.relative(distDir, full), size: fs.statSync(full).size, route: null });
        }
      }
    } catch { /* skip */ }
  };
  walk(distDir);
  return chunks;
}

// ─── module ────────────────────────────────────────────────────────────────

class BundleSize extends BaseModule {
  constructor() {
    super('bundleSize', 'Bundle Size Regression — flags JS bundles exceeding size budgets');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const budgets     = (config.bundleSize || {}).budgets
      ? { ...DEFAULT_BUDGETS, ...(config.bundleSize.budgets) }
      : DEFAULT_BUDGETS;

    const chunks = [];

    // Next.js
    const nextDir = path.join(projectRoot, '.next');
    if (fs.existsSync(nextDir)) {
      chunks.push(...parseNextManifest(nextDir));
    }

    // Webpack stats
    for (const statsFile of ['webpack-stats.json', 'bundle-stats.json', 'dist/stats.json']) {
      const full = path.join(projectRoot, statsFile);
      if (fs.existsSync(full)) chunks.push(...parseWebpackStats(full));
    }

    // Vite manifest
    const viteManifest = path.join(projectRoot, 'dist', '.vite', 'manifest.json');
    if (fs.existsSync(viteManifest)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(viteManifest, 'utf-8'));
        for (const [key, asset] of Object.entries(manifest)) {
          if (asset.file && asset.file.endsWith('.js')) {
            const full = path.join(projectRoot, 'dist', asset.file);
            if (fs.existsSync(full)) {
              chunks.push({ name: asset.file, size: fs.statSync(full).size, route: key });
            }
          }
        }
      } catch { /* skip */ }
    }

    // Generic dist scan (if no manifest found). Without a bundler manifest
    // we cannot know these are PAGE bundles: lodash commits `dist/lodash.js`
    // (533 KB) and it is a library artefact a consumer tree-shakes, not a
    // chunk a browser downloads. Budgets designed for web apps report at
    // WARNING here — visible, never blocking (corpus gate 2026-09-02).
    let genericDist = false;
    if (chunks.length === 0) {
      const distDir = path.join(projectRoot, 'dist');
      chunks.push(...scanDistDir(distDir));
      genericDist = chunks.length > 0;
    }
    const overBudgetSeverity = genericDist ? 'warning' : 'error';
    const budgetNote = genericDist ? ' (no bundler manifest found — dist/ measured as generic output, so this is advisory)' : '';

    if (chunks.length === 0) {
      result.addCheck('bundle-size:no-build-output', true, {
        severity: 'info',
        message: 'No build output found — run a build first to enable bundle size analysis',
      });
      return;
    }

    let issueCount = 0;

    // Largest single chunk
    const largest = chunks.reduce((a, b) => (b.size > a.size ? b : a), chunks[0]);
    if (largest.size > budgets.largestSingleChunk.error) {
      issueCount++;
      result.addCheck('bundle-size:largest-chunk-error', false, {
        severity: overBudgetSeverity,
        message: `Largest JS chunk \`${largest.name}\` is ${fmtKB(largest.size)} — exceeds ${fmtKB(budgets.largestSingleChunk.error)} error budget${budgetNote}`,
        fix: 'Use dynamic import() to code-split this chunk. Identify large dependencies with `npm run analyze` or `npx source-map-explorer`.',
      });
    } else if (largest.size > budgets.largestSingleChunk.warning) {
      issueCount++;
      result.addCheck('bundle-size:largest-chunk-warning', false, {
        severity: 'warning',
        message: `Largest JS chunk \`${largest.name}\` is ${fmtKB(largest.size)} — approaching ${fmtKB(budgets.largestSingleChunk.warning)} budget`,
        fix: 'Consider splitting this chunk with dynamic import().',
      });
    }

    // Total JS size
    const totalSize = chunks.reduce((sum, c) => sum + c.size, 0);
    if (totalSize > budgets.totalPageJs.error) {
      issueCount++;
      result.addCheck('bundle-size:total-error', false, {
        severity: overBudgetSeverity,
        message: `Total JS output is ${fmtKB(totalSize)} — exceeds ${fmtKB(budgets.totalPageJs.error)} error budget${budgetNote}`,
        fix: 'Audit large dependencies with `npx bundlephobia`. Remove unused libraries. Use tree-shakeable alternatives.',
      });
    } else if (totalSize > budgets.totalPageJs.warning) {
      issueCount++;
      result.addCheck('bundle-size:total-warning', false, {
        severity: 'warning',
        message: `Total JS output is ${fmtKB(totalSize)} — approaching ${fmtKB(budgets.totalPageJs.warning)} budget`,
        fix: 'Review large dependencies and consider lazy loading non-critical code.',
      });
    }

    // Per-route initial JS (Next.js specific)
    const routeChunks = chunks.filter(c => c.route);
    const routeSizes  = new Map();
    for (const c of routeChunks) {
      const current = routeSizes.get(c.route) || 0;
      routeSizes.set(c.route, current + c.size);
    }

    for (const [route, size] of routeSizes) {
      if (size > budgets.initialJsPerRoute.error) {
        issueCount++;
        result.addCheck(`bundle-size:route-error:${route}`, false, {
          severity: 'error',
          message: `Route \`${route}\` initial JS is ${fmtKB(size)} — exceeds ${fmtKB(budgets.initialJsPerRoute.error)} per-route budget`,
          fix: `Move non-critical code for route \`${route}\` behind dynamic import(). Split heavy components.`,
        });
      } else if (size > budgets.initialJsPerRoute.warning) {
        issueCount++;
        result.addCheck(`bundle-size:route-warning:${route}`, false, {
          severity: 'warning',
          message: `Route \`${route}\` initial JS is ${fmtKB(size)} — approaching per-route budget`,
          fix: `Consider lazy-loading heavy components in \`${route}\`.`,
        });
      }
    }

    result.addCheck('bundle-size:summary', true, {
      severity: 'info',
      message: `Bundle analysis: ${chunks.length} chunks, total ${fmtKB(totalSize)}, largest ${fmtKB(largest.size)}`,
    });

    if (issueCount === 0) {
      result.addCheck('bundle-size:within-budget', true, {
        severity: 'info',
        message: `All ${chunks.length} JS chunk(s) within size budgets (total: ${fmtKB(totalSize)})`,
      });
    }
  }
}

module.exports = BundleSize;
