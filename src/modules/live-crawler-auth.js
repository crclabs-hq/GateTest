'use strict';

/**
 * Live-crawler authentication — lets the crawler carry a session so it can
 * test pages behind a login (dashboards, account areas, admin panels).
 *
 * Three mechanisms, usable together:
 *   - headers      { "Authorization": "Bearer ..." }  — sent same-origin only
 *   - cookie       "session=abc; other=x"             — sent same-origin only
 *   - storageState path to a Playwright storage-state JSON (browser engine)
 *
 * Values support ${ENV_VAR} expansion so secrets stay in the environment,
 * never in a committed .gatetest config file.
 *
 * SECURITY INVARIANT: auth material is only ever attached to requests whose
 * origin exactly matches the crawl target's origin. External links, images,
 * scripts, and stylesheets on third-party hosts never receive it.
 */

const fs = require('fs');
const { URL } = require('url');

const LOGIN_URL_RE = /\/(log-?in|sign-?in|auth(entication)?|sso|session\/new|account\/login|wp-login\.php)([/?#]|$)/i;

function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name) =>
    process.env[name] !== undefined ? process.env[name] : match);
}

/**
 * Build the auth descriptor from module config. Returns:
 *   { enabled, headers, cookie, storageState, storageStateMissing, origin }
 * `headers` never contains the Cookie header — engines decide how to carry
 * the cookie (HTTP engine merges it in; browser engine uses addCookies so
 * the browser scopes it by domain natively).
 */
function resolveAuth(crawlConfig, baseUrl) {
  const headers = {};
  let cookie = expandEnv(crawlConfig.cookie || crawlConfig.cookies || null);
  for (const [name, value] of Object.entries(crawlConfig.headers || {})) {
    const expanded = expandEnv(value);
    if (!expanded) continue;
    // A header literally named Cookie folds into the cookie field so the
    // browser engine can scope it by domain via addCookies.
    if (/^cookie$/i.test(name)) cookie = cookie ? `${cookie}; ${expanded}` : expanded;
    else headers[name] = expanded;
  }

  const storageState = crawlConfig.storageState || null;
  const storageStateMissing = Boolean(storageState && !fs.existsSync(storageState));

  let origin = null;
  try { origin = new URL(baseUrl).origin; } catch { /* unset — auth disabled */ }

  const enabled = Boolean(origin) && (
    Object.keys(headers).length > 0 || Boolean(cookie) ||
    Boolean(storageState && !storageStateMissing)
  );

  return { enabled, headers, cookie, storageState, storageStateMissing, origin };
}

function sameOrigin(url, origin) {
  if (!origin) return false;
  try { return new URL(url).origin === origin; } catch { return false; }
}

/**
 * Headers to attach to an HTTP-engine request for `url` — merged
 * headers + Cookie when same-origin, undefined otherwise.
 */
function authHeadersFor(url, auth) {
  if (!auth || !auth.enabled || !sameOrigin(url, auth.origin)) return undefined;
  const merged = { ...auth.headers };
  if (auth.cookie) merged['Cookie'] = auth.cookie;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isLoginUrl(url) {
  return LOGIN_URL_RE.test(url);
}

/** Parse a "name=value; name2=value2" cookie string into Playwright addCookies format. */
function parseCookiesForBrowser(cookie, baseUrl) {
  if (!cookie) return [];
  return cookie.split(';')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 1) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url: baseUrl };
    })
    .filter(Boolean);
}

module.exports = { resolveAuth, sameOrigin, authHeadersFor, isLoginUrl, parseCookiesForBrowser, expandEnv };
