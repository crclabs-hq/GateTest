/**
 * API Health Module — hits every discoverable API endpoint and verifies it
 * actually works, not just that it exists.
 *
 * Built on two pieces of existing infrastructure rather than duplicating
 * them: `endpoint-discovery.js` finds the (url, method, params) list to
 * test (OpenAPI spec > HTML crawl of forms/links > a curated common-paths
 * list), and `live-probe-runner.js` sends the actual requests — it
 * already enforces per-host rate limiting, per-request timeouts, a
 * wallclock budget, and blocks internal/metadata hosts (SSRF safety).
 * Reusing it here means this module gets "add delays between calls" (the
 * spec's own stated limitation for rate-limited endpoints) for free.
 *
 * This module is NOT the live-pentest-probe family (liveSqlInjection,
 * liveXss, ...) and does not go through `authorization-gate.js` — it
 * never sends attack payloads, only benign valid/missing-parameter
 * requests, the same trust level as `liveCrawler` / `runtimeErrors` /
 * `interactiveElements`.
 *
 * Per discovered endpoint (grouped by method+url, deduped across the
 * individual per-param rows endpoint-discovery emits), two requests are
 * sent:
 *   - a bare request with no parameters (the "invalid input" case — a
 *     well-behaved API should 400/422, not 500)
 *   - a request with every parameter filled with a benign, type-inferred
 *     value (the "valid input" case)
 *
 * Findings:
 *   - 5xx on either request → error (server crashed)
 *   - 404 on an endpoint sourced from OpenAPI / a real HTML crawl (NOT a
 *     speculative common-paths guess) → error (route regressed)
 *   - an API-shaped endpoint (path contains /api/, /graphql, .json, or a
 *     non-GET method, or sourced from an OpenAPI spec) answering with an
 *     HTML content-type instead of JSON → error (the literal "returns
 *     HTML instead of JSON" bug class named in the spec)
 *   - a 2xx response that claims `application/json` but doesn't parse as
 *     JSON → error (malformed response body)
 *   - response time over the slow threshold → warning (over `slowMs`,
 *     default 5s) or error (over `criticalMs`, default 15s)
 *
 * Known limitation (documented, not silently overclaimed): this module
 * cannot validate response BODY SHAPE against a schema (a tRPC procedure
 * returning 200 with the wrong fields) — that needs a real contract to
 * compare against, which is `trpcContract`'s / `openapiDrift`'s job on
 * the static side. This module only proves the endpoint answers, answers
 * fast enough, and answers with the content-type it should.
 *
 * Three-state verdict (issue #807, Doctrine #1). Against tallrig.com this
 * module printed "26 endpoint(s) checked — 0 broken" when every one of the
 * 26 was a common-paths GUESS that 404'd: nothing real had been verified,
 * and the green line read as a health check that had passed. A health
 * check that cannot go red is not a health check. Now an endpoint counts
 * as CONFIRMED only when it came from a spec / explicit config / the site's
 * own HTML, or a guessed path answered like a live route (anything but
 * 404/410 or the site's catch-all HTML page); with zero confirmed
 * endpoints the module reports `apiHealth:not-checked` and says which
 * discovery sources were missing, and the same for no URL at all.
 */

'use strict';

const BaseModule = require('./base-module');
const { LiveProbeRunner } = require('../core/live-probe-runner');
const {
  discoverFromCommonPaths,
  discoverFromOpenApi,
  discoverFromHtml,
  mergeDiscoveries,
} = require('../core/endpoint-discovery');
const { FIXTURE_EMAIL, siteUrl } = require('../core/site-url');

const DEFAULT_MAX_ENDPOINTS = 30;
const DEFAULT_SLOW_MS = 5000;
const DEFAULT_CRITICAL_MS = 15000;

function inferBenignValue(paramName) {
  const n = (paramName || '').toLowerCase();
  if (/email/.test(n)) return FIXTURE_EMAIL;
  if (/url|link|redirect|callback|return/.test(n)) return siteUrl();
  if (/id\b|count|page|limit|number|age|qty|quantity/.test(n)) return '1';
  if (/phone|tel/.test(n)) return '+15555550100';
  if (/password|pwd|pass\b/.test(n)) return 'GateTest-Probe-1!';
  if (/date|time/.test(n)) return new Date(0).toISOString();
  return 'gatetest-probe';
}

function groupByEndpoint(discovered) {
  const map = new Map();
  for (const ep of discovered) {
    const key = `${ep.method}|${ep.url}`;
    if (!map.has(key)) {
      map.set(key, { url: ep.url, method: ep.method, params: [], sources: new Set() });
    }
    const entry = map.get(key);
    if (ep.paramName) entry.params.push({ name: ep.paramName, location: ep.paramLocation });
    entry.sources.add(ep.source);
  }
  return Array.from(map.values());
}

