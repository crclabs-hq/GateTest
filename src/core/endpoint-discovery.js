/**
 * Endpoint Discovery — find the parameterised URLs to probe.
 *
 * Live probes need a list of (URL, parameter) pairs to test. This module
 * builds that list from three sources:
 *
 *   1. OpenAPI / Swagger spec — if the customer has one, harvest every
 *      path + parameter (best signal, no crawling needed).
 *   2. HTML crawl — fetch the target, parse forms / links / fetch() calls,
 *      enumerate <a href="?foo=...">, <form action="..." method="POST">.
 *   3. Common paths — a curated set of likely API endpoints (login,
 *      register, users, search) to probe even if the crawl doesn't find
 *      them.
 *
 * The output is a flat list:
 *   [
 *     { url, method, paramName, paramLocation, source },
 *     ...
 *   ]
 *
 * paramLocation is one of: 'query', 'body', 'path', 'header'.
 * source tracks where we found it (openapi / crawl / common-paths).
 *
 * THIS MODULE DOES NOT SEND PROBES. It only discovers what to probe.
 * The actual probe-sending is in each live-* module via the runner.
 */

'use strict';

// ─── Common high-value paths to probe even if undiscovered ───────────────

const COMMON_API_PATHS = [
  // Auth surface
  { path: '/api/login', method: 'POST', params: ['username', 'password', 'email'] },
  { path: '/api/auth/login', method: 'POST', params: ['username', 'password', 'email'] },
  { path: '/api/register', method: 'POST', params: ['username', 'password', 'email'] },
  { path: '/api/auth/register', method: 'POST', params: ['username', 'password', 'email'] },
  { path: '/api/auth/reset', method: 'POST', params: ['email', 'token'] },
  // User / object access
  { path: '/api/users', method: 'GET', params: ['id', 'q', 'search'] },
  { path: '/api/users/1', method: 'GET', params: [] },
  { path: '/api/user/profile', method: 'GET', params: ['id'] },
  // Search / query
  { path: '/api/search', method: 'GET', params: ['q', 'query', 'term'] },
  { path: '/search', method: 'GET', params: ['q', 'query', 'search'] },
  // File / path
  { path: '/api/files', method: 'GET', params: ['path', 'file', 'name'] },
  { path: '/download', method: 'GET', params: ['file', 'path', 'name'] },
  // Redirects
  { path: '/redirect', method: 'GET', params: ['url', 'to', 'next', 'redirect'] },
  { path: '/api/redirect', method: 'GET', params: ['url', 'to', 'return'] },
  { path: '/login', method: 'GET', params: ['next', 'return', 'redirect_uri'] },
  // GraphQL
  { path: '/graphql', method: 'POST', params: ['query', 'variables'] },
  // Admin surface
  { path: '/admin', method: 'GET', params: [] },
  { path: '/admin/users', method: 'GET', params: ['id'] },
  // WordPress
  { path: '/wp-admin', method: 'GET', params: [] },
  { path: '/wp-login.php', method: 'POST', params: ['log', 'pwd'] },
  { path: '/wp-json/wp/v2/users', method: 'GET', params: [] },
];

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Build the probe list from common paths only (no crawl, no spec).
 * Useful as a baseline when nothing else is available.
 */
function discoverFromCommonPaths(baseUrl) {
  const out = [];
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return out;
  }
  for (const ep of COMMON_API_PATHS) {
    const url = origin + ep.path;
    if (ep.params.length === 0) {
      out.push({ url, method: ep.method, paramName: null, paramLocation: 'none', source: 'common-paths' });
    } else {
      for (const p of ep.params) {
        out.push({
          url,
          method: ep.method,
          paramName: p,
          paramLocation: ep.method === 'GET' ? 'query' : 'body',
          source: 'common-paths',
        });
      }
    }
  }
  return out;
}

/**
 * Parse an OpenAPI 3.x spec and return probe targets.
 * Accepts the spec as a plain JS object (yaml/json already parsed).
 */
