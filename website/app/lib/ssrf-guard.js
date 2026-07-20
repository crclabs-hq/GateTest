"use strict";

/**
 * SSRF guard for user-supplied URLs — shared by /api/web/scan and
 * /api/wp/scan (both accept ANY URL from an unauthenticated caller and
 * fetch it server-side, no signup required).
 *
 * Previously each route had its own copy of a hostname-string blocklist
 * (`localhost` / `127.` / `10.` / etc.) with two gaps: no DNS resolution
 * (a domain the attacker controls can resolve to 127.0.0.1 or the cloud
 * metadata IP — classic DNS-rebinding SSRF) and no re-validation on
 * redirect (a URL that passes the initial check can 302 to an internal
 * address and the fetch would follow it). This module closes both, and
 * exists once so the two routes can't drift the way their old duplicated
 * `parseUrl` already had.
 *
 * Two layers:
 *   1. Hostname-shape validation — reuses pentest/dns-verify.js's
 *      validateDomainForProbing(), which already covers more ground than
 *      a plain private-range blocklist (0.x, metadata hostnames by name,
 *      reserved TLDs).
 *   2. DNS resolution + resolved-IP validation — the actual rebinding
 *      close. Every address a hostname resolves to is checked, not just
 *      the literal string.
 */

const dns = require("dns").promises;
const { validateDomainForProbing } = require("./pentest/dns-verify");

const PRIVATE_V4_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
];

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== "string") return true;
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true; // loopback
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 — check the embedded IPv4 address too.
      const v4 = lower.slice(7);
      return v4 === "169.254.169.254" || PRIVATE_V4_RANGES.some((re) => re.test(v4));
    }
    return false;
  }
  if (ip === "169.254.169.254") return true; // cloud metadata
  return PRIVATE_V4_RANGES.some((re) => re.test(ip));
}

/**
 * Parse and fully validate a user-supplied URL. Coerces a bare host (no
 * scheme) to https://, matching the scan routes' existing behaviour.
 *
 * @param {string} input
 * @param {object} [opts]
 * @param {{ lookup: Function }} [opts._dnsAdapter] — test injection point;
 *   defaults to the real `dns.promises`. Must expose an async
 *   `lookup(hostname, { all: true })` returning `[{ address, family }]`.
 * @returns {Promise<{ ok: true, url: URL } | { ok: false, reason: string }>}
 */
async function resolveAndValidateUrl(input, opts = {}) {
  if (!input || typeof input !== "string") return { ok: false, reason: "empty" };
  let raw = input.trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "unsupported-protocol" };
  }

  const shapeCheck = validateDomainForProbing(url.hostname);
  if (!shapeCheck.ok) {
    return { ok: false, reason: shapeCheck.reason };
  }

  const resolver = opts._dnsAdapter && typeof opts._dnsAdapter.lookup === "function"
    ? opts._dnsAdapter
    : dns;

  let addresses;
  try {
    addresses = await resolver.lookup(url.hostname, { all: true });
  } catch {
    return { ok: false, reason: "dns-resolution-failed" };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, reason: "dns-resolution-empty" };
  }
  for (const addr of addresses) {
    const address = typeof addr === "string" ? addr : addr && addr.address;
    if (isPrivateOrReservedIp(address)) {
      return { ok: false, reason: "resolves-to-private-address" };
    }
  }

  return { ok: true, url };
}

module.exports = { resolveAndValidateUrl, isPrivateOrReservedIp };
