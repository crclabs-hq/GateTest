'use strict';

/**
 * The /web scan permalink — ONE definition of the `?s=` share encoding
 * (issue #648 item 3, moved here for issue #768 item 2).
 *
 * There is no server-side report store for /web scans: the shareable link IS
 * the result JSON, base64url-encoded into `?s=` and restored client-side by
 * UrlScanFlow (48 h expiry). Before this file the encoding lived only inside
 * UrlScanFlow.tsx, so an API caller of POST /api/web/scan got no link at all.
 * Now the browser flow and the JSON route both import it, so the link a
 * customer copies from the page and the `reportUrl` the API returns are the
 * same thing, and no second store exists.
 */

const SHARE_EXPIRY_MS = 48 * 60 * 60 * 1000;

/**
 * Longest permalink handed out. The site is served by Node, whose default
 * request-line/header ceiling is 16 KB; a link longer than this would be
 * refused by our own server when opened.
 */
const MAX_REPORT_URL_LENGTH = 12_000;

function encodeShareData(result) {
  const payload = { ...result, sharedAt: Date.now() };
  return btoa(encodeURIComponent(JSON.stringify(payload))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeShareData(encoded) {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(base64));
    const data = JSON.parse(json);
    if (!data.sharedAt || Date.now() - data.sharedAt > SHARE_EXPIRY_MS) return null;
    return data;
  } catch {
    return null; // error-ok — a malformed or tampered `?s=` value is not a scan result
  }
}

/**
 * Absolute, shareable URL for a scan result. When the full result would make
 * the link too long (a paid full report), the fix guidance and per-check
 * names are dropped from the encoded copy so the grade, coverage and finding
 * titles still restore — never a link our own server refuses.
 *
 * @param {Record<string, unknown>} result   the response body, before `reportUrl` is added
 * @param {string} origin                    absolute site origin, e.g. https://gatetest.io
 * @returns {string}
 */
function buildReportUrl(result, origin) {
  const base = `${origin}/web?s=`;
  const full = base + encodeShareData(result);
  if (full.length <= MAX_REPORT_URL_LENGTH) return full;
  const findings = Array.isArray(result.findings)
    ? result.findings.map((f) => ({ ...f, body: '' }))
    : result.findings;
  const rest = { ...result };
  delete rest.moduleChecks;
  return base + encodeShareData({ ...rest, findings });
}

module.exports = { SHARE_EXPIRY_MS, MAX_REPORT_URL_LENGTH, encodeShareData, decodeShareData, buildReportUrl };
