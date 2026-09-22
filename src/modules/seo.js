/**
 * SEO Module - Search engine optimization validation.
 * Checks meta tags, structured data, sitemaps, canonical URLs, and more.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const { isNonUserFacingPage, isSpaShell } = require('../core/scan-scope');
const { matchTitleTag, matchMetaDescriptionTag } = require('../core/html-extract');

class SeoModule extends BaseModule {
  constructor() {
    super('seo', 'SEO & Metadata Validation');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Hosted URL scan: the route fetched the page once and shared the HTML
    // via config.livePage — check the ACTUAL rendered <head> instead of
    // reading source files that don't exist for this scan.
    if (config && config.livePage) {
      this._runLive(config.livePage, config, result);
      return;
    }

    if (this._isUrlOnlyScan(config)) {
      this._notChecked(result, 'this module reads HTML source files, not a live URL — no project files or fetched page were provided for this scan');
      return;
    }

    const seoConfig = config.getModuleConfig('seo');
    const htmlFiles = this._collectFiles(projectRoot, ['.html']);

    // Static dev fixtures (e.g. website/public/logos.html — logo grid for
    // screenshots, not a customer-facing route) shouldn't be checked for
    // customer-facing SEO metadata.
    const INTERNAL_PATH_RE = /(?:^|\/)(?:website\/public\/)/;

    // Only FULL DOCUMENTS are pages. Measured 2026-08-18 across 9 real
    // repos: 59 of 69 flagged .html files were server-template fragments
    // (Thymeleaf/Jinja/swig partials, layouts, includes, email bodies) or
    // test fixtures with no <html>+<head> of their own — the metadata this
    // module looks for lives in the layout that wraps them, and 12 error
    // checks per fragment produced 446 blocking errors on repos that were
    // not even websites. A fragment is skipped, counted, and reported once
    // as info; it is never a finding.
    let fragmentsSkipped = 0;
    let pagesChecked = 0;
    for (const file of htmlFiles) {
      const relPath = repoRelative(projectRoot, file);
      const normalised = relPath.replace(/\\/g, '/');
      if (INTERNAL_PATH_RE.test('/' + normalised)) continue;
      // Library examples/ and sandbox/ are documentation on any repo.
      // Scope, not severity — see src/core/scan-scope.js.
      if (isNonUserFacingPage(normalised)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (!SeoModule.isFullDocument(normalised, content)) {
        fragmentsSkipped++;
        continue;
      }
      pagesChecked++;

      this._checkTitle(relPath, content, seoConfig, result);
      this._checkMetaDescription(relPath, content, seoConfig, result);
      this._checkOpenGraph(relPath, content, result);
      this._checkTwitterCards(relPath, content, result);
      this._checkCanonical(relPath, content, result);
      this._checkStructuredData(relPath, content, result);
      this._checkHeadingSeo(relPath, content, result);
    }

    // Sitemap / robots only make sense for something that IS a deployed
    // site: a full-document page at a public root, or a framework app dir.
    // A library, CLI or API repo has neither and must not be told it is
    // missing a sitemap (this fired on express, flask, gin and sinatra).
    if (pagesChecked > 0 || SeoModule.looksLikeWebsite(projectRoot)) {
      this._checkSitemap(projectRoot, result);
      this._checkRobotsTxt(projectRoot, result);
    } else {
      result.addCheck('seo:site-files', true, {
        message: 'Not a deployable website (no full HTML documents or app router) — sitemap/robots checks not applicable',
      });
    }

    if (fragmentsSkipped > 0) {
      result.addCheck('seo:fragments', true, {
        message: `${fragmentsSkipped} HTML fragment/template file(s) skipped — metadata is checked on full documents only`,
      });
    }
    if (htmlFiles.length === 0) {
      result.addCheck('seo:files', true, { message: 'No HTML files to check' });
    }
  }

  /**
   * A file is a page (worth SEO checks) only when it is a complete document
   * that carries its own <html> and <head>. Template fragments, partials,
   * layouts-with-inheritance and fixtures are not pages.
   */
  static isFullDocument(normalisedPath, content) {
    const p = normalisedPath.toLowerCase();
    if (/(^|\/)(templates?|views?|partials?|fragments?|includes?|_includes|_layouts|layouts?|emails?|mail|components?|snippets?|__tests__|tests?|spec|fixtures?|test_apps?|testdata|__snapshots__|examples?|docs?_src|node_modules)\//.test(p)) {
      return false;
    }
    if (!/<html[\s>]/i.test(content) || !/<head[\s>]/i.test(content)) return false;
    // A SPA shell renders its page at runtime; the file has nothing to score.
    if (isSpaShell(content)) return false;
    // Template inheritance: the child declares extends/replace and inherits its head.
    if (/\{%\s*extends\b|th:replace=|th:insert=|<%-?\s*(layout|extends)\b|\{\{>\s*layout/i.test(content)) return false;
    return true;
  }

  /**
   * Signals that this repository is a deployable website, decided at the
   * ROOT: the sitemap/robots probes below look at root-relative paths, so a
   * docs site living in a subfolder (`website/`, `docs/`) of a library is
   * not recognised here — recognising it without re-rooting the probes would
   * guarantee a false "no sitemap" on every such library. `website/app/…`
   * is the one subfolder both sides agree on. A framework CONFIG alone is
   * not a site where the same config also builds libraries (Vite, Svelte),
   * and Hugo's older `config.toml` is a generic filename — those need the
   * app's own tree beside them (KI #106, 2026-09-05).
   */
  static looksLikeWebsite(projectRoot) {
    const has = (rel) => fs.existsSync(path.join(projectRoot, rel));
    const anyOf = (base, exts) => exts.some((e) => has(`${base}.${e}`));
    const JS = ['js', 'ts', 'mjs', 'cjs'];
    const markers = [
      'index.html', 'public/index.html', 'static/index.html', 'dist/index.html',
      'app/layout.tsx', 'app/layout.jsx', 'app/layout.js', 'src/app/layout.tsx', 'website/app/layout.tsx',
      'pages/index.tsx', 'pages/index.jsx', 'pages/index.js', 'src/pages/index.tsx',
      // Remix, Angular (its src/index.html is a SPA shell, never a scored page)
      'app/root.tsx', 'app/root.jsx', 'angular.json',
      // Jekyll, MkDocs, Hugo (current config names), Eleventy's dotfile
      '_config.yml', 'mkdocs.yml', 'hugo.toml', 'hugo.yaml', 'hugo.json', '.eleventy.js',
    ];
    if (markers.some(has)) return true;
    if (['remix.config', 'nuxt.config', 'astro.config', 'gatsby-config', 'docusaurus.config', 'eleventy.config'].some((c) => anyOf(c, JS))) return true;
    if (anyOf('svelte.config', JS) && has('src/routes')) return true;
    if (anyOf('vite.config', JS) && (has('src/index.html') || has('web/index.html'))) return true;
    return has('config.toml') && has('content');
  }

  /**
   * Whether a framework emits the file at build time from a declaration
   * rather than a checked-in copy: Docusaurus (classic preset) and Hugo emit
   * sitemap.xml unconditionally; Hugo emits robots.txt behind
   * `enableRobotsTXT`; Astro / Nuxt / Gatsby / Jekyll / next-sitemap declare
   * a plugin or integration whose name carries the word.
   */
  static generatedAtBuild(projectRoot, kind) {
    const has = (rel) => fs.existsSync(path.join(projectRoot, rel));
    const JS = ['js', 'ts', 'mjs', 'cjs'];
    const configs = ['astro.config', 'nuxt.config', 'gatsby-config', 'svelte.config', 'next-sitemap.config', 'eleventy.config', 'hugo']
      .flatMap((base) => [...JS, 'toml', 'yaml', 'json'].map((e) => `${base}.${e}`))
      .concat(['_config.yml', '.eleventy.js', 'config.toml', 'config.yaml']);
    if (kind === 'sitemap' && (has('docusaurus.config.js') || has('docusaurus.config.ts') || has('hugo.toml') || has('hugo.yaml'))) return true;
    const re = kind === 'sitemap' ? /sitemap/i : /robots/i;
    return configs.some((rel) => {
      if (!has(rel)) return false;
      try { return re.test(fs.readFileSync(path.join(projectRoot, rel), 'utf-8')); } catch { return false; } // error-ok — unreadable config is "not declared"
    });
  }

  /**
   * Live-URL mode: `livePage` is `{ url, status, headers, html }` from ONE
   * shared fetch the route already made (config.livePage). Reuses the same
   * check functions the static-file path uses — one definition (Doctrine
   * §4) of "what makes a page's metadata sound" whether the HTML came from
   * disk or from the wire. Sitemap/robots discovery stays file-based only
   * (a live scan has no repository layout to check for those files).
   */
  _runLive(livePage, config, result) {
    const html = (livePage && livePage.html) || '';
    const label = (livePage && livePage.url) || 'fetched page';
    if (!html) {
      this._notChecked(result, 'the shared page fetch for this scan returned no HTML body to audit');
      return;
    }
    if (isSpaShell(html)) {
      result.addCheck('seo:live-summary', true, {
        severity: 'info',
        message: 'Page is a client-rendered SPA shell — no server-rendered metadata to audit',
      });
      return;
    }
    const seoConfig = (config && typeof config.getModuleConfig === 'function')
      ? (config.getModuleConfig('seo') || {})
      : {};
    const before = result.checks.length;
    this._checkTitle(label, html, seoConfig, result);
    this._checkMetaDescription(label, html, seoConfig, result);
    this._checkOpenGraph(label, html, result);
    this._checkTwitterCards(label, html, result);
    this._checkCanonical(label, html, result);
    this._checkStructuredData(label, html, result);
    this._checkHeadingSeo(label, html, result);
    const issues = result.checks.slice(before).filter((c) => !c.passed).length;
    result.addCheck('seo:live-summary', true, {
      severity: 'info',
      message: issues === 0
        ? 'Live SEO check: no issues found on the fetched page'
        : `Live SEO check: ${issues} issue(s) found on the fetched page`,
    });
  }

  // #653: a bare `/<title>([^<]*)<\/title>/i` requires an attribute-free
  // tag written on one line — `<title lang="en">` or a multi-line title
  // never matched, and the page was reported as having no <title> at all
  // (12 of 26 grade points on tallrig.com were exactly this false
  // positive). matchTitleTag() (src/core/html-extract.js, the same one
  // definition #641/#646 fixed for the crawler) accepts attributes in any
  // order, whitespace/newlines inside the tag, and ignores a <title>
  // nested inside <svg>...</svg>. It returns `undefined` only when there is
  // truly no <title> tag, distinct from a tag that is merely empty.
  _checkTitle(relPath, content, config, result) {
    const rawTitle = matchTitleTag(content);
    if (rawTitle === undefined) {
      result.addCheck(`seo:title:${relPath}`, false, {
        file: relPath,
        message: 'Missing <title> tag',
        suggestion: 'Add a unique, descriptive <title> (50-60 characters)',
      });
      return;
    }

    const title = rawTitle.trim();
    const maxLength = config.maxTitleLength || 60;

    if (title.length === 0) {
      result.addCheck(`seo:title-empty:${relPath}`, false, {
        file: relPath,
        message: 'Empty <title> tag',
        suggestion: 'Add descriptive page title',
      });
    } else if (title.length > maxLength) {
      result.addCheck(`seo:title-length:${relPath}`, false, {
        file: relPath,
        expected: `<= ${maxLength} characters`,
        actual: `${title.length} characters`,
        message: 'Title too long — may be truncated in search results',
        suggestion: `Shorten title to ${maxLength} characters or less`,
      });
    } else {
      result.addCheck(`seo:title:${relPath}`, true);
    }
  }

  // #653: the two-alternative regex only handled `name` immediately
  // followed by `content` (or vice versa) — an attribute sitting between
  // them (`<meta name="description" lang="en" content="...">`) matched
  // neither alternative and was reported missing. matchMetaDescriptionTag()
  // (src/core/html-extract.js) scopes to one <meta ...> tag at a time and
  // reads `name`/`content` independently, so order and any other attribute
  // in between no longer matter.
  _checkMetaDescription(relPath, content, config, result) {
    const rawDesc = matchMetaDescriptionTag(content);

    if (rawDesc === undefined) {
      result.addCheck(`seo:description:${relPath}`, false, {
        file: relPath,
        message: 'Missing meta description',
        suggestion: 'Add <meta name="description" content="..."> (150-160 characters)',
      });
      return;
    }

    const desc = rawDesc.trim();
    const maxLength = config.maxDescriptionLength || 160;

    if (desc.length > maxLength) {
      result.addCheck(`seo:description-length:${relPath}`, false, {
        file: relPath,
        expected: `<= ${maxLength} characters`,
        actual: `${desc.length} characters`,
        suggestion: `Shorten description to ${maxLength} characters`,
      });
    } else {
      result.addCheck(`seo:description:${relPath}`, true);
    }
  }

  // Open Graph / Twitter cards, canonical and structured data are how a page
  // is SHARED and ENRICHED, not whether it is a page: a private tool page
  // (prisma apps/lsp-playground/index.html — a Monaco editor served by a
  // local CLI) took 9 blocking errors for share cards nobody will ever
  // request. Title / description / h1 remain errors — they are the page's
  // own identity; the rest is reported at warning (Forbidden #25).
  _checkOpenGraph(relPath, content, result) {
    const ogTags = ['og:title', 'og:description', 'og:image', 'og:url'];
    for (const tag of ogTags) {
      const hasTag = new RegExp(`property=["']${tag}["']`, 'i').test(content) ||
                     new RegExp(`name=["']${tag}["']`, 'i').test(content);
      if (!hasTag) {
        result.addCheck(`seo:${tag}:${relPath}`, false, {
          severity: 'warning',
          file: relPath,
          message: `Missing Open Graph tag: ${tag}`,
          suggestion: `Add <meta property="${tag}" content="...">`,
        });
      }
    }
  }

  _checkTwitterCards(relPath, content, result) {
    const twitterTags = ['twitter:card', 'twitter:title', 'twitter:description'];
    for (const tag of twitterTags) {
      if (!content.includes(tag)) {
        result.addCheck(`seo:${tag}:${relPath}`, false, {
          severity: 'warning',
          file: relPath,
          message: `Missing Twitter Card tag: ${tag}`,
          suggestion: `Add <meta name="${tag}" content="...">`,
        });
      }
    }
  }

  _checkCanonical(relPath, content, result) {
    if (!/<link\s+[^>]*rel=["']canonical["']/i.test(content)) {
      result.addCheck(`seo:canonical:${relPath}`, false, {
        severity: 'warning',
        file: relPath,
        message: 'Missing canonical URL',
        suggestion: 'Add <link rel="canonical" href="...">',
      });
    }
  }

  _checkStructuredData(relPath, content, result) {
    const hasJsonLd = content.includes('application/ld+json');
    const hasMicrodata = content.includes('itemscope') || content.includes('itemtype');

    if (!hasJsonLd && !hasMicrodata) {
      result.addCheck(`seo:structured-data:${relPath}`, false, {
        severity: 'warning',
        file: relPath,
        message: 'No structured data (JSON-LD or microdata) found',
        suggestion: 'Add JSON-LD structured data for rich search results',
      });
    }
  }

  _checkHeadingSeo(relPath, content, result) {
    const h1Count = (content.match(/<h1\b/gi) || []).length;
    if (h1Count === 0) {
      result.addCheck(`seo:h1-missing:${relPath}`, false, {
        file: relPath,
        message: 'No <h1> tag found',
        suggestion: 'Add a single <h1> tag with the primary page topic',
      });
    } else if (h1Count > 1) {
      result.addCheck(`seo:h1-multiple:${relPath}`, false, {
        file: relPath,
        message: `${h1Count} <h1> tags found — should have exactly one`,
        suggestion: 'Use a single <h1> and structure with h2-h6',
      });
    }
  }

  _checkSitemap(projectRoot, result) {
    // Static files OR route-based generation (Next App Router / Pages, Nuxt
    // server routes, SvelteKit +server, Remix flat routes, Astro pages,
    // Angular src/) OR a build-time declaration (generatedAtBuild).
    this._checkSiteFile(projectRoot, result, 'sitemap', [
      'sitemap.xml', 'public/sitemap.xml', 'static/sitemap.xml', 'src/sitemap.xml',
      'app/sitemap.ts', 'app/sitemap.js', 'app/sitemap.tsx',
      'website/app/sitemap.ts', 'website/app/sitemap.js',
      'src/app/sitemap.ts', 'src/app/sitemap.js',
      'pages/sitemap.xml.ts', 'pages/sitemap.xml.js', 'src/pages/sitemap.xml.ts', 'src/pages/sitemap.xml.js',
      'server/routes/sitemap.xml.ts', 'server/routes/sitemap.xml.js',
      'src/routes/sitemap.xml/+server.ts', 'src/routes/sitemap.xml/+server.js',
      'app/routes/sitemap[.]xml.tsx', 'app/routes/sitemap[.]xml.ts',
      'next-sitemap.config.js', 'next-sitemap.config.cjs', 'next-sitemap.config.mjs',
    ], 'No sitemap.xml found', 'Generate a sitemap.xml for search engine discovery');
  }

  _checkRobotsTxt(projectRoot, result) {
    this._checkSiteFile(projectRoot, result, 'robots', [
      'robots.txt', 'public/robots.txt', 'static/robots.txt', 'src/robots.txt',
      'app/robots.ts', 'app/robots.js', 'app/robots.tsx',
      'website/app/robots.ts', 'website/app/robots.js',
      'src/app/robots.ts', 'src/app/robots.js',
      'pages/robots.txt.ts', 'pages/robots.txt.js', 'src/pages/robots.txt.ts', 'src/pages/robots.txt.js',
      'server/routes/robots.txt.ts', 'server/routes/robots.txt.js',
      'src/routes/robots.txt/+server.ts', 'src/routes/robots.txt/+server.js',
      'app/routes/robots[.]txt.tsx', 'app/routes/robots[.]txt.ts',
    ], 'No robots.txt found', 'Create a robots.txt to guide search engine crawlers');
  }

  _checkSiteFile(projectRoot, result, kind, paths, message, suggestion) {
    const id = kind === 'sitemap' ? 'seo:sitemap' : 'seo:robots-txt';
    const found = paths.some((p) => fs.existsSync(path.join(projectRoot, p)))
      || SeoModule.generatedAtBuild(projectRoot, kind);
    if (!found) {
      result.addCheck(id, false, { severity: 'warning', message, suggestion });
    } else {
      result.addCheck(id, true);
    }
  }
}

module.exports = SeoModule;