function discoverFromOpenApi(spec, baseUrl) {
  const out = [];
  if (!spec || typeof spec !== 'object') return out;
  const paths = spec.paths || {};
  const servers = (spec.servers && spec.servers[0] && spec.servers[0].url) || baseUrl;
  let origin;
  try {
    origin = new URL(servers).origin;
  } catch {
    origin = baseUrl;
  }

  for (const [pathTpl, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[verb];
      if (!op || typeof op !== 'object') continue;
      const fullUrl = origin + pathTpl;
      const params = Array.isArray(op.parameters) ? op.parameters : [];
      let emitted = 0;
      for (const p of params) {
        out.push({
          url: fullUrl,
          method: verb.toUpperCase(),
          paramName: p.name,
          paramLocation: p.in || 'query',
          source: 'openapi',
        });
        emitted++;
      }
      // Body params (requestBody)
      if (op.requestBody && op.requestBody.content) {
        const schemas = op.requestBody.content;
        for (const [, mediaType] of Object.entries(schemas)) {
          const props = mediaType && mediaType.schema && mediaType.schema.properties;
          if (!props) continue;
          for (const propName of Object.keys(props)) {
            out.push({
              url: fullUrl,
              method: verb.toUpperCase(),
              paramName: propName,
              paramLocation: 'body',
              source: 'openapi',
            });
            emitted++;
          }
        }
      }
      // Only emit a no-param entry if neither query nor body contributed.
      if (emitted === 0) {
        out.push({
          url: fullUrl, method: verb.toUpperCase(),
          paramName: null, paramLocation: 'none', source: 'openapi',
        });
      }
    }
  }
  return out;
}

/**
 * Parse HTML and harvest forms + links with query params.
 */
function discoverFromHtml(html, pageUrl) {
  const out = [];
  if (typeof html !== 'string') return out;

  const base = (() => {
    try { return new URL(pageUrl).origin; } catch { return null; }
  })();
  if (!base) return out;

  // Forms: <form action="..." method="...">
  const formRe = /<form\b[^>]*?\baction\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = formRe.exec(html)) !== null) {
    const action = m[1];
    const formBody = m[2];
    const methodMatch = m[0].match(/\bmethod\s*=\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i);
    const method = (methodMatch ? methodMatch[1] : 'GET').toUpperCase();

    const url = absolutise(action, base);
    if (!url) continue;

    const inputRe = /<input\b[^>]*?\bname\s*=\s*["']([^"']+)["']/gi;
    let inputMatch;
    let count = 0;
    while ((inputMatch = inputRe.exec(formBody)) !== null) {
      out.push({
        url,
        method,
        paramName: inputMatch[1],
        paramLocation: method === 'GET' ? 'query' : 'body',
        source: 'html-form',
      });
      count++;
    }
    if (count === 0) {
      out.push({ url, method, paramName: null, paramLocation: 'none', source: 'html-form' });
    }
  }

  // Links with query params: <a href="?foo=bar">
  const linkRe = /<a\b[^>]*?\bhref\s*=\s*["']([^"']*\?[^"']+)["']/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const url = absolutise(m[1], base);
    if (!url) continue;
    try {
      const u = new URL(url);
      u.searchParams.forEach((_, paramName) => {
        out.push({
          url: u.origin + u.pathname,
          method: 'GET',
          paramName,
          paramLocation: 'query',
          source: 'html-link',
        });
      });
    } catch { /* skip malformed url */ }
  }

  return out;
}

function absolutise(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Merge discovery results from multiple sources, dedupe.
 */
function mergeDiscoveries(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const ep of list || []) {
      const key = `${ep.method}|${ep.url}|${ep.paramName || ''}|${ep.paramLocation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ep);
    }
  }
  return out;
}

module.exports = {
  COMMON_API_PATHS,
  discoverFromCommonPaths,
  discoverFromOpenApi,
  discoverFromHtml,
  mergeDiscoveries,
};
