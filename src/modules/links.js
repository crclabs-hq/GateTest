/**
 * Links Module - Broken link detection for internal and external links.
 * Crawls HTML files and validates all href/src references.
 */

const BaseModule = require('./base-module');
const { isNonUserFacingPage } = require('../core/scan-scope');

/** Blank out fenced code blocks and inline code spans, preserving line count. */
function stripMarkdownCode(md) {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/~~~[\s\S]*?~~~/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}
const fs = require('fs');
const path = require('path');

class LinksModule extends BaseModule {
  constructor() {
    super('links', 'Broken Link Detection');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Scan HTML, JSX, TSX, Vue, Svelte, and Markdown files — not just static HTML
    const allExtensions = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.md', '.mdx'];
    const allFiles = this._collectFiles(projectRoot, allExtensions);

    if (allFiles.length === 0) {
      result.addCheck('links:files', true, { message: 'No template/markup files to check' });
      return;
    }

    const internalLinks = [];
    const externalLinks = new Set();
    const deadLinks = []; // href="#" or javascript:void(0)
    const brokenInternal = [];

    // Internal audit / dev / scaffolding docs that contain redacted /
    // ellipsis-shaped placeholder links — not customer-facing routes.
    const INTERNAL_DOCS_RE = /(?:^|\/)(?:docs\/legal\/|docs\/proofs\/|docs\/marketplace\/|\.claude\/)/;
    for (const file of allFiles) {
      const relPath = path.relative(projectRoot, file);
      if (INTERNAL_DOCS_RE.test('/' + relPath.replace(/\\/g, '/'))) continue;
      // A test/benchmark harness page is not a page a user visits: lodash's
      // perf/index.html links ../node_modules/benchmark/benchmark.js and
      // that is the harness working, not a broken link (corpus gate
      // 2026-09-02). Markdown under those dirs is still read — a README in
      // tests/ is documentation.
      const ext = path.extname(file);
      if (!['.md', '.mdx'].includes(ext) && isNonUserFacingPage(relPath)) continue;
      let content = fs.readFileSync(file, 'utf-8');
      // Links inside code are illustrations — `[text](url)` shown in a fenced
      // block or a backtick span is documentation of syntax, not a link.
      if (['.md', '.mdx'].includes(ext)) content = stripMarkdownCode(content);

      // Pattern set 1: HTML-style href/src attributes (works for HTML, JSX, TSX, Vue, Svelte)
      const hrefRegex = /(?:href|src)\s*=\s*["'{]?\s*["'`]([^"'`{}\s>]+)/gi;
      let match;
      while ((match = hrefRegex.exec(content)) !== null) {
        const link = match[1].trim();
        this._categorizeLink(link, relPath, internalLinks, externalLinks);
      }

      // Pattern set 2: JSX/TSX — to="" prop (Next.js Link, React Router)
      if (['.jsx', '.tsx', '.js', '.ts'].includes(ext)) {
        const toRegex = /\bto\s*=\s*["'`]([^"'`]+)/gi;
        while ((match = toRegex.exec(content)) !== null) {
          const link = match[1].trim();
          this._categorizeLink(link, relPath, internalLinks, externalLinks);
        }
      }

      // Pattern set 3: Markdown links [text](url)
      if (['.md', '.mdx'].includes(ext)) {
        const mdRegex = /\]\(([^)\s]+)/g;
        while ((match = mdRegex.exec(content)) !== null) {
          const link = match[1].trim();
          this._categorizeLink(link, relPath, internalLinks, externalLinks);
        }
      }

      // Pattern set 4: Detect dead href patterns in ALL template files
      const deadPatterns = [
        { regex: /href\s*=\s*["']#["']/g, type: 'href="#"' },
        { regex: /href\s*=\s*["']#!["']/g, type: 'href="#!"' },
        { regex: /href\s*=\s*["']javascript:\s*void\s*\(0\)["']/gi, type: 'javascript:void(0)' },
        { regex: /href\s*=\s*["']javascript:;["']/gi, type: 'javascript:;' },
        { regex: /href\s*=\s*["']\s*["']/g, type: 'empty href' },
      ];

      // Docs/examples that SHOW a placeholder href are not shipping one:
      // an MDX docs page demonstrating `<a href="#">` is documentation.
      const isDocsExample = /(^|\/)(docs?|examples?|content|blog|stories|__stories__|fixtures?)\//i.test(relPath.replace(/\\/g, '/')) || ext === '.mdx' || ext === '.md';
      if (!isDocsExample) {
        const seenDead = new Set();
        for (const { regex, type } of deadPatterns) {
          regex.lastIndex = 0;
          let dm;
          while ((dm = regex.exec(content)) !== null) {
            const line = content.substring(0, dm.index).split(/\r?\n/).length;
            const key = `${relPath}:${line}:${type}`;
            if (seenDead.has(key)) continue; // one report per line, not one per repeat of the same href on that line
            seenDead.add(key);
            deadLinks.push({ href: type, source: relPath, line });
          }
        }
      }
    }

    // Validate internal links (resolve against project root)
    const uniqueInternal = new Map();
    for (const { href, source } of internalLinks) {
      const key = `${source}::${href}`;
      if (uniqueInternal.has(key)) continue;
      uniqueInternal.set(key, { href, source });

      // Skip dynamic routes (e.g., /users/[id])
      if (/[[\]{}$]/.test(href)) continue;
      // Placeholders and non-paths: `LINK`, `www.websitename.com`,
      // `sponsor.imageUrl` (a template variable whose braces were stripped),
      // `string,` (a signature captured from prose). A file reference has a
      // slash or a file extension; a bare token has neither.
      if (!href.includes('/') && !/\.(?:md|mdx|html?|txt|json|ya?ml|png|jpe?g|gif|svg|webp|pdf|css|js|ts|tsx|jsx|mjs|cjs)$/i.test(href)) continue;
      if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/|$)/i.test(href) && !href.startsWith('.')) continue; // bare domain
      // Dependency assets are installed, not committed.
      if (/(?:^|\/)node_modules\//.test(href)) continue;
      // Skip absolute URLs that start with / (these are route paths, not filesystem paths)
      // Only validate relative file references
      if (!href.startsWith('/') && !href.startsWith('http')) {
        // Skip pure anchor references (#section) — page-internal navigation,
        // not file references. They resolve at runtime against the HTML/MDX
        // headings of the current page, not against the filesystem.
        if (href.startsWith('#')) continue;
        // Skip mailto: / tel: / javascript: schemes
        if (/^(mailto|tel|javascript|sms):/i.test(href)) continue;
        // Strip any anchor / query fragment before resolving — links like
        // `./other.md#section` should resolve `./other.md` only.
        const filePart = href.split('#')[0].split('?')[0];
        if (!filePart) continue;
        const resolved = path.resolve(path.dirname(path.join(projectRoot, source)), filePart);
        if (!fs.existsSync(resolved)) {
          brokenInternal.push({ href, source });
        }
      }
    }

    // Report dead links (href="#", javascript:void(0), etc.)
    if (deadLinks.length > 0) {
      result.addCheck('links:dead-links', false, {
        message: `${deadLinks.length} dead/placeholder link(s) found (href="#", javascript:void(0), empty href)`,
        details: deadLinks.slice(0, 30),
        suggestion: 'Replace placeholder hrefs with real destinations or use <button> for actions',
      });
    }

    if (brokenInternal.length > 0) {
      result.addCheck('links:internal', false, {
        message: `${brokenInternal.length} broken internal link(s)`,
        details: brokenInternal.slice(0, 20),
        suggestion: 'Fix or remove broken internal links',
      });
    } else {
      result.addCheck('links:internal', true, {
        message: `${uniqueInternal.size} internal links verified across ${allFiles.length} files`,
      });
    }

    // External links: report count
    result.addCheck('links:external-count', true, {
      message: `${externalLinks.size} external links found — use "gatetest --check-external" to validate`,
    });

    // Check for javascript: links (security issue) across ALL file types
    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (/href\s*=\s*["']javascript:(?!void|;)/i.test(content)) {
        result.addCheck(`links:javascript-href:${path.relative(projectRoot, file)}`, false, {
          file: path.relative(projectRoot, file),
          message: 'javascript: protocol in href — security risk',
          suggestion: 'Replace javascript: links with proper event handlers',
        });
      }
    }

    // Summary
    result.addCheck('links:summary', true, {
      message: `Scanned ${allFiles.length} files (${allExtensions.join(', ')}): ${uniqueInternal.size} internal, ${externalLinks.size} external, ${deadLinks.length} dead`,
    });
  }

  _categorizeLink(link, source, internalLinks, externalLinks) {
    if (!link || link.length === 0) return;
    // ANY scheme is external / non-file (irc:, ftp:, sms:, geo:, ws:, vscode:,
    // slack:, …). The old test only knew http(s)/mailto/tel/data, so
    // `irc://` and friends were "broken internal links" (2026-08-18 audit).
    if (link.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(link)) {
      if (/^https?:|^\/\//i.test(link)) externalLinks.add(link);
      return;
    }
    if (link === '#' || link === '#!') return; // dead/placeholder — tracked separately
    // Template expressions are resolved at render time, not on disk:
    // Thymeleaf `@{...}`, `th:href`, Jinja/Handlebars `{{ }}`/`{% %}`, EJS
    // `<%`, JSX `${}`, Angular/Vue bindings, mkdocs `!!`, `<https://…>`
    // autolinks that were mis-captured, and bare markdown reference labels.
    if (/^[@{$<%!]|\{\{|\{%|<%|^\[|\]$|^\(|\)$/.test(link)) return;
    internalLinks.push({ href: link, source });
  }
}

module.exports = LinksModule;