// "API-shaped" means the ROUTE promises JSON: a spec or explicit config said
// so, or the path says so. A non-GET method alone does not — a contact /
// newsletter form harvested from the homepage POSTs to a page path and
// legitimately answers with an HTML page, so flagging it as "returned HTML
// instead of JSON" was a false claim (issue #807; the old rule treated every
// non-GET method as an API).
function looksLikeApiEndpoint(url, method, sources) {
  if (sources.has('openapi') || sources.has('explicit-config')) return true;
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return /\/api\/|\/graphql|\.json$|\/wp-json\//.test(pathname);
}

// Did the response prove a route LIVES at this URL? Trusted sources already
// proved it (a 404 there is a regression, reported separately). A guessed
// path only counts when the answer is not "no such route" — 404 / 410 — and
// not the site's normal 200 catch-all HTML page (SPA shells and custom error
// pages answer every unknown path that way).
function confirmsRoute(res, trusted, contentType) {
  if (trusted) return true;
  if (!res.ok) return false;
  if (res.status === 404 || res.status === 410) return false;
  if (res.status < 400 && /text\/html/i.test(contentType)) return false;
  return true;
}

// A broken-endpoint finding must name what to act on: method, URL and status
// (or reason) of the first few, never just a count (gluecron.com 2026-10-03:
// "1 broken endpoint among 21 checked" named nothing).
function describeBroken(list, max = 3) {
  const one = (b) => `${b.method || 'GET'} ${b.url} (${b.status ? `HTTP ${b.status}` : b.reason || 'request failed'})`;
  const shown = list.slice(0, max).map(one).join('; ');
  return list.length > max ? `${shown}; +${list.length - max} more` : shown;
}

// Which discovery sources were actually available — the not-checked reason
// names the missing ones so the operator knows what to configure.
function describeDiscovery(prov, guessed) {
  const missing = [];
  if (!prov.openapi) missing.push('no OpenAPI spec (modules.apiHealth.openApiSpec)');
  if (!prov.explicit) missing.push('no explicit endpoints (modules.apiHealth.endpoints)');
  if (!prov.homeFetched) {
    missing.push(`the homepage could not be fetched for forms/links${prov.homeStatus ? ` (HTTP ${prov.homeStatus})` : ''}`);
  } else if (prov.htmlDiscovered === 0) {
    missing.push('no API-shaped forms or links on the homepage');
  }
  const probed = guessed > 0
    ? `${guessed} guessed common path(s) probed, none answered as a live route`
    : 'no common path answered as a live route';
  return `${missing.join('; ')}; ${probed}`;
}

class ApiHealthModule extends BaseModule {
  constructor() {
    super('apiHealth', 'API Health Check — hits every discovered endpoint, verifies status/shape/timing');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('apiHealth') || {};
    const baseUrl =
      process.env.GATETEST_API_HEALTH_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      this._notChecked(result, 'this module probes a live site and no target URL was configured — set GATETEST_API_HEALTH_URL or modules.apiHealth.url in .gatetest/config.json');
      return;
    }

    const runner = moduleCfg.runner || new LiveProbeRunner(moduleCfg.runnerOpts || {});
    const maxEndpoints = moduleCfg.maxEndpoints || DEFAULT_MAX_ENDPOINTS;
    const slowMs = typeof moduleCfg.slowMs === 'number' ? moduleCfg.slowMs : DEFAULT_SLOW_MS;
    const criticalMs = typeof moduleCfg.criticalMs === 'number' ? moduleCfg.criticalMs : DEFAULT_CRITICAL_MS;

    const { discovered, provenance } = await this._discover(runner, baseUrl, moduleCfg);
    const endpoints = groupByEndpoint(discovered).slice(0, maxEndpoints);

    if (endpoints.length === 0) {
      this._notChecked(result, `no endpoints to probe at ${baseUrl}: ${describeDiscovery(provenance, 0)}`);
      return;
    }

    const stats = {
      endpointsChecked: 0,
      confirmed: new Set(),
      brokenEndpoints: [],
      slowEndpoints: [],
      wrongContentType: [],
      malformedJson: [],
    };

    for (const ep of endpoints) {
      await this._checkEndpoint(runner, ep, { slowMs, criticalMs, stats });
      if (runner.aborted) break;
    }

