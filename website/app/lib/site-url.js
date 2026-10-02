'use strict';
/**
 * The canonical public origin — the ONE place that decides what domain
 * GateTest calls itself.
 *
 * Before this file existed the old origin appeared as a literal in 148
 * places across website/app: SEO canonicals, Open Graph URLs, Stripe success
 * and cancel URLs, the GitHub OAuth redirect, badge embed snippets, e-mail
 * footers. Fourteen of those repeated the same
 * `process.env.NEXT_PUBLIC_BASE_URL || '<old origin>'` fallback by
 * hand, which meant a domain move was a 148-site find-and-replace where
 * missing one silently pointed a customer at a domain we no longer own.
 *
 * Now it is one environment variable.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Never write an origin literal in runtime code. Import `siteUrl()`.
 * `tests/site-url.test.js` fails the suite if new literals appear in the
 * files that matter.
 *
 * ── Keep this file in step with src/core/site-url.js ────────────────────────
 * The engine, CLI and MCP server have their own copy of this logic, because
 * the published npm package ships src/ and bin/ WITHOUT website/ and so cannot
 * require across that boundary. This copy exists separately because it reads
 * NEXT_PUBLIC_BASE_URL as a static member expression that Next.js inlines into
 * CLIENT bundles. A drift guard in tests/site-url.test.js asserts the two
 * agree on defaults and on resolution behaviour — change one, change both.
 */

/**
 * The default public origin.
 *
 * Moved from the old .ai domain to gatetest.io on 2026-07-30. The .ai domain entered
 * registry redemption on 2026-07-29 and returns NXDOMAIN, so anything still
 * defaulting to it is defaulting to a dead name. The .io domain is registered
 * to the same account, healthy, and expires 2027-04-08.
 */
const DEFAULT_SITE_URL = 'https://gatetest.io';

/**
 * Former public hosts that must keep answering forever, as a permanent
 * redirect to the canonical origin with the path kept (next.config.ts).
 *
 * gatetest.ai was the domain until 2026-07-30, then dropped into registry
 * redemption and went NXDOMAIN. Craig re-registered it at name.com on
 * 2026-10-02 (expires 2028-10-02). Customers' READMEs still embed badge
 * URLs on it that we can never edit — a dead host breaks every one of those
 * images, and a host someone else owns serves images inside our customers'
 * repos. Bare hosts, not URLs: nothing may LINK to them, only redirect away.
 */
const LEGACY_SITE_HOSTS = Object.freeze(['gatetest.ai']);

/**
 * Normalise an origin: add https:// if the scheme is missing, drop any
 * trailing slash, drop any path.
 *
 * Deployment platforms hand these over in inconsistent shapes — Vercel's
 * VERCEL_URL has no scheme, a hand-typed env var often has a trailing slash.
 * Both produce '//' in a joined URL, which mostly works and occasionally
 * breaks OAuth redirect-URI exact-matching in ways that are miserable to
 * debug.
 *
 * @param {string|undefined} raw
 * @returns {string|null} normalised origin, or null if unusable
 */
function normaliseOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    // Round-tripping through URL discards paths, query and fragments, and
    // rejects the malformed values that would otherwise reach a customer.
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the public origin from the environment.
 *
 * Precedence — first usable value wins:
 *   1. NEXT_PUBLIC_BASE_URL      — canonical; inlined into client bundles
 *   2. GATETEST_PUBLIC_BASE_URL  — server-side name used by the CLI/engine
 *   3. DEFAULT_SITE_URL
 *
 * Each is read as an explicit member expression rather than a dynamic
 * lookup so Next.js can statically inline NEXT_PUBLIC_BASE_URL when this
 * module is pulled into a client bundle. A dynamic `env[name]` would leave
 * the value undefined in the browser and silently fall through to the
 * default.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function resolveSiteUrl(env) {
  if (env) {
    return normaliseOrigin(env.NEXT_PUBLIC_BASE_URL)
      || normaliseOrigin(env.GATETEST_PUBLIC_BASE_URL)
      || DEFAULT_SITE_URL;
  }
  return normaliseOrigin(process.env.NEXT_PUBLIC_BASE_URL)
    || normaliseOrigin(process.env.GATETEST_PUBLIC_BASE_URL)
    || DEFAULT_SITE_URL;
}

