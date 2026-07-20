'use strict';
/**
 * Telemetry Uploader — best-effort central upload of the local scan-findings
 * buffer. Client machines (CLI / MCP) accumulate anonymized records in
 * ~/.gatetest/telemetry/scan-findings.jsonl (see scan-telemetry.js); this
 * module ships them to the central ingest endpoint when it's reachable.
 *
 * CONTRACTS:
 *   - NEVER throws, NEVER blocks a scan. Fire-and-forget; a dead/slow endpoint
 *     is silently tolerated and the records stay buffered for next time.
 *   - Only uploads what the recorder already anonymized — no re-reading of any
 *     other source. Uploaded lines are dropped from the buffer on 2xx.
 *   - Bounded buffer: the local file is trimmed to MAX_BUFFER_LINES so an
 *     offline machine can never grow it without limit.
 *   - Zero new npm dependencies — global fetch (Node 18+) only.
 *
 * The website records server-side directly into the central store, so it does
 * NOT use this uploader — this is purely the client → central path.
 */

const fs   = require('fs');
const path = require('path');

const { SCAN_FINDINGS_FILE, telemetryEnabled } = require('./scan-telemetry');

const DEFAULT_URL = process.env.GATETEST_TELEMETRY_URL || 'https://gatetest.ai/api/telemetry/scan';
const DEFAULT_BATCH = 200;
const MAX_BUFFER_LINES = 5000;
const UPLOAD_TIMEOUT_MS = 4000;

function _readLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
}

function _writeLines(filePath, lines) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.length ? lines.join('\n') + '\n' : '', 'utf-8');
  } catch { /* best-effort */ } // error-ok
}

/**
 * Flush buffered scan-findings to the central endpoint. Uploads up to
 * batchSize records; on a 2xx response those records are removed from the
 * local buffer. NEVER throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.url]         — ingest endpoint (default gatetest.ai)
 * @param {string} [opts.filePath]    — buffer path (default scan-findings.jsonl)
 * @param {number} [opts.batchSize]   — max records per flush
 * @param {string} [opts.projectRoot] — consent check
 * @param {function} [opts._fetch]    — injectable fetch (tests)
 * @returns {Promise<{uploaded: number, remaining: number, reason?: string}>}
 */
async function flush(opts = {}) {
  const {
    url = DEFAULT_URL,
    filePath = SCAN_FINDINGS_FILE,
    batchSize = DEFAULT_BATCH,
    projectRoot,
    _fetch = (typeof fetch === 'function' ? fetch : null),
  } = opts;

  try {
    if (!telemetryEnabled(projectRoot)) return { uploaded: 0, remaining: 0, reason: 'opted-out' };
    if (!_fetch) return { uploaded: 0, remaining: 0, reason: 'no-fetch' };

    let lines = _readLines(filePath);
    if (lines.length === 0) return { uploaded: 0, remaining: 0, reason: 'empty' };

    // Bound the buffer first — drop the oldest beyond the cap so a long
    // offline stretch can't grow the file unboundedly.
    if (lines.length > MAX_BUFFER_LINES) {
      lines = lines.slice(-MAX_BUFFER_LINES);
      _writeLines(filePath, lines);
    }

    const batch = lines.slice(0, batchSize);
    const records = [];
    for (const l of batch) {
      try { records.push(JSON.parse(l)); } catch { /* skip malformed line */ } // error-ok
    }
    if (records.length === 0) {
      // All parsed lines were malformed — drop them so they don't wedge the buffer.
      _writeLines(filePath, lines.slice(batch.length));
      return { uploaded: 0, remaining: lines.length - batch.length, reason: 'malformed' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    let ok = false;
    try {
      const res = await _fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records }),
        signal: controller.signal,
      });
      ok = res && res.status >= 200 && res.status < 300;
    } catch {
      ok = false; // network error / timeout — keep the buffer for next time
    } finally {
      clearTimeout(timer);
    }

    if (!ok) return { uploaded: 0, remaining: lines.length, reason: 'endpoint-unreachable' };

    // Drop the uploaded batch, keep the rest.
    const remaining = lines.slice(batch.length);
    _writeLines(filePath, remaining);
    return { uploaded: records.length, remaining: remaining.length };
  } catch {
    return { uploaded: 0, remaining: 0, reason: 'exception' };
  }
}

/**
 * Fire-and-forget flush — never awaited by a scan. Swallows everything.
 * Call this at the end of a CLI scan; if the endpoint is down (e.g. the site
 * is stale pre-Vapron) it's a silent no-op and records stay buffered.
 */
function flushInBackground(opts = {}) {
  try {
    Promise.resolve(flush(opts)).catch(() => {}); // error-ok: telemetry is fire-and-forget; must never break a scan
  } catch { /* never throw */ } // error-ok
}

module.exports = { flush, flushInBackground, DEFAULT_URL, MAX_BUFFER_LINES };