    this._report(result, stats, baseUrl, runner.summary(), provenance);
  }

  async _discover(runner, baseUrl, moduleCfg) {
    const lists = [discoverFromCommonPaths(baseUrl)];
    const provenance = { openapi: false, explicit: false, homeFetched: false, htmlDiscovered: 0 };

    if (moduleCfg.openApiSpec) {
      provenance.openapi = true;
      lists.push(discoverFromOpenApi(moduleCfg.openApiSpec, baseUrl));
    }

    if (Array.isArray(moduleCfg.endpoints) && moduleCfg.endpoints.length > 0) {
      provenance.explicit = true;
      lists.push(
        moduleCfg.endpoints.map((e) => ({
          url: new URL(e.path || e.url, baseUrl).toString(),
          method: (e.method || 'GET').toUpperCase(),
          paramName: null,
          paramLocation: 'none',
          source: 'explicit-config',
        })),
      );
    }

    // One cheap GET of the homepage to harvest real forms/links — the
    // same signal `liveCrawler`/`explorer` already extract, reused here
    // rather than re-implemented.
    try {
      const home = await runner.probe({ method: 'GET', url: baseUrl });
      if (home.ok && typeof home.body === 'string') {
        provenance.homeFetched = home.status < 400;
        provenance.homeStatus = home.status;
        const fromHtml = discoverFromHtml(home.body, baseUrl);
        provenance.htmlDiscovered = fromHtml.length;
        lists.push(fromHtml);
      }
    } catch {
      /* error-ok — homepage fetch failure just means we fall back to common-paths only */
    }

    return { discovered: mergeDiscoveries(...lists), provenance };
  }

  async _checkEndpoint(runner, ep, { slowMs, criticalMs, stats }) {
    stats.endpointsChecked++;
    const apiShaped = looksLikeApiEndpoint(ep.url, ep.method, ep.sources);
    const trusted = !ep.sources.has('common-paths') || ep.sources.size > 1;

    // Path params (OpenAPI `/users/{id}`-style templates) are part of the
    // route itself, not an optional input — substitute them even on the
    // "bare" probe so we hit a real, routable URL instead of a literal
    // "{id}" 404 that would otherwise be misreported as broken.
    const resolvedUrl = this._substitutePathParams(ep.url, ep.params);
    const inputParams = ep.params.filter((p) => p.location !== 'path');

    const bareResult = await runner.probe({ method: ep.method, url: resolvedUrl });
    this._analyze(bareResult, ep, { slowMs, criticalMs, stats, apiShaped, trusted, variant: 'bare' });
    if (runner.aborted) return;

    if (inputParams.length > 0) {
      const filledResult = await this._probeFilled(runner, ep, resolvedUrl, inputParams);
      this._analyze(filledResult, ep, { slowMs, criticalMs, stats, apiShaped, trusted, variant: 'filled' });
    }
  }

  _substitutePathParams(url, params) {
    let out = url;
    for (const p of params) {
      if (p.location !== 'path') continue;
      const value = encodeURIComponent(inferBenignValue(p.name));
      out = out.replace(new RegExp(`\\{${p.name}\\}`, 'g'), value);
    }
    return out;
  }

  async _probeFilled(runner, ep, resolvedUrl, inputParams) {
    if (ep.method === 'GET') {
      const u = new URL(resolvedUrl);
      for (const p of inputParams) {
        u.searchParams.set(p.name, inferBenignValue(p.name));
      }
      return runner.probe({ method: ep.method, url: u.toString() });
    }
    const body = {};
    for (const p of inputParams) body[p.name] = inferBenignValue(p.name);
    return runner.probe({
      method: ep.method,
      url: resolvedUrl,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  _analyze(res, ep, { slowMs, criticalMs, stats, apiShaped, trusted, variant }) {
    const contentType = (res.headers && res.headers['content-type']) || '';
    if (confirmsRoute(res, trusted, contentType)) stats.confirmed.add(`${ep.method}|${ep.url}`);

    if (!res.ok) {
      if (res.blocked) return; // internal/metadata host — not a customer-facing finding
      stats.brokenEndpoints.push({
        url: ep.url, method: ep.method, variant, status: res.status || null,
        reason: res.error || res.reason || 'request failed',
      });
      return;
    }

    if (res.status >= 500) {
      stats.brokenEndpoints.push({ url: ep.url, method: ep.method, variant, status: res.status, reason: `HTTP ${res.status}` });
    } else if (res.status === 404 && trusted) {
      stats.brokenEndpoints.push({ url: ep.url, method: ep.method, variant, status: 404, reason: 'route not found (was reachable in discovery source)' });
    }

    if (res.timeMs >= criticalMs) {
      stats.slowEndpoints.push({ url: ep.url, method: ep.method, variant, timeMs: res.timeMs, severity: 'error' });
    } else if (res.timeMs >= slowMs) {
      stats.slowEndpoints.push({ url: ep.url, method: ep.method, variant, timeMs: res.timeMs, severity: 'warning' });
    }

    // Untrusted (common-paths-guess) endpoints that don't really exist on
    // this stack commonly get served the site's normal 200-status catch-
    // all page instead of a proper 404 (SPA routing, custom error pages).
    // That's expected for a guessed path — e.g. hitting /wp-json/... on a
    // site that isn't WordPress — and must not be reported as a bug;
    // confirmed as a real false positive against a sibling platform's
    // /graphql, /wp-login.php, /wp-json/wp/v2/users during this module's
    // proof run.
    //
    // A 4xx counts too (issue #807 "404 shape"): a confirmed API route that
    // answers 400/401/403/422 with an HTML page is the framework's error
    // page or a login redirect standing in for the JSON error the client
    // expects. 404 is excluded here only because a trusted route 404ing is
    // already reported as broken above, and a 5xx likewise.
    if (apiShaped && trusted && res.status < 500 && res.status !== 404 && /text\/html/i.test(contentType)) {
      stats.wrongContentType.push({ url: ep.url, method: ep.method, variant, status: res.status, contentType });
    } else if (/application\/json/i.test(contentType) && res.status < 300 && res.body) {
      try {
        JSON.parse(res.body);
      } catch {
        stats.malformedJson.push({ url: ep.url, method: ep.method, variant });
      }
    }
  }

  _report(result, stats, baseUrl, runnerSummary, provenance) {
    const confirmed = stats.confirmed.size;
    const guessed = stats.endpointsChecked - confirmed;
    const findings = stats.brokenEndpoints.length + stats.wrongContentType.length
      + stats.malformedJson.length + stats.slowEndpoints.length;

    // Nothing confirmed and nothing found: every probe was a guess that the
    // site answered "no such route". That is not "0 broken" — it is a scan
    // that had nothing real to look at, and must say so.
    if (confirmed === 0 && findings === 0) {
      this._notChecked(result, `no API endpoint confirmed at ${baseUrl}: ${describeDiscovery(provenance, guessed)}`);
      this._summary(result, stats, baseUrl, runnerSummary, confirmed);
      return;
    }

    if (stats.brokenEndpoints.length > 0) {
      result.addCheck('api-health:broken-endpoints', false, {
        severity: 'error',
        message: `${stats.brokenEndpoints.length} broken endpoint(s) found across ${stats.endpointsChecked} checked: ${describeBroken(stats.brokenEndpoints)}`,
        details: stats.brokenEndpoints.slice(0, 30),
        suggestion: 'Fix the 5xx / missing route, or confirm the endpoint was intentionally removed',
      });
    } else {
      const guessedPart = guessed > 0 ? ` (${guessed} guessed path(s) answered "no such route" and are not counted)` : '';
      result.addCheck('api-health:broken-endpoints', true, {
        severity: 'info',
        message: `${confirmed} confirmed endpoint(s) checked — 0 broken${guessedPart}`,
      });
    }

    if (stats.wrongContentType.length > 0) {
      result.addCheck('api-health:wrong-content-type', false, {
        severity: 'error',
        message: `${stats.wrongContentType.length} API endpoint(s) returned HTML instead of JSON`,
        details: stats.wrongContentType.slice(0, 30),
        suggestion: 'Check for an unhandled error page, redirect-to-login, or middleware intercepting the API route',
      });
    }

    if (stats.malformedJson.length > 0) {
      result.addCheck('api-health:malformed-json', false, {
        severity: 'error',
        message: `${stats.malformedJson.length} endpoint(s) claim application/json but returned a body that doesn't parse as JSON`,
        details: stats.malformedJson.slice(0, 30),
      });
    }

    if (stats.slowEndpoints.length > 0) {
      const critical = stats.slowEndpoints.filter((e) => e.severity === 'error');
      result.addCheck('api-health:slow-endpoints', critical.length === 0, {
        severity: critical.length > 0 ? 'error' : 'warning',
        message: `${stats.slowEndpoints.length} slow endpoint(s) found (${critical.length} over the critical threshold)`,
        details: stats.slowEndpoints.slice(0, 30),
        suggestion: 'Investigate slow database queries, missing indexes, or blocking external calls on the request path',
      });
    }

    this._summary(result, stats, baseUrl, runnerSummary, confirmed);
  }

  _summary(result, stats, baseUrl, runnerSummary, confirmed) {
    result.addCheck('api-health:summary', true, {
      severity: 'info',
      message: `${stats.endpointsChecked} endpoint(s) probed at ${baseUrl}, ${confirmed} confirmed live: ${stats.brokenEndpoints.length} broken, ${stats.slowEndpoints.length} slow, ${stats.wrongContentType.length} wrong-content-type, ${stats.malformedJson.length} malformed-json (${runnerSummary.totalRequests} requests sent${runnerSummary.aborted ? `, aborted: ${runnerSummary.abortReason}` : ''})`,
    });
  }
}

module.exports = ApiHealthModule;
// Exposed for unit tests
module.exports.inferBenignValue = inferBenignValue;
module.exports.groupByEndpoint = groupByEndpoint;
module.exports.looksLikeApiEndpoint = looksLikeApiEndpoint;
