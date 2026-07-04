/**
 * Rollbar API client — third leg of the production-ears triad
 * (Sentry / Datadog / Rollbar). Craig-authorized 2026-07-04 (Boss Rule #7).
 *
 * Wraps the Rollbar REST API for the runtime correlator and the
 * production-errors aggregator. Same design contract as sentry-client.js:
 * pure JavaScript, dependency-injected fetch, normalised output shapes.
 *
 * API: https://docs.rollbar.com/reference
 *   GET /api/1/items/?status=active&environment=<env>&sort=occurrences
 *   GET /api/1/item/{id}/instances/   (first instance → stack frames)
 * Auth: project READ token in the X-Rollbar-Access-Token header.
 *
 * Fan-out note: items don't embed stack frames, so each of the top N
 * items costs one extra instances request — N is capped at `limit`
 * (default 20) to bound rate-limit exposure.
 */

'use strict';

const ROLLBAR_API_BASE = 'https://api.rollbar.com/api/1';

/**
 * Extract { file, line } from a Rollbar instance body. Prefers the LAST
 * in-app frame (Rollbar lists frames outermost-first, so the last frame
 * is where the error actually threw). Frames from node_modules / vendored
 * paths are skipped when an in-app frame exists.
 *
 * @param {object} instanceBody - instance.data.body from the API
 * @returns {{file: string, line: number|null} | null}
 */
function extractSourceLocation(instanceBody) {
  if (!instanceBody || typeof instanceBody !== 'object') return null;

  const trace =
    instanceBody.trace ||
    (Array.isArray(instanceBody.trace_chain) && instanceBody.trace_chain.length > 0
      ? instanceBody.trace_chain[0]
      : null);
  const frames = trace && Array.isArray(trace.frames) ? trace.frames : [];
  if (frames.length === 0) return null;

  const isVendor = (f) => /node_modules|site-packages|vendor\//.test(String(f.filename || ''));
  const inApp = frames.filter((f) => f && f.filename && !isVendor(f));
  const pick = (inApp.length > 0 ? inApp : frames.filter((f) => f && f.filename)).pop();
  if (!pick) return null;

  const file = String(pick.filename).replace(/^\/+/, '');
  const line = Number(pick.lineno || pick.line || 0) || null;
  return { file, line };
}

/**
 * Fetch the top active items (grouped errors) for a Rollbar project,
 * enriched with the source location of each item's most recent instance.
 *
 * @param {object} opts
 * @param {string} opts.accessToken            project READ token
 * @param {string} [opts.environment='production']
 * @param {number} [opts.limit=20]             max items (also caps instance fan-out)
 * @param {Function} [opts.fetchImpl=fetch]    inject for tests
 * @returns {Promise<Array<{
 *   id: string, message: string, file: string|null, line: number|null,
 *   count: number, lastSeen: string|null,
 *   sourceLocation: {file:string,line:number|null}|null,
 * }>>}
 */
async function fetchTopErrors(opts = {}) {
  const { accessToken, environment = 'production', limit = 20, fetchImpl = fetch } = opts;
  if (!accessToken) throw new Error('fetchTopErrors: accessToken is required');

  const headers = { 'X-Rollbar-Access-Token': accessToken, Accept: 'application/json' };
  const itemsUrl =
    `${ROLLBAR_API_BASE}/items/?status=active` +
    `&environment=${encodeURIComponent(environment)}&sort=occurrences`;

  const res = await fetchImpl(itemsUrl, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Rollbar API error (${res.status}): ${text.slice(0, 200)}`);
  }
  const payload = await res.json();
  const rawItems = payload?.result?.items;
  if (!Array.isArray(rawItems)) {
    throw new Error('Rollbar API returned no result.items array');
  }

  const top = rawItems.slice(0, Math.min(limit, 20));
  const out = [];
  for (const item of top) {
    if (!item || item.id == null) continue;

    // Best-effort per-item instance fetch — a single item's failure
    // (deleted item, race) degrades that item to no-location, never
    // fails the batch.
    let sourceLocation = null;
    try {
      const instRes = await fetchImpl(`${ROLLBAR_API_BASE}/item/${item.id}/instances/`, { headers });
      if (instRes.ok) {
        const instPayload = await instRes.json();
        const instances = instPayload?.result?.instances;
        if (Array.isArray(instances) && instances.length > 0) {
          sourceLocation = extractSourceLocation(instances[0]?.data?.body);
        }
      }
    } catch { /* item stays listed without a location */ }

    out.push({
      id: String(item.id),
      message: String(item.title || ''),
      file: sourceLocation ? sourceLocation.file : null,
      line: sourceLocation ? sourceLocation.line : null,
      count: Number(item.total_occurrences || item.occurrences || 0),
      lastSeen: item.last_occurrence_timestamp
        ? new Date(item.last_occurrence_timestamp * 1000).toISOString()
        : null,
      sourceLocation,
    });
  }
  return out;
}

module.exports = {
  ROLLBAR_API_BASE,
  fetchTopErrors,
  extractSourceLocation,
};
