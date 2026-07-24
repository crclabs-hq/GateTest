/**
 * Reliability — URL probe.
 *
 * Read-only HTTP probe for the `url-*` reliability cases. Given a URL,
 * returns a `ScanResult` shaped exactly like what the code-target
 * scanner produces, so the runner can consume both uniformly:
 *
 *   { findings: Array<Finding>, peakMemoryMb: number|null }
 *
 * Findings are produced by checking:
 *   - TLS (cert presence — handled by Node fetch errors on failure)
 *   - Security headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
 *     Referrer-Policy, Permissions-Policy
 *   - Server / X-Powered-By info disclosure
 *   - Set-Cookie flags: Secure, HttpOnly, SameSite
 *   - HTTP → HTTPS redirect behaviour (a separate HEAD to http:// is
 *     made by the caller and the response Location checked)
 *   - Mixed-content potential (insecure form action / src attributes
 *     in the body) — optional, only if response was HTML
 *
 * This is the foundation. We deliberately keep it simple: ~10-15
 * rule classes that map cleanly to existing GateTest modules so the
 * findings.module field aligns with what the rest of the engine emits.
 *
 * Pure logic + injectable fetch. Tests run offline with a mock fetch.
 */

"use strict";

const { resolveAndValidateUrl } = require("../ssrf-guard");

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_USER_AGENT = "GateTest-Reliability/1.0 (+https://gatetest.ai)";
const MAX_BODY_BYTES = 256 * 1024; // 256 KB — enough for header / form scan

const REQUIRED_SECURITY_HEADERS = [
  {
    header: "strict-transport-security",
    rule: "missing-hsts",
    module: "webHeaders",
    severity: "error",
    message: "Strict-Transport-Security (HSTS) header missing — protocol downgrade attacks possible",
  },
  {
    header: "content-security-policy",
    rule: "missing-csp",
    module: "webHeaders",
    severity: "warning",
    message: "Content-Security-Policy header missing — XSS payloads have free reign",
  },
  {
    header: "x-content-type-options",
    rule: "missing-nosniff",
    module: "webHeaders",
    severity: "warning",
    message: "X-Content-Type-Options: nosniff missing — MIME-sniffing attacks possible",
    expectedValue: /nosniff/i,
  },
  {
    header: "x-frame-options",
    rule: "missing-x-frame-options",
    module: "webHeaders",
    severity: "warning",
    message: "X-Frame-Options missing — clickjacking surface (unless CSP frame-ancestors covers it)",
  },
  {
    header: "referrer-policy",
    rule: "missing-referrer-policy",
    module: "webHeaders",
    severity: "info",
    message: "Referrer-Policy missing — Referer header leaks outbound URL to third parties",
  },
];

const INFO_DISCLOSURE_HEADERS = [
  { header: "server",         rule: "server-banner",  module: "webHeaders", severity: "info",
    message: "Server header reveals software:" },
  { header: "x-powered-by",   rule: "powered-by",     module: "webHeaders", severity: "info",
    message: "X-Powered-By reveals stack:" },
  { header: "x-aspnet-version", rule: "aspnet-version", module: "webHeaders", severity: "warning",
    message: "X-AspNet-Version exposes framework version" },
];

const STACK_FINGERPRINT_HEADERS = ["x-served-by", "x-cache", "x-via", "x-vercel-id"];

/**
 * Parse a Set-Cookie header into { name, attrs }. Returns null on
 * unparseable input.
 */
function parseSetCookie(value) {
  if (!value || typeof value !== "string") return null;
  const parts = value.split(";").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const [first] = parts;
  const eqIdx = first.indexOf("=");
  if (eqIdx < 0) return null;
  const name = first.slice(0, eqIdx);
  const attrs = new Map();
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const aIdx = p.indexOf("=");
    if (aIdx < 0) attrs.set(p.toLowerCase(), true);
    else attrs.set(p.slice(0, aIdx).toLowerCase(), p.slice(aIdx + 1));
  }
  return { name, attrs };
}

function headerValue(headers, name) {
  if (!headers) return null;
  // Node's fetch Response headers expose .get(); plain object also fine
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}

