/**
 * Links Module - Broken link detection for internal and external links.
 * Crawls HTML files and validates all href/src references.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
// One definition, imported (doctrine §4): src/core/scan-scope.js answers
// "is this JSX a web page or a picture?" for every module that reads JSX.
const { isImageRenderer, isNonUserFacingPage } = require('../core/scan-scope');
// The one glob grammar (`.gatetest.json` `paths`, workspace patterns): `*` one
// segment, `**` any depth, a bare prefix means everything under it. Applied to
// link TARGETS here — `links.excludePatterns` (KI #52).
const { compilePatterns } = require('../core/scan-paths');

// A docs-site route is written the way the SITE serves it, not the way the
// repository stores it: `../getting-started`, `adapters/standalone`,
// `../schema/schema/#anchor` are `getting-started.mdx`, `adapters/standalone.md`
// and `schema/schema.md` on disk (apollo-server docs/source/api/apollo-server.mdx,
// trpc www/docs/server/adapters-intro.md — 277 and 75 "broken" links).
const ROUTE_FALLBACK_SUFFIXES = ['.md', '.mdx', '.html', '.htm', '/index.md', '/index.mdx', '/index.html', '/README.md'];

/** `%20` and friends are the link's encoding of the path, not the path
 *  (prisma AGENTS.md → `docs/Architecture%20Overview.md`, 1134 findings). */
function decodeHref(href) {
  try { return decodeURIComponent(href); } catch { return href; }
}

/** A suffix that names a file, so a dotted token is a path and not a domain or a template property. */
const LINK_FILE_EXT_RE = /\.(?:md|mdx|markdown|html?|txt|json|ya?ml|png|jpe?g|gif|svg|webp|ico|pdf|css|scss|js|ts|tsx|jsx|mjs|cjs|xml|csv|zip|gz|wasm|map)$/i;

