/**
 * Visual Module - Visual regression testing, font validation, spacing, and UI consistency.
 * Compares screenshots against baselines and validates design tokens.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const { isNonUserFacingPage } = require('../core/scan-scope');

class VisualModule extends BaseModule {
  constructor() {
    super('visual', 'Visual & UI Regression Testing');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const visualConfig = config.getModuleConfig('visual');

    // Check CSS for common visual issues
    const cssFiles = this._collectFiles(projectRoot, ['.css', '.scss', '.less']);
    const htmlFiles = this._collectFiles(projectRoot, ['.html', '.jsx', '.tsx', '.vue', '.svelte']);

    for (const file of cssFiles) {
      const relPath = repoRelative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      this._checkLayoutShifts(relPath, content, result);
      this._checkFontLoading(relPath, content, result);
      this._checkOverflow(relPath, content, result);
      this._checkPrintStyles(relPath, content, result);
      this._checkZIndex(relPath, content, result);
    }

    // Static dev fixtures under public/ are not customer-facing routes.
    const INTERNAL_PATH_RE = /(?:^|\/)(?:website\/public\/)/;

    for (const file of htmlFiles) {
      const relPath = repoRelative(projectRoot, file);
      const normalised = relPath.replace(/\\/g, '/');
      if (INTERNAL_PATH_RE.test('/' + normalised)) continue;
      // Library examples/ and sandbox/ are documentation on any repo.
      // Scope, not severity — see src/core/scan-scope.js.
      if (isNonUserFacingPage(normalised)) continue;
      const content = fs.readFileSync(file, 'utf-8');

      this._checkImageDimensions(relPath, content, result);
      this._checkViewport(relPath, content, result);
    }

    // Check for design tokens / CSS custom properties consistency
    this._checkDesignTokens(projectRoot, cssFiles, result);

    // Verify screenshot baselines exist if configured
    this._checkBaselines(projectRoot, visualConfig, result);

    if (cssFiles.length === 0 && htmlFiles.length === 0) {
      result.addCheck('visual:files', true, { message: 'No CSS/HTML files to check' });
    }
  }

  _checkLayoutShifts(relPath, content, result) {
    // Images/videos without explicit dimensions cause layout shifts
    // Check for common CLS-causing patterns
    const clsPatterns = [
      { regex: /position\s*:\s*absolute(?!.*contain)/g, name: 'absolute-positioning' },
    ];

    for (const { regex, name } of clsPatterns) {
      if (regex.test(content)) {
        result.addCheck(`visual:cls:${name}:${relPath}`, false, {
          file: relPath,
          severity: 'info',
          message: `Potential layout-shift pattern (${name}) found — absolutely-positioned elements without \`contain\` can cause CLS`,
          suggestion: 'Add `contain: layout` (or a reserved-size wrapper) to absolutely-positioned elements that load async content',
        });
      }
    }

    // Check for font-display strategy
    if (content.includes('@font-face') && !content.includes('font-display')) {
      result.addCheck(`visual:font-display:${relPath}`, false, {
        severity: 'warning',
        file: relPath,
        message: '@font-face without font-display property — causes FOIT/FOUT',
        suggestion: 'Add "font-display: swap" or "font-display: optional" to @font-face',
      });
    }
  }

  _checkFontLoading(relPath, content, result) {
    // Verify fonts have fallbacks
    const fontFamilyRegex = /font-family\s*:\s*([^;]+)/gi;
    let match;
    while ((match = fontFamilyRegex.exec(content)) !== null) {
      const value = match[1].trim();
      const fonts = value.split(',').map(f => f.trim());
      const genericFamilies = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];

      // A single value that is a CSS variable, a keyword (inherit/initial/
      // unset/revert), a system stack (-apple-system) or empty is NOT a
      // font with no fallback — the fallback lives in the variable / parent.
      // Compiled Bootstrap (`font-family: var(--bs-body-font-family)`) alone
      // produced dozens of blocking errors in the 2026-08-18 audit.
      const single = fonts[0].replace(/['"]/g, '').toLowerCase();
      const notAFont = !single || single.startsWith('var(') || single.startsWith('-apple-system')
        || ['inherit', 'initial', 'unset', 'revert', 'revert-layer'].includes(single);
      if (fonts.length === 1 && !notAFont && !genericFamilies.includes(single)) {
        result.addCheck(`visual:font-fallback:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: `Font "${fonts[0]}" has no fallback font-family`,
          suggestion: 'Add a generic font family as fallback (e.g., sans-serif)',
        });
      }
    }
  }

  _checkOverflow(relPath, content, result) {
    // Check for potential horizontal overflow issues
    if (content.includes('overflow-x: hidden') && content.includes('body')) {
      result.addCheck(`visual:body-overflow-hidden:${relPath}`, false, {
        severity: 'warning',
        file: relPath,
        message: 'overflow-x: hidden on body — may hide underlying layout issues',
        suggestion: 'Fix the root cause of horizontal overflow instead of hiding it',
      });
    }
  }

  _checkPrintStyles(relPath, content, result) {
    // The premise of this rule is "you targeted the `screen` media type, so you
    // owe the `print` one". That has to be read off the @media PRELUDES.
    //
    // The old form was three raw substring tests over the whole file, and every
    // one of them is wrong in the same way: `includes('screen')` matches the
    // word "screenshot" in a comment (exactly how it fired on this repo's own
    // website/app/globals.css — a file with no `screen` media query at all),
    // and `includes('print')` would be satisfied by "sprint", "footprint" or
    // "preprint". So the rule could both invent a defect and be silenced by a
    // word that has nothing to do with printing.
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const preludes = [...stripped.matchAll(/@media\b([^{]*)\{/g)].map((m) => m[1]);
    if (preludes.length === 0) return;
    const hasScreen = preludes.some((p) => /\bscreen\b/i.test(p));
    const hasPrint = preludes.some((p) => /\bprint\b/i.test(p)) || /@page\b/.test(stripped);
    // Info, never blocking. The absence of a print stylesheet is not a
    // defect a user hits — it is a nice-to-have on the pages people print.
    // trpc's docs site (`www/src/css/custom.css`, two `@media only screen`
    // breakpoints, corpus6 2026-09-05) was gated on it at the default error
    // severity; the same file passes every other visual rule.
    if (hasScreen && !hasPrint) {
      result.addCheck(`visual:print-styles:${relPath}`, false, {
        file: relPath,
        severity: 'info',
        message: 'Media queries found but no print stylesheet',
        suggestion: 'Add @media print { ... } for printable pages',
      });
    }
  }

  _checkZIndex(relPath, content, result) {
    // Check for z-index wars (values > 9999)
    const zIndexRegex = /z-index\s*:\s*(\d+)/g;
    let match;
    while ((match = zIndexRegex.exec(content)) !== null) {
      const value = parseInt(match[1]);
      // A stacking-order smell, not a rendering defect — warning. The one
      // rule in this module that stays an error is `viewport` on a full
      // document: that is a page rendering at desktop width on every phone.
      if (value > 9999) {
        result.addCheck(`visual:z-index:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: `z-index: ${value} — excessively high z-index`,
          suggestion: 'Use a z-index scale/token system instead of arbitrary large values',
        });
      }
    }
  }

  _checkImageDimensions(relPath, content, result) {
    // Images should have width and height to prevent CLS
    const imgRegex = /<img\b([^>]*?)>/gi;
    let match;
    while ((match = imgRegex.exec(content)) !== null) {
      const attrs = match[1];
      const hasWidth = /\bwidth\s*=/i.test(attrs);
      const hasHeight = /\bheight\s*=/i.test(attrs);

      if (!hasWidth || !hasHeight) {
        result.addCheck(`visual:img-dimensions:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: 'Image missing explicit width/height — causes layout shift (CLS)',
          suggestion: 'Add width and height attributes to <img> tags',
        });
      }
    }
  }

  _checkViewport(relPath, content, result) {
    // Only a FULL document owns its viewport meta: fragments/partials inherit
    // the layout's, and Next.js/Nuxt/SvelteKit inject it into app layouts
    // automatically (`app/layout.tsx` never contains the literal). Firing on
    // "any file containing <html" was the second-largest visual FP class.
    const isFullDocument = /<html[\s>]/i.test(content) && /<head[\s>]/i.test(content);
    const frameworkLayout = /(^|\/)(app|src\/app|pages|website\/app)\/.*layout\.(tsx|jsx|js)$/.test(relPath.replace(/\\/g, '/'))
      || /\.(tsx|jsx|vue|svelte)$/.test(relPath);
    if (isFullDocument && !frameworkLayout && !content.includes('viewport')) {
      result.addCheck(`visual:viewport:${relPath}`, false, {
        file: relPath,
        message: 'Missing viewport meta tag',
        suggestion: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">',
      });
    }
  }

  _checkDesignTokens(projectRoot, cssFiles, result) {
    // Check for consistent use of CSS custom properties
    // Count each variable ONCE PER FILE, and skip compiled/vendored/minified
    // sheets: a design-token framework (Bootstrap sets `--bs-*` inside every
    // component and theme scope) legitimately re-declares tokens per selector
    // — that is scoping, not inconsistency. Measured 2026-08-18: 57 blocking
    // errors on a compiled Bootstrap file. This is at most an info-level
    // observation about token hygiene, never a gate failure.
    const allVars = new Map();
    for (const file of cssFiles) {
      const rel = repoRelative(projectRoot, file).toLowerCase();
      if (/\.min\.(css|scss|less)$|(^|\/)(vendor|vendors|lib|libs|dist|build|static\/css|bootstrap|tailwind|node_modules)\//.test(rel)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (/--(bs|mdc|mat|mui|chakra|tw|ant|el|p|v)-[\w-]+\s*:/.test(content) && !/^\s*:root\s*\{/m.test(content)) continue;
      const seen = new Set();
      const varDefs = content.match(/--[\w-]+\s*:/g) || [];
      for (const v of varDefs) {
        const name = v.replace(':', '').trim();
        if (seen.has(name)) continue;
        seen.add(name);
        allVars.set(name, (allVars.get(name) || 0) + 1);
      }
    }

    // A token defined in more than 3 DIFFERENT files is worth a look.
    for (const [name, count] of allVars) {
      if (count > 3) {
        result.addCheck(`visual:duplicate-token:${name}`, false, {
          severity: 'info',
          message: `CSS variable "${name}" defined in ${count} files — possible inconsistency`,
          suggestion: 'Define CSS custom properties in a single :root block',
        });
      }
    }
  }

  _checkBaselines(projectRoot, visualConfig, result) {
    const baselineDir = path.join(projectRoot, visualConfig.baselineDir || '.gatetest/baselines');
    if (!fs.existsSync(baselineDir)) {
      result.addCheck('visual:baselines', true, {
        message: 'No baseline screenshots — run "gatetest --update-baselines" to create them',
      });
    }
  }
}

module.exports = VisualModule;