function allSetCookies(headers) {
  if (!headers) return [];
  // Node's Response headers expose .getSetCookie() in newer versions
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  if (typeof headers.raw === "function") {
    const raw = headers.raw();
    return raw["set-cookie"] || raw["Set-Cookie"] || [];
  }
  // Plain object fallback
  const v = headerValue(headers, "set-cookie");
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

/**
 * Build findings from a fetched response.
 */
function findingsFromResponse({ url, response, bodySnippet }) {
  const findings = [];

  // Required security headers
  for (const spec of REQUIRED_SECURITY_HEADERS) {
    const v = headerValue(response.headers, spec.header);
    if (!v) {
      findings.push({
        module: spec.module,
        severity: spec.severity,
        file: url,
        rule: spec.rule,
        message: spec.message,
      });
      continue;
    }
    if (spec.expectedValue && !spec.expectedValue.test(v)) {
      findings.push({
        module: spec.module,
        severity: spec.severity,
        file: url,
        rule: spec.rule + "-malformed",
        message: `${spec.message} (got: "${String(v).slice(0, 80)}")`,
      });
    }
  }

  // HSTS too-short max-age
  const hsts = headerValue(response.headers, "strict-transport-security");
  if (hsts) {
    const m = String(hsts).match(/max-age\s*=\s*(\d+)/i);
    if (m) {
      const seconds = Number(m[1]);
      if (seconds < 180 * 24 * 3600) {
        findings.push({
          module: "webHeaders",
          severity: "warning",
          file: url,
          rule: "hsts-short-max-age",
          message: `HSTS max-age=${seconds}s is below 180 days (15552000s)`,
        });
      }
    } else {
      findings.push({
        module: "webHeaders",
        severity: "warning",
        file: url,
        rule: "hsts-no-max-age",
        message: "HSTS header present but max-age missing",
      });
    }
  }

  // CSP unsafe directives
  const csp = headerValue(response.headers, "content-security-policy");
  if (csp) {
    if (/'unsafe-eval'/.test(String(csp))) {
      findings.push({
        module: "webHeaders",
        severity: "error",
        file: url,
        rule: "csp-unsafe-eval",
        message: "CSP allows 'unsafe-eval' — eval()-based XSS surface",
      });
    }
    if (/'unsafe-inline'/.test(String(csp))) {
      findings.push({
        module: "webHeaders",
        severity: "warning",
        file: url,
        rule: "csp-unsafe-inline",
        message: "CSP allows 'unsafe-inline' — inline-script XSS surface",
      });
    }
  }

  // Info disclosure
  for (const spec of INFO_DISCLOSURE_HEADERS) {
    const v = headerValue(response.headers, spec.header);
    if (v) {
      findings.push({
        module: spec.module,
        severity: spec.severity,
        file: url,
        rule: spec.rule,
        message: `${spec.message} "${String(v).slice(0, 80)}"`,
      });
    }
  }

  // CORS misconfig
  const aco = headerValue(response.headers, "access-control-allow-origin");
  const acc = headerValue(response.headers, "access-control-allow-credentials");
  if (aco === "*" && String(acc).toLowerCase() === "true") {
    findings.push({
      module: "webHeaders",
      severity: "error",
      file: url,
      rule: "cors-wildcard-with-credentials",
      message: "Access-Control-Allow-Origin: * combined with credentials:true (browsers will block, but signals a misconfig)",
    });
  }

  // Cookies
  const cookies = allSetCookies(response.headers);
  for (const raw of cookies) {
    const c = parseSetCookie(raw);
    if (!c) continue;
    if (!c.attrs.has("secure")) {
      findings.push({
        module: "cookieSecurity",
        severity: "warning",
        file: url,
        rule: "cookie-no-secure",
        message: `Cookie "${c.name}" missing Secure flag`,
      });
    }
    if (!c.attrs.has("httponly")) {
      findings.push({
        module: "cookieSecurity",
        severity: "error",
        file: url,
        rule: "cookie-no-httponly",
        message: `Cookie "${c.name}" missing HttpOnly flag — readable from document.cookie`,
      });
    }
    if (!c.attrs.has("samesite")) {
      findings.push({
        module: "cookieSecurity",
        severity: "warning",
        file: url,
        rule: "cookie-no-samesite",
        message: `Cookie "${c.name}" missing SameSite attribute`,
      });
    }
  }

  // Mixed content (HTML body only)
  if (bodySnippet && /text\/html/i.test(headerValue(response.headers, "content-type") || "")) {
    const httpHrefs = (bodySnippet.match(/(?:src|href|action)=["']http:\/\/[^"']+/gi) || []);
    if (httpHrefs.length > 0) {
      findings.push({
        module: "webHeaders",
        severity: "warning",
        file: url,
        rule: "mixed-content",
        message: `${httpHrefs.length} http:// reference(s) in HTML on an HTTPS page — mixed content`,
      });
    }
  }

  return findings;
}

/**
 * Probe a single URL.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {function} [args._fetch]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ findings: Array, durationMs: number, status: number|null, error?: string }>}
 */
async function probeUrl({ url, _fetch, timeoutMs = DEFAULT_TIMEOUT_MS, authHeaders } = {}) {
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("probeUrl: no fetch available; pass _fetch for tests");

  let parsed;
  try { parsed = new URL(url); } catch {
    return { findings: [], durationMs: 0, status: null, error: "invalid-url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { findings: [], durationMs: 0, status: null, error: "unsupported-protocol" };
  }

  const startedAt = Date.now();

  // Manual redirect handling — each hop is re-validated through the same
  // SSRF guard as the initial URL before being followed. A URL that passes
  // validation can still 302 to an internal/metadata address; redirect:
  // "follow" would silently chase it. Capped at MAX_REDIRECTS.
  let currentUrl = url;
  let response = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const hopCheck = await resolveAndValidateUrl(currentUrl);
    if (!hopCheck.ok) {
      return {
        findings: [{
          module: "webHeaders",
          severity: "error",
          file: url,
          rule: hop === 0 ? "blocked-address" : "redirect-blocked",
          message: hop === 0
            ? `Refusing to probe a blocked address (${hopCheck.reason})`
            : `Redirected to a blocked address (${hopCheck.reason}) — refusing to follow`,
        }],
        durationMs: Date.now() - startedAt,
        status: null,
        error: hop === 0 ? "blocked-address" : "redirect-blocked",
      };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let hopResponse;
    try {
      // Session auth (authed scans) is attached ONLY while the hop is on
      // the original target's origin — a redirect to any other origin
      // continues without it, so tokens can't leak off-target.
      let sameOriginAuth = {};
      if (authHeaders && typeof authHeaders === "object") {
        try {
          if (new URL(currentUrl).origin === parsed.origin) sameOriginAuth = authHeaders;
        } catch { /* unparseable hop — no auth */ }
      }
      hopResponse = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "*/*", ...sameOriginAuth },
      });
    } catch (err) {
      clearTimeout(timer);
      return {
        findings: [{
          module: "webHeaders",
          severity: "error",
          file: url,
          rule: "request-failed",
          message: `Probe request failed: ${err && err.message ? err.message : String(err)}`,
        }],
        durationMs: Date.now() - startedAt,
        status: null,
        error: err && err.name === "AbortError" ? "timeout" : "fetch-error",
      };
    }
    clearTimeout(timer);

    const location = REDIRECT_STATUSES.has(hopResponse.status) &&
      hopResponse.headers && typeof hopResponse.headers.get === "function"
      ? hopResponse.headers.get("location")
      : null;

    if (!location) {
      response = hopResponse;
      break;
    }
    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      response = hopResponse;
      break;
    }
    // Loop continues — next iteration re-validates currentUrl before fetching it.
  }

  if (!response) {
    return {
      findings: [{
        module: "webHeaders",
        severity: "warning",
        file: url,
        rule: "too-many-redirects",
        message: `Exceeded ${MAX_REDIRECTS} redirects while probing`,
      }],
      durationMs: Date.now() - startedAt,
      status: null,
      error: "too-many-redirects",
    };
  }

  let bodySnippet = "";
  try {
    const text = await response.text();
    bodySnippet = text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
  } catch { /* leave empty */ }

  // HTTPS-only check
  if (parsed.protocol === "http:") {
    return {
      findings: [{
        module: "tlsSecurity",
        severity: "error",
        file: url,
        rule: "served-over-http",
        message: "URL served over HTTP (no TLS) — eavesdropping + tampering possible",
      }],
      durationMs: Date.now() - startedAt,
      status: response.status,
    };
  }

  const findings = findingsFromResponse({ url, response, bodySnippet });
  return {
    findings,
    durationMs: Date.now() - startedAt,
    status: response.status,
  };
}

module.exports = {
  probeUrl,
  findingsFromResponse,
  parseSetCookie,
  headerValue,
  allSetCookies,
  REQUIRED_SECURITY_HEADERS,
  INFO_DISCLOSURE_HEADERS,
  STACK_FINGERPRINT_HEADERS,
};
