'use strict';

/**
 * One shared definition (Doctrine #4) of how a raw engine check becomes a
 * customer-facing finding — issue #695, follow-up from #687 (issue #681).
 *
 * Before this file existed, all FOUR hosted scan routes
 * (`/api/web/scan`, `/api/web/scan/stream`, `/api/wp/scan`,
 * `/api/wp/scan/stream`) each carried their OWN copy of `translateFinding()`.
 * #687 added a `cross-browser:` branch to the two web routes (so a
 * cross-browser finding surfaces under module `crossBrowser` with its
 * evidence, instead of falling into the generic `general` bucket and having
 * its message mangled by a naive `.split(":")`) but the two WP routes never
 * got the same branch — a cross-browser finding on a WordPress scan still
 * lost its evidence. Four independent copies is exactly the shape Doctrine
 * #4 forbids: a fix landed in one copy is not automatically present in the
 * other three.
 *
 * This module is the union of all four routes' branches: the generic
 * web-suite branches (shared by all four — `web`/`wp` both run webHeaders,
 * tlsSecurity, cookieSecurity, crossBrowser, runtimeErrors, the crawl:*
 * family, accessibility, seo, links, performance) plus the WordPress-only
 * branches (`wp-exposed-files:`, `wp-version-leak:`, `wp-xmlrpc:`) that only
 * ever fire for a check name the `wp` suite emits — harmless dead branches
 * on a `web` scan, never reached because those check names don't exist
 * there.
 *
 * All four routes now call `translateFinding` from here — one definition,
 * imported — so a fix (or a new branch, like #687's `cross-browser:`) lands
 * for every route at once and cannot silently drift again.
 */

/**
 * @typedef {{
 *   severity: "error" | "warning" | "info",
 *   title: string,
 *   body: string,
 *   module: string,
 *   ruleKey: string,
 *   verdictSource: "deterministic" | "model" | "mixed",
 * }} ScanFinding
 */

/**
 * Translate a raw module-check into a customer-facing finding. Maps check
 * name prefixes to plain-English title + body copy. Falls back to a
 * lightly-cleaned raw message when no mapping exists, so a new module
 * surfaces something rather than silently dropping its findings.
 *
 * @param {{ name: string, severity?: string, message?: string, verdictSource?: string }} check
 * @returns {ScanFinding | null}
 */
