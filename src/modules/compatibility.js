/**
 * Compatibility Module - Deep browser and platform compatibility analysis.
 * Scans CSS for vendor prefix issues, modern feature usage without fallbacks,
 * JS API compatibility, and Node.js version constraints.
 */

const BaseModule = require('./base-module');
const { JS_SOURCE_EXTS } = require('../core/source-extensions');
const { nearestManifest } = require('../core/workspaces');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');

/**
 * Modern JS APIs and the FIRST version of each runtime that has them. Two
 * columns because a file has one runtime: code that ships to a browser is
 * judged against the browser matrix (`since`); server and CLI code is judged
 * against the Node.js floor its package.json declares (`node`, the major
 * where the API landed — `null` for browser-only APIs, which are simply not
 * a Node question).
 *
 * Until 2026-09-13 every file got the browser matrix: 60 of this repo's own
 * findings were "may not work in all target browsers" on `src/modules/*.js`,
 * `bin/*.mjs`, `website/app/lib/*.ts` and `website/app/api/**\/route.ts` —
 * Node code that never reaches a browser, in a package declaring
 * `engines.node >=20` where every one of those APIs exists. 39 of the 60
 * were "Iterator helpers (available since Very new)", and the regex behind
 * it (`\.map\(.*\)\.filter\(`) matched ordinary ARRAY chaining, which has
 * worked since ES5; the "Very new" was a placeholder that never got a
 * version. Both are fixed here; the control pair is
 * tests/compatibility.test.js.
 *
 * Regexes run on the MASKED source (strings, comments and regex bodies
 * blanked), so a comment saying "we do not use structuredClone" and a
 * fixture string containing `.toSorted(` cannot fire; the v-flag rule reads
 * the delimiters and flags the mask leaves in place.
 */