/** Blank out fenced code blocks and inline code spans, preserving line count. */
function stripMarkdownCode(md) {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/~~~[\s\S]*?~~~/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

class LinksModule extends BaseModule {
  constructor() {
    super('links', 'Broken Link Detection');
  }

  /** One definition (Doctrine §4) of "did a prior module in this suite
   *  already produce a real result?" — `config._allResults` is the
   *  runner's array of completed TestResult instances for every module
   *  that ran before this one (see GateTestRunner._runModule); sequential
   *  suite order (src/core/config.js) puts `liveCrawler` before `links`
   *  for exactly this reason (#681 item 4). */
  _priorResult(config, moduleName) {
    const all = config && config._allResults;
    if (!Array.isArray(all)) return null;
    return all.find((r) => r && r.module === moduleName) || null;
  }

  /** liveCrawler always emits `crawl:pages-scanned` once it actually
   *  crawls (as opposed to an early "no URL configured" return, which
   *  never reaches that check) — its presence is how we tell "the crawler
   *  ran and produced real link data" from "the crawler didn't run at
   *  all this scan" without re-deriving the crawl ourselves. */
  _crawlSummary(crawlResult) {
    const checks = Array.isArray(crawlResult && crawlResult.checks) ? crawlResult.checks : [];
    const scanned = checks.find((c) => c.name === 'crawl:pages-scanned');
    if (!scanned) return null;
    const pagesMatch = /Crawled (\d+) page/.exec(scanned.message || '');
    return {
      pagesScanned: pagesMatch ? Number(pagesMatch[1]) : null,
      broken: checks.find((c) => c.name === 'crawl:broken-links') || null,
    };
  }

  /** Live mode, crawler data available: consume liveCrawler's already-
   *  computed broken-link result instead of re-crawling (#681 item 4) —
   *  the crawler already checked every link on every page it visited, so
   *  reporting `links` as not-checked here was dishonest about coverage,
   *  not just conservative. */
  _runLiveFromCrawl(result, summary) {
    const pagesNote = summary.pagesScanned ? ` (from the live crawl of ${summary.pagesScanned} page(s) on this scan)` : ' (from the live crawl on this scan)';
    if (summary.broken) {
      result.addCheck('links:live-broken-links', false, {
        severity: summary.broken.severity || 'error',
        message: `${summary.broken.message}${pagesNote}`,
        details: summary.broken.details,
        suggestion: summary.broken.suggestion || 'Fix or remove broken links.',
      });
    } else {
      result.addCheck('links:live-clean', true, {
        message: `No broken links found${pagesNote}`,
      });
    }
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    if (config && config.livePage) {
      const crawlResult = this._priorResult(config, 'liveCrawler');
      const crawlSummary = crawlResult && this._crawlSummary(crawlResult);
      if (crawlSummary) {
        this._runLiveFromCrawl(result, crawlSummary);
        return;
      }
      // The shared single-fetch `config.livePage` gives one page's HTML —
      // crawling the site's own links (same-origin anchors, HEAD checks,
      // a request cap) needs `liveCrawler`'s own crawl, which either
      // didn't run this scan or didn't produce a real result (not-checked
      // itself, or not configured). Reporting a pass here (as the old "no
      // template files" branch would, since there IS no projectRoot to
      // walk) would fabricate a check that never ran.
      this._notChecked(result, 'this module resolves link targets against files on disk — checking a live page\'s links needs the liveCrawler module\'s own crawl (same-origin anchors + HEAD requests), and liveCrawler did not produce a crawl result on this scan; see the liveCrawler module for deployed-site link checks');
      return;
    }

    if (this._isUrlOnlyScan(config)) {
      this._notChecked(result, 'this module resolves link targets against files on disk, not a live URL — no project files were provided for this scan');
      return;
    }

    const moduleConfig = (config && typeof config.getModuleConfig === 'function')
      ? (config.getModuleConfig('links') || {})
      : {};
    // Link targets a team has decided not to check — a docs route served by
    // another system, a legacy anchor scheme. Same grammar as `paths`.
    this._excludeRes = compilePatterns(moduleConfig.excludePatterns);

    let imageRenderersSkipped = 0;
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
      const relPath = repoRelative(projectRoot, file);
      if (INTERNAL_DOCS_RE.test('/' + relPath.replace(/\\/g, '/'))) continue;
      const ext = path.extname(file);
      // A test/benchmark harness page is not a page a user visits: lodash's
      // perf/index.html links ../node_modules/benchmark/benchmark.js and that
      // is the harness working, not a broken link (#418's corpus run,
      // 2026-09-02). Markdown under those dirs is still read — a README in
      // tests/ is documentation.
      const isMarkdown = ['.md', '.mdx'].includes(ext);
      if (!isMarkdown && isNonUserFacingPage(relPath)) continue;
      let content = fs.readFileSync(file, 'utf-8');
      // Links inside code are illustrations — `[text](url)` shown in a fenced
      // block or a backtick span documents syntax, it does not link.
      if (isMarkdown) content = stripMarkdownCode(content);
      // JSX handed to satori / `new ImageResponse(…)` is rasterised to a PNG:
      // an `href="#"` drawn into an OG image is paint, not a link
      // (trpc www/og-image/pages/api/_ref/tailwind.tsx:31).
      if (isImageRenderer(content)) { imageRenderersSkipped++; continue; }

      // Pattern set 1: HTML-style href/src attributes (works for HTML, JSX, TSX, Vue, Svelte)
      const hrefRegex = /(?:href|src)\s*=\s*["'{]?\s*["'`]([^"'`{}\s>]+)/gi;
      let match;
      while ((match = hrefRegex.exec(content)) !== null) {
        const link = match[1].trim();
        if (this._isExcludedLink(link)) continue;
        this._categorizeLink(link, relPath, internalLinks, externalLinks);
      }

      // Pattern set 2: JSX/TSX — to="" prop (Next.js Link, React Router)
      if (['.jsx', '.tsx', '.js', '.ts'].includes(ext)) {
        const toRegex = /\bto\s*=\s*["'`]([^"'`]+)/gi;
        while ((match = toRegex.exec(content)) !== null) {
          const link = match[1].trim();
          if (this._isExcludedLink(link)) continue;
        this._categorizeLink(link, relPath, internalLinks, externalLinks);
        }
      }

      // Pattern set 3: Markdown links [text](url)
      if (['.md', '.mdx'].includes(ext)) {
        const mdRegex = /\]\(([^)\s]+)/g;
        while ((match = mdRegex.exec(content)) !== null) {
          const link = match[1].trim();
          if (this._isExcludedLink(link)) continue;
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
        const filePart = decodeHref(href.split('#')[0].split('?')[0]);
        if (!filePart) continue;
        if (!this._resolvesOnDisk(projectRoot, source, filePart)) {
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

    // A broken link in a README or docs page is documentation hygiene; it
    // cannot fail a build the way a missing auth check or a leaked secret
    // does (Forbidden #25). Reported, never blocking.
    if (brokenInternal.length > 0) {
      result.addCheck('links:internal', false, {
        severity: 'warning',
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
        result.addCheck(`links:javascript-href:${repoRelative(projectRoot, file)}`, false, {
          file: repoRelative(projectRoot, file),
          message: 'javascript: protocol in href — security risk',
          suggestion: 'Replace javascript: links with proper event handlers',
        });
      }
    }

    // Summary
    result.addCheck('links:summary', true, {
      message: `Scanned ${allFiles.length} files (${allExtensions.join(', ')}): ${uniqueInternal.size} internal, ${externalLinks.size} external, ${deadLinks.length} dead`
        + (imageRenderersSkipped ? `; ${imageRenderersSkipped} image-renderer file(s) not checked (rendered to PNG, not served as HTML)` : ''),
    });
  }

  /**
   * Does a relative link target exist? Tries the literal path first, then the
   * docs-site route spellings (`foo` → `foo.md`/`foo.mdx`/`foo/index.html`,
   * trailing slash stripped). A README beside a package.json is rendered by
   * npm, which rewrites relative links against the REPOSITORY root — nest's
   * packages/common/Readme.md links `readme_zh.md` and `LICENSE`, both at the
   * repo root — so for those files a root-relative hit counts too.
   */
  _resolvesOnDisk(projectRoot, source, target) {
    const base = path.dirname(path.join(projectRoot, source));
    const bare = target.replace(/\/+$/, '') || target;
    const literal = path.resolve(base, target);
    if (fs.existsSync(literal)) return true;
    const stem = path.resolve(base, bare);
    if (ROUTE_FALLBACK_SUFFIXES.some((s) => fs.existsSync(stem + s))) return true;
    if (/^readme\.(?:md|mdx)$/i.test(path.basename(source)) && fs.existsSync(path.join(base, 'package.json'))) {
      return fs.existsSync(path.resolve(projectRoot, target));
    }
    return false;
  }

  /** `links.excludePatterns` matched against the link target as written. */
  _isExcludedLink(link) {
    const target = String(link).replace(/\\/g, '/').replace(/^\.\//, '');
    return (this._excludeRes || []).some((re) => re.test(target));
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
    // Placeholders and non-paths (#418's corpus run on chalk / axios /
    // fastify / lodash, 2026-09-02): `string,` (a signature captured from
    // prose — a comma or a space never appears in a path reference), `LINK`
    // (an all-caps placeholder), `sponsor.imageUrl` (a template property —
    // a dotted bare token whose suffix is no file extension),
    // `www.websitename.com` (a bare domain is prose, not a path), and
    // `../node_modules/…` (a dependency asset is installed, not committed).
    // A bare lowercase word such as `changesets` is still a target — apollo's
    // CONTRIBUTING.md really did point at a missing directory
    // (tests/links.test.js holds that control).
    if (/[,\s]/.test(link)) return;
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(link)) return;
    const looksLikeFile = LINK_FILE_EXT_RE.test(link);
    if (!link.includes('/') && /\.[A-Za-z0-9]+$/.test(link) && !looksLikeFile) return;
    // `missing.md` is a file, not a domain with a `.md` TLD — the extension
    // list decides first.
    if (!looksLikeFile && /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/|$)/i.test(link) && !link.startsWith('.')) return;
    if (/(?:^|\/)node_modules\//.test(link)) return;
    internalLinks.push({ href: link, source });
  }
}

module.exports = LinksModule;