function translateFinding(check) {
  const sev = (check.severity || 'info').toLowerCase();
  if (sev !== 'error' && sev !== 'warning' && sev !== 'info') return null;
  if (sev === 'info') return null; // summaries / config notes are not customer-facing
  if (check.message && check.message.startsWith('wp-exposed-files: probed')) {
    // Drop module-summary chatter from the customer report (WP-only check
    // name — never emitted by the `web` suite).
    return null;
  }

  const name = check.name;
  let title = check.message || name;
  let body = check.message || '';
  let mod = 'general';

  if (name.startsWith('wp-exposed-files:found:')) {
    const file = name.replace('wp-exposed-files:found:', '');
    mod = 'wpExposedFiles';
    title = `Sensitive file exposed: ${file}`;
    body =
      `Anyone on the internet can read \`${file}\` by visiting it directly. ` +
      `Most attackers scan for these specific files within minutes of a new domain going live.` +
      `\n\nWhat to do: log in to your hosting control panel (cPanel / Plesk / SSH) and delete the file. ` +
      `If it's needed for development, move it OUTSIDE the public webroot.`;
  } else if (name.startsWith('wp-version-leak:')) {
    mod = 'wpVersionLeak';
    title = 'WordPress version is publicly visible';
    body =
      (check.message || '') +
      `\n\nWhy this matters: when an attacker knows your exact WordPress version, ` +
      `they can match it against the public CVE database and find known exploits in minutes. ` +
      `Hiding the version doesn't fix the underlying CVE, but it does mean you're not the easy target.`;
  } else if (name === 'wp-xmlrpc:pingback-available') {
    mod = 'wpXmlrpcExposed';
    title = 'Your site can be used as a DDoS weapon';
    body =
      (check.message || '') +
      `\n\nThis is the worst-case xmlrpc.php configuration: pingback.ping is enabled, ` +
      `which lets a third party tell your server to make HTTP requests to ANY other site. ` +
      `Attackers chain dozens of WordPress sites with this flaw to overwhelm a single target.`;
  } else if (name === 'wp-xmlrpc:exposed') {
    mod = 'wpXmlrpcExposed';
    title = 'XML-RPC is enabled (legacy login interface)';
    body = check.message || '';
  } else if (name.startsWith('web-headers:')) {
    mod = 'webHeaders';
    title = 'Missing or weak security header';
    body =
      (check.message || '') +
      `\n\nFix: add the header in your reverse proxy (nginx, Caddy, Apache), CDN (Cloudflare, Fastly), or app server (Next.js headers(), Express helmet middleware).`;
  } else if (name.startsWith('tls-')) {
    mod = 'tlsSecurity';
    title = 'HTTPS / TLS issue';
    body = check.message || '';
  } else if (name.startsWith('cookie-')) {
    mod = 'cookieSecurity';
    title = 'Cookie hardening missing';
    body = check.message || '';
  } else if (name.startsWith('cross-browser:')) {
    // Issue #681 item 2 / #687 / #695: crossBrowser (src/modules/cross-browser.js)
    // already follows the #659 rule — evidence (engine version + error
    // text) in the message, or not-checked with a reason — but with no
    // branch here the finding fell into the generic "general" fallback
    // below, which mangles the title via a naive `.split(":")` (the
    // message's own `https://` colon gets treated as a field separator).
    // Never lose the evidence-rich message either route already computed.
    mod = 'crossBrowser';
    title = 'Cross-browser rendering difference';
    body = check.message || '';
  } else if (name.startsWith('runtime-errors:page-error') || name.startsWith('runtime-errors:initial-status')) {
    mod = 'runtimeErrors';
    title = 'JavaScript error on page load';
    body =
      (check.message || '') +
      `\n\nWhy it matters: uncaught JS errors break interactive features (forms, navigation, search). Real visitors see a blank or partially-loaded page.`;
  } else if (name.startsWith('runtime-errors:console-error')) {
    mod = 'runtimeErrors';
    title = 'Console error during load';
    body = check.message || '';
  } else if (name.startsWith('runtime-errors:network')) {
    mod = 'runtimeErrors';
    title = 'Network resource failed to load';
    body =
      (check.message || '') +
      `\n\nFailed assets (scripts, images, fonts) often mean broken features and a degraded experience.`;
  } else if (name.startsWith('runtime-errors:csp-violation')) {
    mod = 'runtimeErrors';
    title = 'Content Security Policy violation';
    body =
      (check.message || '') +
      `\n\nA real browser blocked something the page tried to do. Often this means a third-party script or analytics tag is broken — or your CSP is too strict for your own code.`;
  } else if (name.startsWith('runtime-errors:mixed-content')) {
    mod = 'runtimeErrors';
    title = 'Mixed content blocked';
    body =
      (check.message || '') +
      `\n\nYour HTTPS page tried to load HTTP assets — modern browsers refuse to load them. Convert all asset URLs to https://.`;
  } else if (name.startsWith('runtime-errors:hydration')) {
    mod = 'runtimeErrors';
    title = 'Hydration mismatch (React/Vue/Next.js)';
    body =
      (check.message || '') +
      `\n\nServer-rendered HTML did not match the client React tree on first paint. Users see flicker, blank content, or interactive elements that don't respond until the page re-renders.`;
  } else if (name.startsWith('runtime-errors:navigation')) {
    mod = 'runtimeErrors';
    title = 'Page failed to load in a real browser';
    body =
      (check.message || '') +
      `\n\nA headless Chromium instance could not reach this page. If a scanner can't load it, real visitors will hit the same wall.`;
  } else if (name === 'crawl:broken-links' || name === 'crawl:broken-images') {
    mod = 'liveCrawler';
    title = name === 'crawl:broken-images' ? 'Broken image(s) on your site' : 'Broken link(s) on your site';
    body =
      (check.message || '') +
      `\n\nVisitors clicking these get a 404 — bad for conversion and SEO.`;
  } else if (name === 'crawl:broken-scripts') {
    mod = 'liveCrawler';
    title = 'Broken JavaScript bundle';
    body =
      (check.message || '') +
      `\n\nWhen a JS file 404s, the features depending on it silently break. Users may not even see an error — they just won't be able to use search, forms, or interactive elements.`;
  } else if (name === 'crawl:broken-stylesheets') {
    mod = 'liveCrawler';
    title = 'Broken stylesheet';
    body =
      (check.message || '') +
      `\n\nVisitors see raw HTML with no styling for the few seconds before the page falls back, or permanently if the file never loads.`;
  } else if (name === 'crawl:missing-meta-description') {
    mod = 'liveCrawler';
    title = 'Pages missing meta description';
    body =
      (check.message || '') +
      `\n\nGoogle's snippet text uses your meta description. Without one, Google guesses — usually poorly. Click-through rate suffers.`;
  } else if (name === 'crawl:missing-canonical') {
    mod = 'liveCrawler';
    title = 'Pages missing canonical link';
    body =
      (check.message || '') +
      `\n\nWithout a canonical, multiple URLs (with/without trailing slash, with/without query strings) can be indexed as separate pages — diluting SEO authority.`;
  } else if (name === 'crawl:slow-pages') {
    mod = 'liveCrawler';
    title = 'Slow-loading pages';
    body =
      (check.message || '') +
      `\n\nReal users bounce when TTFB exceeds ~2.5 seconds. Each second past that costs measurable revenue.`;
  } else if (name === 'crawl:anchor-missing-target') {
    mod = 'liveCrawler';
    title = 'Anchor links pointing at non-existent targets';
    body =
      (check.message || '') +
      `\n\nA visitor clicks the link and nothing happens. Either remove the anchor or add the id to the target element.`;
  } else if (name === 'crawl:duplicate-titles') {
    mod = 'liveCrawler';
    title = 'Duplicate page titles';
    body =
      (check.message || '') +
      `\n\nMultiple pages share a <title>. Browser tabs become indistinguishable and Google de-prioritises duplicated content.`;
  } else if (name === 'crawl:sitemap-missing') {
    mod = 'liveCrawler';
    title = 'No sitemap.xml found';
    body = check.message || '';
  } else if (name === 'crawl:robots-missing') {
    mod = 'liveCrawler';
    title = 'No robots.txt found';
    body = check.message || '';
  } else if (name === 'crawl:favicon-missing') {
    mod = 'liveCrawler';
    title = 'No favicon found';
    body = check.message || '';
  } else if (name.startsWith('crawl:error:')) {
    mod = 'liveCrawler';
    const errType = name.replace('crawl:error:', '');
    title = `Site issue detected: ${errType.replace(/-/g, ' ')}`;
    body = check.message || '';
  } else if (name.startsWith('accessibility:') || name.includes('a11y')) {
    mod = 'accessibility';
    title = 'Accessibility issue';
    body = check.message || '';
  } else if (name.startsWith('seo:')) {
    mod = 'seo';
    title = 'SEO issue';
    body = check.message || '';
  } else if (name.startsWith('links:') || name.startsWith('broken-link')) {
    mod = 'links';
    title = 'Broken link or image';
    body = check.message || '';
  } else if (name.startsWith('performance:')) {
    mod = 'performance';
    title = 'Performance issue';
    body = check.message || '';
  } else {
    title = (check.message || name).split(':').slice(0, 2).join(':');
    body = check.message || `Raw finding: ${name}`;
  }

  return {
    severity: sev,
    title,
    body,
    module: mod,
    ruleKey: name,
    // The Fifty, move 14: passed through from the raw engine check, which is
    // the one place (runner.js TestResult.addCheck) that sets it.
    verdictSource: check.verdictSource === 'model' || check.verdictSource === 'mixed'
      ? check.verdictSource
      : 'deterministic',
  };
}

module.exports = { translateFinding };