const MODERN_APIS = [
  { api: 'structuredClone', regex: /\bstructuredClone\s*\(/, since: 'Chrome 98', node: 17, root: 'structuredClone' },
  { api: 'Array.at()', regex: /\.at\s*\(\s*-/, since: 'Chrome 92', node: 17, method: 'at' },
  { api: 'Object.hasOwn', regex: /Object\.hasOwn\s*\(/, since: 'Chrome 93', node: 17, root: 'Object.hasOwn' },
  { api: 'AbortSignal.timeout', regex: /AbortSignal\.timeout\s*\(/, since: 'Chrome 103', node: 18, root: 'AbortSignal' },
  { api: 'navigator.share', regex: /navigator\.share\s*\(/, since: 'Limited support', node: null, root: 'navigator' },
  { api: 'Array.findLast', regex: /\.findLast\s*\(/, since: 'Chrome 97', node: 18, method: 'findLast' },
  { api: 'Array.toReversed', regex: /\.toReversed\s*\(/, since: 'Chrome 110', node: 20, method: 'toReversed' },
  { api: 'Array.toSorted', regex: /\.toSorted\s*\(/, since: 'Chrome 110', node: 20, method: 'toSorted' },
  { api: 'Array.toSpliced', regex: /\.toSpliced\s*\(/, since: 'Chrome 110', node: 20, method: 'toSpliced' },
  { api: 'Promise.withResolvers', regex: /Promise\.withResolvers\s*\(/, since: 'Chrome 119', node: 22, root: 'Promise.withResolvers' },
  // `z.union([...])`, `t.union(`, `_.intersection(`: schema builders and
  // lodash-style utilities share the method names; Set methods are only
  // ever called on a Set. The receiver must not be one of those namespaces.
  { api: 'Set methods (union/intersection)', regex: /(?<!\b(?:z|t|v|_|io|yup|Joi|S|zod|schema|Schema)\s*)\.(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/, since: 'Chrome 122', node: 22, method: 'union' },
  // Iterator helpers are `Iterator.prototype.map` & co. — chained on an
  // ITERATOR (`set.values().map(`, `map.entries().filter(`), or
  // `Iterator.from(`. `Object.entries(obj).map(` is Array.prototype.map on
  // the array Object.entries returns, and never matches: the iterator form
  // is the empty-parens call.
  { api: 'Iterator helpers', regex: /\.(?:values|keys|entries)\(\)\s*\.(?:map|filter|take|drop|flatMap|reduce|toArray|forEach|some|every|find)\s*\(|\bIterator\.from\s*\(/, since: 'Chrome 122', node: 22, root: 'Iterator' },
  // A regex LITERAL with the v flag: on the masked line the body is blanks
  // between its delimiters and the flags survive, so `/   /v` is the shape.
  // (KI #50: the raw-text form matched `/lib/validators` — 202 of 237
  // findings — because any two-slash path followed by a v-word looked like
  // one.) `new RegExp('…', 'v')` is a string argument and is read from the
  // raw line by the flags-string rule below.
  { api: 'RegExp v flag', regex: /\/ +\/[dgimsuy]*v\b/, since: 'Chrome 112', node: 20, root: 'RegExp' },
];

/**
 * The lowest Node major a package.json `engines.node` range admits, or null
 * when it does not bound the version from below (`*`, `<21`, absent). Each
 * `||` alternative contributes its own floor; the range's floor is the
 * lowest of them. `>20` is read as 20 — a floor too low costs a warning,
 * a floor too high hides one.
 */
function minNodeMajor(range) {
  if (typeof range !== 'string' || !range.trim()) return null;
  let floor = null;
  for (const alt of range.split('||')) {
    let altFloor = null;
    for (const token of alt.trim().split(/\s+/)) {
      const m = /^(>=|>|<=|<|\^|~|=)?v?(\d+)(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?/.exec(token);
      if (!m || m[1] === '<' || m[1] === '<=') continue;
      const major = Number(m[2]);
      if (altFloor === null || major < altFloor) altFloor = major;
    }
    if (altFloor === null) return null;
    if (floor === null || altFloor < floor) floor = altFloor;
  }
  return floor;
}

/** The floor to assume when nothing declares one; `compat:node-engine` already asks for the declaration. */
const ASSUMED_NODE_MAJOR = 20;

const BROWSER_ASSET_DIR_RE = /(^|\/)(?:public|static|assets)\//i;
const CLIENT_DIRECTIVE_RE = /^\s*(['"])use client\1\s*;?\s*$/;

class CompatibilityModule extends BaseModule {
  constructor() {
    super('compatibility', 'Browser Compatibility Checks');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    this._checkBrowserslist(projectRoot, result);
    this._checkNodeVersion(projectRoot, result);

    const cssFiles = this._collectFiles(projectRoot, ['.css', '.scss']);
    for (const file of cssFiles) {
      const relPath = repoRelative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');
      this._checkCssCompat(relPath, content, result);
    }

    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS);
    const manifests = new Map();
    for (const file of jsFiles) {
      const relPath = repoRelative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');
      this._checkJsCompat(relPath, content, result, projectRoot, manifests);
    }

    this._checkResponsiveDesign(projectRoot, cssFiles, result);
    this._checkPolyfills(projectRoot, result);
  }

  _checkBrowserslist(projectRoot, result) {
    const pkgPath = path.join(projectRoot, 'package.json');
    let pkg = null;
    if (fs.existsSync(pkgPath)) {
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { pkg = null; }
    }

    const hasConfig =
      fs.existsSync(path.join(projectRoot, '.browserslistrc')) || !!(pkg && pkg.browserslist);

    if (hasConfig) {
      result.addCheck('compat:browserslist', true);
      return;
    }

    // Browserslist only means something for code that RUNS IN A BROWSER.
    // Firing "no browserslist configuration" on a Go repo, a CLI, or a pure
    // Node server tells the customer to configure a tool that has nothing
    // to configure (2026-08-18 audit residue: fired on gin-gonic/gin).
    // Require a web signal before warning: a browser-facing framework or
    // bundler in package.json deps, a "browser" field, or shipped HTML.
    const WEB_DEP_RE = /^(react|react-dom|preact|vue|svelte|@angular\/core|next|nuxt|astro|gatsby|solid-js|lit|jquery|webpack|vite|parcel|rollup|esbuild|@babel\/preset-env|autoprefixer|postcss|tailwindcss)$/;
    const allDeps = pkg
      ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })
      : [];
    const isWebProject =
      (pkg && (pkg.browser || allDeps.some((d) => WEB_DEP_RE.test(d)))) ||
      fs.existsSync(path.join(projectRoot, 'index.html')) ||
      fs.existsSync(path.join(projectRoot, 'public', 'index.html'));

    if (!isWebProject) {
      result.addCheck('compat:browserslist', true, {
        severity: 'info',
        message: 'No browser-facing code detected — browserslist not applicable',
      });
      return;
    }

    result.addCheck('compat:browserslist', false, {
      severity: 'warning',
      message: 'No browserslist configuration found',
      suggestion: 'Add a .browserslistrc or "browserslist" field in package.json',
    });
  }

  _checkNodeVersion(projectRoot, result) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (!pkg.engines?.node) {
        result.addCheck('compat:node-engine', false, {
          severity: 'warning',
          message: 'No engines.node field in package.json',
          suggestion: 'Add "engines": { "node": ">=20.0.0" } to specify Node.js version',
        });
      } else {
        result.addCheck('compat:node-engine', true, {
          severity: 'info',
          message: `Node.js engine: ${pkg.engines.node}`,
        });
      }
    } catch { /* error-ok — unreadable package.json — the syntax module reports it; this check has nothing to read */ }
  }

  _checkCssCompat(relPath, content, result) {
    // Vendor-prefix-only properties (no unprefixed fallback)
    const vendorPrefixes = [
      { regex: /-webkit-appearance\b/g, standard: 'appearance', feature: 'CSS appearance' },
      { regex: /-webkit-backdrop-filter\b/g, standard: 'backdrop-filter', feature: 'backdrop-filter' },
      { regex: /-webkit-text-stroke\b/g, standard: 'text-stroke', feature: 'text-stroke' },
    ];

    for (const { regex, standard, feature } of vendorPrefixes) {
      regex.lastIndex = 0;
      if (regex.test(content) && !content.includes(`${standard}:`)) {
        result.addCheck(`compat:css:vendor-only:${feature}:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: `Using vendor-prefixed "${feature}" without standard property fallback`,
          suggestion: `Add unprefixed "${standard}" property alongside the vendor prefix`,
        });
      }
    }

    // Modern CSS features that need fallbacks
    const modernCss = [
      { feature: 'container queries', regex: /@container\b/g },
      { feature: 'CSS nesting', regex: /&\s*\{/g },
      { feature: 'CSS layers', regex: /@layer\b/g },
      { feature: 'subgrid', regex: /subgrid/g },
      { feature: 'color-mix()', regex: /color-mix\s*\(/g },
      { feature: 'oklch()', regex: /oklch\s*\(/g },
      { feature: 'has() selector', regex: /:has\s*\(/g },
      { feature: 'view transitions', regex: /view-transition/g },
      { feature: 'anchor positioning', regex: /anchor\s*\(/g },
      { feature: 'scroll-timeline', regex: /scroll-timeline/g },
    ];

    for (const { feature, regex } of modernCss) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        result.addCheck(`compat:css:${feature}:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: `Modern CSS feature "${feature}" may not work in all target browsers`,
          suggestion: `Verify "${feature}" browser support or add fallbacks`,
        });
      }
    }
  }

  /**
   * Which runtime executes this file? `'browser'` for code that ships to a
   * browser — a `.jsx` / `.tsx` component, a Next.js `'use client'` module,
   * a script under `public/` / `static/` / `assets/`, or any plain source in
   * a project that configured browserslist WITHOUT declaring a Node engine
   * (the project's own configuration says its targets are browsers).
   * Everything else — a shebang script, `route.ts`, `lib/*.ts`, `src/*.js`
   * in a package with an engines field — is `'node'`.
   *
   * @param {string} relFwd repo-relative, forward slashes
   * @param {string[]} rawLines
   * @param {string[]} maskedLines
   * @param {{ browserslist: boolean, engine: string|null }} project
   * @returns {'browser'|'node'}
   */
  _targetFor(relFwd, rawLines, maskedLines, project) {
    if (/^#!.*\bnode\b/.test(rawLines[0] || '')) return 'node';
    const ext = path.posix.extname(relFwd).toLowerCase();
    if (ext === '.jsx' || ext === '.tsx') return 'browser';
    if (BROWSER_ASSET_DIR_RE.test(relFwd) && (ext === '.js' || ext === '.mjs')) return 'browser';
    // The directive must be the first statement; comments may precede it.
    for (let i = 0; i < rawLines.length && i < 40; i += 1) {
      if (!(maskedLines[i] || '').trim()) continue;
      return CLIENT_DIRECTIVE_RE.test(rawLines[i]) ? 'browser' : (project.browserslist && !project.engine ? 'browser' : 'node');
    }
    return 'node';
  }

  /**
   * Is the API feature-detected in this file — `typeof AbortSignal !== 'undefined'
   * && AbortSignal.timeout ? … : …`, `'toSorted' in Array.prototype`? Then the
   * author already handles its absence and the finding would tell them what
   * they wrote. (website/app/lib/suppression-command.js:34, self-scan
   * 2026-09-13.)
   */
  static _featureDetected(masked, entry) {
    if (entry.root && new RegExp(`\\btypeof\\s+${entry.root.replace(/\./g, '\\.')}\\b`).test(masked)) return true;
    if (entry.method && new RegExp(`\\b${entry.method}\\b[^\\n]{0,40}\\bin\\s+\\w+\\.prototype\\b`).test(masked)) return true;
    return false;
  }

  _checkJsCompat(relPath, content, result, projectRoot, manifests) {
    const relFwd = relPath.replace(/\\/g, '/');
    const rawLines = content.split(/\r?\n/);
    const maskedLines = this._maskedLines(content, relFwd);
    const masked = maskedLines.join('\n');

    // The manifest that OWNS the file decides the Node floor and the module
    // system; the root decides whether browserslist is configured.
    const owner = projectRoot ? nearestManifest(projectRoot, relFwd, manifests) : null;
    const root = projectRoot ? nearestManifest(projectRoot, 'package.json', manifests) : null;
    const engineRange = (owner && owner.json && owner.json.engines && owner.json.engines.node)
      || (root && root.json && root.json.engines && root.json.engines.node) || null;
    const project = {
      engine: engineRange,
      browserslist: Boolean(projectRoot && (fs.existsSync(path.join(projectRoot, '.browserslistrc')) || (root && root.json && root.json.browserslist))),
    };
    const target = this._targetFor(relFwd, rawLines, maskedLines, project);
    const declaredFloor = minNodeMajor(engineRange);
    const nodeFloor = declaredFloor === null ? ASSUMED_NODE_MAJOR : declaredFloor;

    for (const entry of MODERN_APIS) {
      const { api, regex, since } = entry;
      if (!regex.test(masked)) continue;
      if (CompatibilityModule._featureDetected(masked, entry)) continue;
      if (target === 'node') {
        // Browser-only APIs are not a Node compatibility question; an API the
        // declared floor already has is not a question at all.
        if (entry.node === null || entry.node <= nodeFloor) continue;
        const floorText = declaredFloor === null
          ? `engines.node is not declared — assuming Node ${ASSUMED_NODE_MAJOR}`
          : `package.json engines.node "${engineRange}" admits Node ${declaredFloor}`;
        result.addCheck(`compat:js:${api}:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: `API "${api}" needs Node ${entry.node}+ but ${floorText}`,
          suggestion: `Raise engines.node to ">=${entry.node}" or avoid "${api}" on the supported floor`,
        });
        continue;
      }
      result.addCheck(`compat:js:${api}:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: `API "${api}" (available since ${since}) may not work in all target browsers`,
        suggestion: `Check caniuse.com for "${api}" and add polyfill if needed`,
      });
    }

    // Top-level await needs an ES module: `.mjs` / `.mts`, or a `.js` / `.ts`
    // owned by a manifest with `"type": "module"`. Matched on the masked
    // source so an `await` at column 0 inside a template literal (a test
    // writing a fixture) is not a statement.
    const ext = path.posix.extname(relFwd).toLowerCase();
    const esm = ext === '.mjs' || ext === '.mts' || Boolean(owner && owner.json && owner.json.type === 'module');
    if (/^await\s/m.test(masked) && !esm) {
      result.addCheck(`compat:js:top-level-await:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: 'Top-level await requires ES modules',
        suggestion: 'Use .mjs extension or set "type": "module" in package.json',
      });
    }
  }

  _checkResponsiveDesign(projectRoot, cssFiles, result) {
    let hasMediaQueries = false;
    let hasViewportMeta = false;

    for (const file of cssFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('@media')) hasMediaQueries = true;
    }

    // Check for viewport meta in HTML files
    const htmlFiles = this._collectFiles(projectRoot, ['.html', '.htm']);
    for (const file of htmlFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('viewport')) hasViewportMeta = true;
    }

    // Also check Next.js/React layout files
    const layoutFiles = this._collectFiles(projectRoot, ['.tsx', '.jsx']);
    for (const file of layoutFiles) {
      if (!path.basename(file).includes('layout')) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('viewport')) hasViewportMeta = true;
    }

    if (cssFiles.length > 0 && !hasMediaQueries) {
      result.addCheck('compat:responsive', false, {
        severity: 'warning',
        message: 'No @media queries found — site may not be responsive',
        suggestion: 'Add responsive breakpoints for mobile, tablet, and desktop',
      });
    }

    if ((htmlFiles.length > 0 || layoutFiles.length > 0) && !hasViewportMeta) {
      result.addCheck('compat:viewport-meta', false, {
        severity: 'warning',
        message: 'No viewport meta tag found in HTML or layout files — mobile browsers may render at desktop width',
        suggestion: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to your HTML head (or the Next.js viewport export in layout.tsx)',
      });
    }

    // Check minimum touch target sizes in CSS
    for (const file of cssFiles) {
      const relPath = repoRelative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      // Look for very small fixed dimensions on interactive elements
      const smallSizePattern = /(?:width|height)\s*:\s*(\d+)px/g;
      let match;
      while ((match = smallSizePattern.exec(content)) !== null) {
        const size = parseInt(match[1]);
        if (size > 0 && size < 44) {
          // Only flag once per file
          result.addCheck(`compat:touch-target:${relPath}`, false, {
            file: relPath,
            severity: 'info',
            message: `Small fixed dimension (${size}px) — may violate 44x44px touch target minimum`,
            suggestion: 'Ensure interactive elements are at least 44x44px for touch devices',
          });
          break;
        }
      }
    }
  }

  _checkPolyfills(projectRoot, result) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      // Check for common polyfill/transpilation tools
      const hasPolyfill = deps['core-js'] || deps['regenerator-runtime'] || deps['@babel/polyfill'];
      const hasBabel = deps['@babel/core'] || deps['@babel/preset-env'];
      const hasSwc = deps['@swc/core'];

      if (!hasBabel && !hasSwc && !hasPolyfill) {
        result.addCheck('compat:transpiler', false, {
          severity: 'info',
          message: 'No transpiler (Babel/SWC) detected — modern JS features may not work in older browsers',
          suggestion: 'Consider adding @babel/core or @swc/core for broader browser support',
        });
      }
    } catch { /* error-ok — unreadable package.json — the syntax module reports it; this check has nothing to read */ }
  }
}

CompatibilityModule.minNodeMajor = minNodeMajor;
CompatibilityModule.MODERN_APIS = MODERN_APIS;

module.exports = CompatibilityModule;