/** The resolved public origin, e.g. 'https://gatetest.io'. No trailing slash. */
const SITE_URL = resolveSiteUrl();

/**
 * Build an absolute URL onto the public origin.
 *
 *   siteUrl()                  -> 'https://gatetest.io'
 *   siteUrl('/checkout')       -> 'https://gatetest.io/checkout'
 *   siteUrl('api/badge')       -> 'https://gatetest.io/api/badge'
 *
 * @param {string} [path]
 * @returns {string}
 */
function siteUrl(path = '') {
  if (!path) return SITE_URL;
  const p = String(path);
  return p.startsWith('/') ? `${SITE_URL}${p}` : `${SITE_URL}/${p}`;
}

/**
 * Bare host of the public origin, e.g. 'gatetest.io'.
 *
 * Needed by anything that speaks in hosts rather than URLs — IndexNow keys the
 * whole submission on a host that must match the URLs, and the fingerprint
 * store tags rows with one.
 *
 * @returns {string}
 */
function siteHost() {
  try {
    return new URL(SITE_URL).host;
  } catch {
    return new URL(DEFAULT_SITE_URL).host;
  }
}

/**
 * The origin that badge and README snippets are generated against.
 *
 * Deliberately separate from SITE_URL, and deliberately allowed to lag it.
 *
 * A badge someone pasted into their README in 2026 is a URL we can never
 * edit. When the site moves domain, every one of those badges keeps
 * resolving against the OLD origin — so the old domain must keep serving
 * (or 301'ing) for as long as those READMEs exist, which is effectively
 * forever. Retiring it turns every customer's build status into a broken
 * image.
 *
 * It nonetheless TRACKS SITE_URL by default, which reverses the call made in
 * the 2026-07-30 failover runbook. That note assumed the legacy domain was
 * still serving, so pinning new badges to it kept every customer on one
 * origin. It is not serving — it is in registry redemption returning
 * NXDOMAIN. Pinning here would mint new badges that are born broken. The fix
 * for the already-pasted ones is to redeem the old domain and 301 it, not to
 * keep generating dead URLs.
 *
 * Set GATETEST_BADGE_ORIGIN only to move NEWLY-generated snippets. It does
 * not and cannot migrate the ones already out there.
 */
const BADGE_ORIGIN = normaliseOrigin(process.env.GATETEST_BADGE_ORIGIN) || SITE_URL;

/**
 * The public support mailbox.
 *
 * DELIBERATELY LAGS the domain move, and defaults to the legacy host. A URL on
 * a dead domain is a visible error a customer can report; an e-mail address
 * with no MX record behind it is a SILENT one — support mail bounces or
 * vanishes and nobody finds out for weeks.
 *
 * Flip by setting GATETEST_SUPPORT_EMAIL once mail actually delivers on the
 * new domain. See docs/deploy/DOMAIN-FAILOVER-IO.md.
 */
const SUPPORT_EMAIL = (process.env.GATETEST_SUPPORT_EMAIL || 'support@gatetest.io').trim();

/**
 * Build an absolute URL for a customer-persisted badge or embed snippet.
 * @param {string} [path]
 * @returns {string}
 */
function badgeUrl(path = '') {
  if (!path) return BADGE_ORIGIN;
  const p = String(path);
  return p.startsWith('/') ? `${BADGE_ORIGIN}${p}` : `${BADGE_ORIGIN}/${p}`;
}

module.exports = {
  DEFAULT_SITE_URL,
  LEGACY_SITE_HOSTS,
  SITE_URL,
  BADGE_ORIGIN,
  SUPPORT_EMAIL,
  siteUrl,
  siteHost,
  badgeUrl,
  resolveSiteUrl,
  normaliseOrigin,
};
