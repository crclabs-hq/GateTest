/**
 * Compatibility Module - Deep browser and platform compatibility analysis.
 * Scans CSS for vendor prefix issues, modern feature usage without fallbacks,
 * JS API compatibility, and Node.js version constraints.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

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
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');
      this._checkCssCompat(relPath, content, result);
    }

    const jsFiles = this._collectFiles(projectRoot, ['.js', '.ts', '.jsx', '.tsx']);
    for (const file of jsFiles) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');
      this._checkJsCompat(relPath, content, result);
    }

    this._checkResponsiveDesign(projectRoot, cssFiles, result);
    this._checkPolyfills(projectRoot, result);
  }

  _checkBrowserslist(projectRoot, result) {
    const hasConfig =
      fs.existsSync(path.join(projectRoot, '.browserslistrc')) ||
      (() => {
        const pkgPath = path.join(projectRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          return !!pkg.browserslist;
        } catch { return false; }
      })();

    if (!hasConfig) {
      result.addCheck('compat:browserslist', false, {
        severity: 'warning',
        message: 'No browserslist configuration found',
        suggestion: 'Add a .browserslistrc or "browserslist" field in package.json',
      });
    } else {
      result.addCheck('compat:browserslist', true);
    }
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
    } catch { /* ignore */ }
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

  _checkJsCompat(relPath, content, result) {
    // Modern JS APIs that may need polyfills
    const modernApis = [
      { api: 'structuredClone', regex: /\bstructuredClone\s*\(/g, since: 'Chrome 98' },
      { api: 'Array.at()', regex: /\.at\s*\(\s*-/g, since: 'Chrome 92' },
      { api: 'Object.hasOwn', regex: /Object\.hasOwn\s*\(/g, since: 'Chrome 93' },
      { api: 'AbortSignal.timeout', regex: /AbortSignal\.timeout\s*\(/g, since: 'Chrome 103' },
      { api: 'navigator.share', regex: /navigator\.share\s*\(/g, since: 'Limited support' },
      { api: 'Array.findLast', regex: /\.findLast\s*\(/g, since: 'Chrome 97' },
      { api: 'Array.toReversed', regex: /\.toReversed\s*\(/g, since: 'Chrome 110' },
      { api: 'Array.toSorted', regex: /\.toSorted\s*\(/g, since: 'Chrome 110' },
      { api: 'Array.toSpliced', regex: /\.toSpliced\s*\(/g, since: 'Chrome 110' },
      { api: 'Promise.withResolvers', regex: /Promise\.withResolvers\s*\(/g, since: 'Chrome 119' },
      { api: 'Set methods (union/intersection)', regex: /\.union\s*\(|\.intersection\s*\(/g, since: 'Chrome 122' },
      { api: 'Iterator helpers', regex: /\.map\s*\(.*\)\.filter\s*\(/g, since: 'Very new' },
      // \b after the v is required — without it, ANY two-slash path segment
      // followed by a word starting with 'v' false-matches (/lib/validators,
      // /api/version, /components/value, ...). Confirmed on this repo: 202
      // of 237 compatibility findings were this bug (KI #50).
      { api: 'RegExp v flag', regex: /\/[^/]+\/[gimsuy]*v\b/g, since: 'Chrome 112' },
    ];

    for (const { api, regex, since } of modernApis) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        result.addCheck(`compat:js:${api}:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: `API "${api}" (available since ${since}) may not work in all target browsers`,
          suggestion: `Check caniuse.com for "${api}" and add polyfill if needed`,
        });
      }
    }

    // Check for top-level await (only in ESM)
    if (content.match(/^await\s/m) && !relPath.endsWith('.mjs')) {
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

    // Check minimum touch target sizes in CSS
    for (const file of cssFiles) {
      const relPath = path.relative(projectRoot, file);
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

      if (!hasBabel && !hasSwc) {
        result.addCheck('compat:transpiler', false, {
          severity: 'info',
          message: 'No transpiler (Babel/SWC) detected — modern JS features may not work in older browsers',
          suggestion: 'Consider adding @babel/core or @swc/core for broader browser support',
        });
      }
    } catch { /* ignore */ }
  }
}

module.exports = CompatibilityModule;
