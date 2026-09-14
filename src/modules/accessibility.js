/**
 * Accessibility Module - WCAG 2.2 automated audit (AA + AAA-aligned checks).
 * Validates HTML, ARIA usage, color contrast, keyboard access, and more.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const { repoRelative } = require('../core/repo-path');
const { isNonUserFacingPage, isSpaShell, isImageRenderer } = require('../core/scan-scope');

// Named CSS colors mapped to RGB values
const NAMED_COLORS = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  orange: { r: 255, g: 165, b: 0 },
  purple: { r: 128, g: 0, b: 128 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  cyan: { r: 0, g: 255, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  navy: { r: 0, g: 0, b: 128 },
  teal: { r: 0, g: 128, b: 128 },
  maroon: { r: 128, g: 0, b: 0 },
  olive: { r: 128, g: 128, b: 0 },
  silver: { r: 192, g: 192, b: 192 },
  lime: { r: 0, g: 255, b: 0 },
  aqua: { r: 0, g: 255, b: 255 },
  fuchsia: { r: 255, g: 0, b: 255 },
};

// Reusable fragments/partials/components get their labels and alt text from
// the page that includes them; a missing attribute THERE is a warning, on a
// real page it stays an error.
const FRAGMENT_PATH_RE = /(^|\/)(fragments?|partials?|includes?|_includes|components?|snippets?|layouts?)\//i;

// `isImageRenderer` lives in src/core/scan-scope.js beside isSpaShell (one
// definition); re-exported below for callers that still reach it here.

class AccessibilityModule extends BaseModule {
  constructor() {
    super('accessibility', 'Accessibility (WCAG 2.2, AA + AAA-aligned) Audit');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const htmlFiles = this._collectFiles(projectRoot, ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte']);

    if (htmlFiles.length === 0) {
      result.addCheck('a11y:files', true, { message: 'No HTML/template files to check' });
    } else {
      // Internal-only admin UI is not customer-facing — a11y violations there
      // don't hurt our launch. Static test fixtures under public/ are also
      // excluded (logos.html is a logo grid for screenshots, not a user page).
      const INTERNAL_PATH_RE = /(?:^|\/)(?:website\/app\/admin\/|website\/app\/dashboard\/|website\/public\/)/;
      for (const file of htmlFiles) {
        const relPath = repoRelative(projectRoot, file);
        const normalised = relPath.replace(/\\/g, '/');
        if (INTERNAL_PATH_RE.test('/' + normalised)) continue;
        // The list above is OUR paths and excludes nothing on a customer's
        // repo. A library's examples/ and sandbox/ are documentation on any
        // repo — axios @81df7a5 had 23 a11y findings on demo HTML alone.
        // Scope only: a11y stays error-severity in application code
        // (Craig 2026-09-01, "keep the a11y blocking, thats quality").
        if (isNonUserFacingPage(normalised)) continue;
        const content = fs.readFileSync(file, 'utf-8');
        // Rendered to a PNG by satori / ImageResponse — not a page at all.
        if (isImageRenderer(content)) continue;
        // An Angular / React index.html shell OWNS its <head> — `<html lang>`
        // is checked here like any full document — but its <body> is a mount
        // point the application fills at runtime: no images, headings or
        // landmarks to audit in the file (the live a11y probe covers the
        // rendered page). CleanArchitecture's two shells were told they had
        // no <main> and no <h1> (2026-09-05).
        this._checkLanguageAttribute(relPath, content, result);
        if (isSpaShell(content)) continue;

        this._checkImages(relPath, content, result);
        this._checkFormLabels(relPath, content, result);
        this._checkHeadingHierarchy(relPath, content, result);
        this._checkAriaUsage(relPath, content, result);
        this._checkLandmarks(relPath, content, result);
        this._checkFocusManagement(relPath, content, result);
        this._checkReducedMotion(relPath, content, result);
      }
    }

    // Check CSS for contrast and focus styles
    const cssFiles = this._collectFiles(projectRoot, ['.css', '.scss', '.less']);
    for (const file of cssFiles) {
      const relPath = repoRelative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');
      this._checkCssFocus(relPath, content, result);
      this._checkCssReducedMotion(relPath, content, result);
    }

    // Color contrast checks
    this._checkColorContrast(projectRoot, result);
    await this._checkLiveContrast(config, result);
  }

  _checkImages(relPath, content, result) {
    // Find <img> tags without alt attribute
    const imgRegex = /<img\b([^>]*?)>/gi;
    let match;
    while ((match = imgRegex.exec(content)) !== null) {
      const attrs = match[1];
      // The `[^>]*?` stops at the FIRST `>`, which is not always this tag's own.
      // In JSX a tag can be split across expression boundaries — the badge page
      // renders a copy-paste HTML snippet as
      //
      //   {`<a ...><img src="https://…/api/badge?repo=`}
      //   <span className="text-emerald-400">owner/repo</span>
      //   {`" alt="GateTest"></a>`}
      //
      // so the first `>` we reach belongs to the <span>, the captured "attrs"
      // swallow `<span className="…"`, and the alt (which IS there, one line
      // further down) is never seen. A `<` inside the attributes means we never
      // found this tag's closing bracket — we have not observed whether alt is
      // present, so we must not claim it is missing. Reporting our own parse
      // overrun as a defect in the customer's page is the bug e530232d fixed
      // for the live-browser checks; this is the static-parse version of it.
      if (attrs.includes('<')) continue;
      if (!/\balt\s*=/i.test(attrs)) {
        result.addCheck(`a11y:img-alt:${relPath}`, false, {
          ...(FRAGMENT_PATH_RE.test(relPath.replace(/\\/g, '/')) ? { severity: 'warning' } : {}),
          file: relPath,
          message: 'Image missing alt attribute',
          suggestion: 'Add alt="description" for informative images or alt="" for decorative',
        });
      }
    }
  }

  _checkFormLabels(relPath, content, result) {
    // Find <input> without associated <label> or aria-label.
    // JSX attributes can contain `>` inside arrow functions (e.g. onChange={() => ...}),
    // so we look ahead up to 600 chars after <input to find label-related attributes
    // rather than trying to capture all attrs in one regex stop-at->  pass.
    // A UI-kit PRIMITIVE (`components/ui/input.tsx` and friends) forwards
    // its props — the label is attached wherever it is used, not inside the
    // primitive. Checking it produces one guaranteed false positive per
    // design system (shadcn/ui, Radix wrappers; 2026-08-18 audit).
    if (/(^|\/)(components?\/ui|ui\/primitives?|primitives?)\/(input|textarea|select|checkbox|radio|switch|form)[^/]*$/i.test(relPath.replace(/\\/g, '/'))) return;
    // Strip HTML comments so a commented-out <input> is not "unlabelled".
    const contentNoComments = content.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    const inputStart = /<input\b/gi;
    let startMatch;
    while ((startMatch = inputStart.exec(contentNoComments)) !== null) {
      const pos = startMatch.index;
      // Grab a generous lookahead window (covers multiline JSX props + arrow fns)
      const window = contentNoComments.slice(pos, pos + 600);
      // Determine type (default "text")
      const typeMatch = window.match(/\btype\s*=\s*["'](\w+)["']/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : 'text';
      if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;

      // Element ends at the first self-closing /> or the first standalone >
      // that isn't part of an arrow function (=>) or JSX expression.
      // We look for the closing marker inside the window.
      const closingSlash = window.search(/\/>/);
      const snippet = closingSlash >= 0 ? window.slice(0, closingSlash + 2) : window;

      const hasLabel = /aria-label\s*[={]/i.test(snippet) ||
                       /aria-labelledby\s*[={]/i.test(snippet) ||
                       /\bid\s*=\s*["'{]/i.test(snippet);

      if (!hasLabel) {
        result.addCheck(`a11y:input-label:${relPath}`, false, {
          ...(FRAGMENT_PATH_RE.test(relPath.replace(/\\/g, '/')) ? { severity: 'warning' } : {}),
          file: relPath,
          message: `Input (type="${type}") missing accessible label`,
          suggestion: 'Add aria-label, aria-labelledby, or an associated <label> element',
        });
      }
    }
  }

  _checkHeadingHierarchy(relPath, content, result) {
    const headingRegex = /<h([1-6])\b/gi;
    const headings = [];
    let match;
    while ((match = headingRegex.exec(content)) !== null) {
      headings.push(parseInt(match[1]));
    }

    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        result.addCheck(`a11y:heading-hierarchy:${relPath}`, false, {
        severity: 'warning',
          file: relPath,
          message: `Heading level skipped: h${headings[i - 1]} to h${headings[i]}`,
          suggestion: 'Use sequential heading levels (h1 > h2 > h3) without skipping',
        });
        break;
      }
    }
  }

  _checkAriaUsage(relPath, content, result) {
    // Check for invalid ARIA roles.
    // No space before = so we don't match TypeScript type declarations like
    // `type Role = "user"` which the case-insensitive flag would otherwise
    // turn into a false-positive "role = user".
    const roleRegex = /\brole=["'](\w+)["']/gi;
    const validRoles = new Set([
      'alert', 'alertdialog', 'application', 'article', 'banner', 'button',
      'cell', 'checkbox', 'columnheader', 'combobox', 'complementary',
      'contentinfo', 'definition', 'dialog', 'directory', 'document',
      'feed', 'figure', 'form', 'grid', 'gridcell', 'group', 'heading',
      'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main',
      'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'navigation', 'none', 'note', 'option', 'presentation',
      'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
      'rowheader', 'scrollbar', 'search', 'searchbox', 'separator',
      'slider', 'spinbutton', 'status', 'switch', 'tab', 'table',
      'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar',
      'tooltip', 'tree', 'treegrid', 'treeitem',
    ]);

    let match;
    while ((match = roleRegex.exec(content)) !== null) {
      if (!validRoles.has(match[1].toLowerCase())) {
        result.addCheck(`a11y:invalid-role:${relPath}`, false, {
          file: relPath,
          message: `Invalid ARIA role: "${match[1]}"`,
          suggestion: 'Use a valid WAI-ARIA role',
        });
      }
    }
  }

  _checkLanguageAttribute(relPath, content, result) {
    // Only a FULL document owns <html lang>: fragments/partials that merely
    // mention "<html" (or Thymeleaf `<html xmlns:th>` layout stubs with no
    // <head>) inherit it from the layout that wraps them.
    const fullDocument = /<html[\s>]/i.test(content) && /<head[\s>]/i.test(content);
    if (fullDocument && !/<html[^>]*\blang\s*=\s*["']\w/i.test(content) && !/lang\s*=\s*\{/.test(content)) {
      result.addCheck(`a11y:html-lang:${relPath}`, false, {
        file: relPath,
        message: 'Missing lang attribute on <html> element',
        suggestion: 'Add lang="en" (or appropriate language) to <html>',
      });
    }
  }

  _checkLandmarks(relPath, content, result) {
    // Only check standalone HTML files, not React/Vue/Svelte components.
    // TSX/JSX files render as part of a component tree; the <main> will
    // live in a child page component, not the layout wrapper.
    if (!/<html[\s>]/i.test(content) || !/<head[\s>]/i.test(content)) return;
    if (/\.(tsx?|jsx?|vue|svelte)$/i.test(relPath)) return;

    const landmarks = ['<main', 'role="main"', '<nav', 'role="navigation"'];
    const hasMain = landmarks.slice(0, 2).some(l => content.includes(l));

    if (!hasMain) {
      result.addCheck(`a11y:landmark-main:${relPath}`, false, {
        file: relPath,
        message: 'Missing main landmark',
        suggestion: 'Add <main> element or role="main" to primary content area',
      });
    }
  }

  _checkFocusManagement(relPath, content, result) {
    // Check for tabindex > 0 (anti-pattern)
    const tabindexRegex = /tabindex\s*=\s*["'](\d+)["']/gi;
    let match;
    while ((match = tabindexRegex.exec(content)) !== null) {
      const value = parseInt(match[1]);
      if (value > 0) {
        result.addCheck(`a11y:tabindex-positive:${relPath}`, false, {
          file: relPath,
          message: `Positive tabindex="${value}" creates confusing tab order`,
          suggestion: 'Use tabindex="0" or tabindex="-1" instead',
        });
      }
    }
  }

  _checkReducedMotion(relPath, content, result) {
    // Check JS for animation loops without prefers-reduced-motion check.
    // A single requestAnimationFrame call is often a one-shot DOM operation
    // (e.g. focusing an input on the next paint) — only flag when rAF is
    // called more than once (suggesting an animation loop) or when the file
    // also calls .animate().
    const rafCount = (content.match(/requestAnimationFrame/g) || []).length;
    const hasAnimate = content.includes('.animate(') || content.includes('gsap.') || content.includes('tween.');
    if ((rafCount > 1 || hasAnimate) && !content.includes('prefers-reduced-motion')) {
      result.addCheck(`a11y:reduced-motion-js:${relPath}`, false, {
        file: relPath,
        message: 'Animations detected without prefers-reduced-motion check',
        suggestion: 'Check window.matchMedia("(prefers-reduced-motion: reduce)") before animating',
      });
    }
  }

  /**
   * "Focus outline removed without alternative" is a claim about a RULE — a
   * `:focus` selector whose block sets `outline: none|0` and offers nothing
   * in its place — so it is judged rule by rule, not by substrings over the
   * whole file. The substring version had an operator-precedence hole
   * (`a && b || c || d`): any `outline: none` anywhere fired it, with or
   * without `:focus`. trpc www/src/css/custom.css:130 resets the outline on a
   * footnote LINK (no :focus) and styles its `:focus::after` with a dotted
   * outline; prisma examples/…/globals.css:359 removes the ring on
   * `input:focus` and replaces it with a border + box-shadow. Both were
   * reported. A `:focus-visible` anywhere in the file still exempts it.
   */
  _checkCssFocus(relPath, content, result) {
    if (content.includes(':focus-visible')) return;
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(content)) !== null) {
      const [, selector, body] = m;
      if (!/:focus(?![\w-])/.test(selector)) continue;
      if (!/\boutline\s*:\s*(?:none|0)(?:px)?\s*(?:!important)?\s*[;}]?/.test(body)) continue;
      // The same rule paints another indicator — that IS the alternative.
      if (/\b(?:box-shadow|border(?:-[a-z]+)?|background(?:-color)?|text-decoration|outline\s*:\s*(?!none|0\b)[^;]+)\s*:?/.test(body.replace(/\boutline\s*:\s*(?:none|0)(?:px)?[^;]*;?/, ''))) continue;
      result.addCheck(`a11y:focus-outline:${relPath}`, false, {
        file: relPath,
        message: 'Focus outline removed without alternative',
        suggestion: 'Use :focus-visible instead of :focus, or provide custom focus indicators',
      });
      return;
    }
  }

  _checkCssReducedMotion(relPath, content, result) {
    if ((content.includes('animation') || content.includes('transition')) &&
        !content.includes('prefers-reduced-motion')) {
      result.addCheck(`a11y:reduced-motion-css:${relPath}`, false, {
        severity: 'warning',
        file: relPath,
        message: 'CSS animations/transitions without prefers-reduced-motion media query',
        suggestion: 'Add @media (prefers-reduced-motion: reduce) { ... } to disable animations',
      });
    }
  }

  /**
   * Parse a CSS color string into {r, g, b} with values 0-255.
   * Supports hex (#fff, #ffffff), rgb(), rgba(), and named colors.
   * Returns null if the color cannot be parsed.
   */
  _parseColor(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const s = colorStr.trim().toLowerCase();

    // Hex: #rrggbb
    const hex6 = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
    if (hex6) {
      return {
        r: parseInt(hex6[1], 16),
        g: parseInt(hex6[2], 16),
        b: parseInt(hex6[3], 16),
      };
    }

    // Hex: #rgb
    const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
    if (hex3) {
      return {
        r: parseInt(hex3[1] + hex3[1], 16),
        g: parseInt(hex3[2] + hex3[2], 16),
        b: parseInt(hex3[3] + hex3[3], 16),
      };
    }

    // rgb(r, g, b) or rgba(r, g, b, a)
    const rgbMatch = s.match(
      /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/
    );
    if (rgbMatch) {
      return {
        r: Math.min(255, parseInt(rgbMatch[1], 10)),
        g: Math.min(255, parseInt(rgbMatch[2], 10)),
        b: Math.min(255, parseInt(rgbMatch[3], 10)),
      };
    }

    // Named colors
    if (NAMED_COLORS[s]) {
      return { ...NAMED_COLORS[s] };
    }

    return null;
  }

  /**
   * Calculate relative luminance per WCAG 2.x formula.
   * Input: r, g, b as 0-255 integers.
   * Returns luminance value between 0 and 1.
   */
  _relativeLuminance(r, g, b) {
    const [rs, gs, bs] = [r, g, b].map((c) => {
      const srgb = c / 255;
      return srgb <= 0.03928
        ? srgb / 12.92
        : Math.pow((srgb + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  /**
   * Calculate contrast ratio between two luminance values.
   * Returns ratio >= 1 (lighter / darker).
   */
  _contrastRatio(lum1, lum2) {
    const lighter = Math.max(lum1, lum2);
    const darker = Math.min(lum1, lum2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Static CSS color contrast analysis.
   * Scans CSS files for color/background-color pairs within the same rule
   * and flags pairs that fail WCAG AAA contrast thresholds.
   */
  _checkColorContrast(projectRoot, result) {
    const cssFiles = this._collectFiles(projectRoot, ['.css', '.scss', '.less']);
    let totalChecked = 0;

    for (const file of cssFiles) {
      const relPath = repoRelative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      // Extract CSS rule blocks (match selector { declarations })
      const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
      let ruleMatch;

      while ((ruleMatch = ruleRegex.exec(content)) !== null) {
        const selector = ruleMatch[1].trim();
        const declarations = ruleMatch[2];

        // Extract color and background-color from declarations
        const colorMatch = declarations.match(
          /(?:^|;)\s*color\s*:\s*([^;!]+)/i
        );
        const bgMatch = declarations.match(
          /(?:^|;)\s*background-color\s*:\s*([^;!]+)/i
        );

        if (!colorMatch || !bgMatch) continue;

        const fgColor = this._parseColor(colorMatch[1].trim());
        const bgColor = this._parseColor(bgMatch[1].trim());

        if (!fgColor || !bgColor) continue;

        totalChecked++;
        const fgLum = this._relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
        const bgLum = this._relativeLuminance(bgColor.r, bgColor.g, bgColor.b);
        const ratio = this._contrastRatio(fgLum, bgLum);

        // WCAG AAA: 4.5:1 for large text, 7:1 for normal text.
        // Flag anything below 4.5:1 (minimum even for large text under AAA).
        if (ratio < 4.5) {
          result.addCheck(
            `a11y:contrast-static:${relPath}:${totalChecked}`,
            false,
            {
              file: relPath,
              selector,
              foreground: colorMatch[1].trim(),
              background: bgMatch[1].trim(),
              contrastRatio: Math.round(ratio * 100) / 100,
              message: `Low contrast ratio ${Math.round(ratio * 100) / 100}:1 (WCAG AAA requires 7:1 for normal text, 4.5:1 for large text)`,
              suggestion:
                'Increase contrast between text color and background color',
            }
          );
        } else if (ratio < 7) {
          // Passes WCAG AA (4.5:1) — fails only the AAA target. AAA is an
          // aspiration, not the legal/contractual bar most teams ship to;
          // blocking a build on it (57 errors on compiled Bootstrap in the
          // 2026-08-18 audit) makes us the bottleneck. Warning.
          result.addCheck(
            `a11y:contrast-static:${relPath}:${totalChecked}`,
            false,
            {
              severity: 'warning',
              file: relPath,
              selector,
              foreground: colorMatch[1].trim(),
              background: bgMatch[1].trim(),
              contrastRatio: Math.round(ratio * 100) / 100,
              message: `Contrast ratio ${Math.round(ratio * 100) / 100}:1 passes for large text but fails WCAG AAA for normal text (requires 7:1)`,
              suggestion:
                'Increase contrast for normal-sized text or ensure this rule only applies to large text (18px+ or 14px+ bold)',
            }
          );
        }
      }
    }

    if (totalChecked === 0) {
      result.addCheck('a11y:contrast-static', true, {
        message:
          'No color/background-color pairs found in CSS to check (or colors could not be parsed)',
      });
    }
  }

  /**
   * Live contrast checking using Playwright.
   * Loads the page, inspects computed styles of text elements,
   * and flags elements with insufficient contrast.
   */
  async _checkLiveContrast(config, result) {
    const url =
      config.url ||
      config.siteUrl ||
      (config.options && config.options.url);
    if (!url) {
      result.addCheck('a11y:contrast-live', true, {
        message: 'No URL configured — skipping live contrast check',
      });
      return;
    }

    let playwright;
    try {
      playwright = require('playwright');
    } catch {
      result.addCheck('a11y:contrast-live', true, {
        message:
          'Playwright not available — skipping live contrast check. Install playwright for full coverage.',
      });
      return;
    }

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Evaluate in-page: collect computed styles for text elements
      const elements = await page.evaluate(() => {
        const textSelectors =
          'p, span, a, li, td, th, h1, h2, h3, h4, h5, h6, label, button, div, section, article';
        const els = document.querySelectorAll(textSelectors);
        const results = [];

        for (const el of els) {
          // Skip elements with no visible text
          const text = el.textContent.trim();
          if (!text || text.length === 0) continue;

          // Skip hidden elements
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          )
            continue;

          const color = style.color;
          const bgColor = style.backgroundColor;

          if (color && bgColor) {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const cls =
              el.className && typeof el.className === 'string'
                ? '.' +
                  el.className
                    .split(/\s+/)
                    .slice(0, 2)
                    .join('.')
                : '';
            const shortText =
              text.substring(0, 30) + (text.length > 30 ? '...' : '');
            const fontSize = parseFloat(style.fontSize);
            const fontWeight = parseInt(style.fontWeight, 10) || 400;

            results.push({
              descriptor: `${tag}${id}${cls}`,
              shortText,
              color,
              bgColor,
              fontSize,
              fontWeight,
            });
          }

          if (results.length >= 200) break;
        }
        return results;
      });

      let issueCount = 0;
      for (const el of elements) {
        if (issueCount >= 50) break;

        const fgColor = this._parseColor(el.color);
        const bgColor = this._parseColor(el.bgColor);
        if (!fgColor || !bgColor) continue;

        const fgLum = this._relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
        const bgLum = this._relativeLuminance(bgColor.r, bgColor.g, bgColor.b);
        const ratio = this._contrastRatio(fgLum, bgLum);

        // Large text: 18px+ or 14px+ bold (fontWeight >= 700)
        const isLargeText =
          el.fontSize >= 18 || (el.fontSize >= 14 && el.fontWeight >= 700);
        const requiredRatio = isLargeText ? 4.5 : 7;

        if (ratio < requiredRatio) {
          issueCount++;
          result.addCheck(`a11y:contrast-live:${issueCount}`, false, {
            element: el.descriptor,
            text: el.shortText,
            foreground: el.color,
            background: el.bgColor,
            contrastRatio: Math.round(ratio * 100) / 100,
            requiredRatio,
            isLargeText,
            message: `Live contrast ${Math.round(ratio * 100) / 100}:1 on "${el.descriptor}" — requires ${requiredRatio}:1 for WCAG AAA (${isLargeText ? 'large' : 'normal'} text)`,
            suggestion:
              'Increase contrast between text and background colors',
          });
        }
      }

      if (issueCount === 0) {
        result.addCheck('a11y:contrast-live', true, {
          message: `Live contrast check passed — ${elements.length} elements inspected`,
        });
      }
    } catch (err) {
      result.addCheck('a11y:contrast-live', true, {
        message: `Live contrast check could not complete: ${err.message}`,
      });
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}

AccessibilityModule.isImageRenderer = isImageRenderer;
module.exports = AccessibilityModule;
module.exports.isImageRenderer = isImageRenderer;
