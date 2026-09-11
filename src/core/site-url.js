'use strict';
/**
 * The canonical public origin for the ENGINE, CLI, MCP server and reporters.
 *
 * This is the src/ counterpart of `website/app/lib/site-url.js`. That file
 * centralised 148 hardcoded origins inside the Next app; this one does the
 * same job for everything that ships in the npm package — where the same
 * literal appeared in reporters, PR comment footers, SARIF metadata, the
 * telemetry endpoint, the MCP subscription copy, and twelve near-identical
 * Playwright bot user-agent strings.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Never write a gatetest.ai / gatetest.io literal in engine code. Import
 * `siteUrl()`. `tests/site-url.test.js` fails the suite if literals reappear
 * in the files where a wrong origin reaches a customer.
 *
 * ── Why this is a SECOND file and not a re-export ────────────────────────────
 * The website copy reads `process.env.NEXT_PUBLIC_BASE_URL` as an explicit
 * static member expression so Next.js can inline it into CLIENT bundles. The
 * engine copy must stay standalone because the published npm package ships
 * src/ and bin/ WITHOUT website/, so it cannot require across that boundary.
 *
 * The two are kept honest by a drift guard in `tests/site-url.test.js` that
 * asserts identical defaults and identical resolution behaviour. Change one,
 * change both, or the suite fails.
 */

/**
 * The default public origin.
 *
 * Moved gatetest.ai -> gatetest.io on 2026-07-30. The .ai domain entered
 * registry redemption on 2026-07-29 and returns NXDOMAIN; .io is registered
 * to the same account and healthy. Anything still defaulting to .ai is
 * defaulting to a dead name.
 */
const DEFAULT_SITE_URL = 'https://gatetest.io';

/** The origin we moved away from. Kept named so 301 handling can reference it. */
const LEGACY_SITE_URL = 'https://gatetest.ai';

/**
 * Normalise an origin: add https:// when the scheme is missing, drop any
 * trailing slash, drop any path, query or fragment.
 *
 * Hosting platforms hand these over in inconsistent shapes — a bare host with
 * no scheme, or a hand-typed value with a trailing slash. Both produce '//' in
 * a joined URL, which mostly works and then fails OAuth redirect-URI
 * exact-matching in ways that are miserable to debug.
 *
 * @param {string|undefined} raw
 * @returns {string|null} normalised origin, or null when unusable
 */
function normaliseOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    // Round-tripping through URL discards paths and rejects the malformed
    // values that would otherwise reach a customer.
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the public origin from the environment. First usable value wins:
 *   1. NEXT_PUBLIC_BASE_URL      — canonical; shared with the web app
 *   2. GATETEST_PUBLIC_BASE_URL  — server-side name used by the CLI/engine
 *   3. DEFAULT_SITE_URL
 *
 * Precedence deliberately matches the website copy: both names are set to the
 * same value on the box, and two modules disagreeing about which wins is the
 * kind of split-brain that only shows up in production.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function resolveSiteUrl(env) {
  const source = env || process.env;
  return normaliseOrigin(source.NEXT_PUBLIC_BASE_URL)
    || normaliseOrigin(source.GATETEST_PUBLIC_BASE_URL)
    || DEFAULT_SITE_URL;
}

/** The resolved public origin, e.g. 'https://gatetest.io'. No trailing slash. */
const SITE_URL = resolveSiteUrl();

/**
 * Build an absolute URL onto the public origin.
 *
 *   siteUrl()             -> 'https://gatetest.io'
 *   siteUrl('/mcp')       -> 'https://gatetest.io/mcp'
 *   siteUrl('api/badge')  -> 'https://gatetest.io/api/badge'
 *
 * @param {string} [path]
 * @returns {string}
 */
function siteUrl(path = '') {
  if (!path) return SITE_URL;
  const p = String(path);
  return p.startsWith('/') ? `${SITE_URL}${p}` : `${SITE_URL}/${p}`;
}

/** Bare host of the public origin, e.g. 'gatetest.io'. */
function siteHost() {
  try {
    return new URL(SITE_URL).host;
  } catch {
    return new URL(DEFAULT_SITE_URL).host;
  }
}

/**
 * Base URL of the HOSTED API that the CLI and MCP server call out to.
 *
 * Distinct from SITE_URL as a concept — "which deployment do I talk to" is not
 * "what do I call myself" — which is why it keeps its own override. Pointing
 * this at a staging box is a normal thing to want; pointing canonical SEO URLs
 * there is not.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} origin with no trailing slash
 */
function apiBaseUrl(env) {
  const source = env || process.env;
  return normaliseOrigin(source.GATETEST_API_BASE_URL) || resolveSiteUrl(source);
}

/**
 * The User-Agent our headless-browser modules present to customer sites.
 *
 * Twelve modules each hand-wrote this string with the domain baked in. Site
 * owners DO look this up in their logs, so the '+' URL has to resolve to a
 * page that explains who we are — which makes it exactly as domain-sensitive
 * as a canonical tag, and exactly as easy to forget.
 *
 * @param {string} [label] module name appended for log attribution
 * @returns {string}
 */
function botUserAgent(label = '') {
  const base = `GateTest/1.0 (+${siteUrl('/bot')})`;
  return label ? `${base} ${label}` : base;
}

/**
 * The public support mailbox.
 *
 * DELIBERATELY LAGS the domain move, and defaults to the legacy host. A URL
 * on a dead domain is a visible error the customer can report; an e-mail
 * address with no MX record behind it is a SILENT one — support mail bounces
 * or vanishes and nobody finds out for weeks.
 *
 * Flip this by setting GATETEST_SUPPORT_EMAIL once mail actually delivers on
 * the new domain. See docs/deploy/DOMAIN-FAILOVER-IO.md.
 */
const SUPPORT_EMAIL = (process.env.GATETEST_SUPPORT_EMAIL || 'support@gatetest.io').trim();

/**
 * The throwaway address our form-filling and API-probe modules type into
 * customer inputs. Never receives mail — it exists so a required e-mail field
 * accepts the probe and the site owner can see who submitted it.
 */
const FIXTURE_EMAIL = `test@${siteHost()}`;

/**
 * The origin that badge and embed snippets are generated against.
 *
 * Kept independently settable because badge markdown pasted into a customer's
 * README is a URL we can never edit — when the site moves, every already
 * -pasted badge keeps resolving against the OLD origin forever.
 *
 * It nonetheless TRACKS SITE_URL by default, which reverses the call made in
 * the 2026-07-30 failover runbook. That note assumed the legacy domain was
 * still serving, so pinning new badges to it kept every customer on one
 * origin. It is not serving — it is in registry redemption returning
 * NXDOMAIN. Pinning here would mint new badges that are born broken. The
 * right fix for the already-pasted ones is to redeem the old domain and 301
 * it, not to keep generating dead URLs.
 */
const BADGE_ORIGIN = normaliseOrigin(process.env.GATETEST_BADGE_ORIGIN) || SITE_URL;

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
  LEGACY_SITE_URL,
  SITE_URL,
  BADGE_ORIGIN,
  SUPPORT_EMAIL,
  FIXTURE_EMAIL,
  siteUrl,
  siteHost,
  badgeUrl,
  apiBaseUrl,
  botUserAgent,
  resolveSiteUrl,
  normaliseOrigin,
};
