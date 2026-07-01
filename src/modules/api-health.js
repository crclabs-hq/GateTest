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

const DEFAULT_MAX_ENDPOINTS = 30;
const DEFAULT_SLOW_MS = 5000;
const DEFAULT_CRITICAL_MS = 15000;

function inferBenignValue(paramName) {
  const n = (paramName || '').toLowerCase();
  if (/email/.test(n)) return 'test@gatetest.ai';
  if (/url|link|redirect|callback|return/.test(n)) return 'https://gatetest.ai';
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

function looksLikeApiEndpoint(url, method, sources) {
  if (method !== 'GET') return true;
  if (sources.has('openapi')) return true;
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return /\/api\/|\/graphql|\.json$|\/wp-json\//.test(pathname);
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
      result.addCheck('api-health:config', true, {
        severity: 'info',
        message: 'No target URL configured — set GATETEST_API_HEALTH_URL or modules.apiHealth.url in .gatetest/config.json',
      });
      return;
    }

    const runner = moduleCfg.runner || new LiveProbeRunner(moduleCfg.runnerOpts || {});
    const maxEndpoints = moduleCfg.maxEndpoints || DEFAULT_MAX_ENDPOINTS;
    const slowMs = typeof moduleCfg.slowMs === 'number' ? moduleCfg.slowMs : DEFAULT_SLOW_MS;
    const criticalMs = typeof moduleCfg.criticalMs === 'number' ? moduleCfg.criticalMs : DEFAULT_CRITICAL_MS;

    const discovered = await this._discover(runner, baseUrl, moduleCfg);
    const endpoints = groupByEndpoint(discovered).slice(0, maxEndpoints);

    if (endpoints.length === 0) {
      result.addCheck('api-health:no-endpoints', true, {
        severity: 'info',
        message: `No API-shaped endpoints discovered at ${baseUrl}`,
      });
      return;
    }

    const stats = {
      endpointsChecked: 0,
      brokenEndpoints: [],
      slowEndpoints: [],
      wrongContentType: [],
      malformedJson: [],
    };

    for (const ep of endpoints) {
      await this._checkEndpoint(runner, ep, { slowMs, criticalMs, stats });
      if (runner.aborted) break;
    }

    this._report(result, stats, baseUrl, runner.summary());
  }

  async _discover(runner, baseUrl, moduleCfg) {
    const lists = [discoverFromCommonPaths(baseUrl)];

    if (moduleCfg.openApiSpec) {
      lists.push(discoverFromOpenApi(moduleCfg.openApiSpec, baseUrl));
    }

    if (Array.isArray(moduleCfg.endpoints)) {
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
        lists.push(discoverFromHtml(home.body, baseUrl));
      }
    } catch {
      /* homepage fetch failure just means we fall back to common-paths only */
    }

    return mergeDiscoveries(...lists);
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
    if (!res.ok) {
      if (res.blocked) return; // internal/metadata host — not a customer-facing finding
      stats.brokenEndpoints.push({
        url: ep.url, method: ep.method, variant, reason: res.error || res.reason || 'request failed',
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

    const contentType = (res.headers && res.headers['content-type']) || '';
    // Untrusted (common-paths-guess) endpoints that don't really exist on
    // this stack commonly get served the site's normal 200-status catch-
    // all page instead of a proper 404 (SPA routing, custom error pages).
    // That's expected for a guessed path — e.g. hitting /wp-json/... on a
    // site that isn't WordPress — and must not be reported as a bug;
    // confirmed as a real false positive against vapron.ai's /graphql,
    // /wp-login.php, /wp-json/wp/v2/users during this module's proof run.
    if (apiShaped && trusted && res.status < 400 && /text\/html/i.test(contentType)) {
      stats.wrongContentType.push({ url: ep.url, method: ep.method, variant, contentType });
    } else if (/application\/json/i.test(contentType) && res.status < 300 && res.body) {
      try {
        JSON.parse(res.body);
      } catch {
        stats.malformedJson.push({ url: ep.url, method: ep.method, variant });
      }
    }
  }

  _report(result, stats, baseUrl, runnerSummary) {
    if (stats.brokenEndpoints.length > 0) {
      result.addCheck('api-health:broken-endpoints', false, {
        severity: 'error',
        message: `${stats.brokenEndpoints.length} broken endpoint(s) found across ${stats.endpointsChecked} checked`,
        details: stats.brokenEndpoints.slice(0, 30),
        suggestion: 'Fix the 5xx / missing route, or confirm the endpoint was intentionally removed',
      });
    } else {
      result.addCheck('api-health:broken-endpoints', true, {
        severity: 'info',
        message: `${stats.endpointsChecked} endpoint(s) checked — 0 broken`,
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

    result.addCheck('api-health:summary', true, {
      severity: 'info',
      message: `${stats.endpointsChecked} endpoint(s) checked at ${baseUrl}: ${stats.brokenEndpoints.length} broken, ${stats.slowEndpoints.length} slow, ${stats.wrongContentType.length} wrong-content-type, ${stats.malformedJson.length} malformed-json (${runnerSummary.totalRequests} requests sent${runnerSummary.aborted ? `, aborted: ${runnerSummary.abortReason}` : ''})`,
    });
  }
}

module.exports = ApiHealthModule;
// Exposed for unit tests
module.exports.inferBenignValue = inferBenignValue;
module.exports.groupByEndpoint = groupByEndpoint;
module.exports.looksLikeApiEndpoint = looksLikeApiEndpoint;
