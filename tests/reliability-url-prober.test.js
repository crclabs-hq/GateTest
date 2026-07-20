"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  probeUrl,
  findingsFromResponse,
  parseSetCookie,
  headerValue,
  allSetCookies,
  REQUIRED_SECURITY_HEADERS,
} = require("../website/app/lib/reliability/url-prober.js");

const { createScannerAdapter } = require("../website/app/lib/reliability/scanner-adapter.js");

// ---------------------------------------------------------------------------
// Helpers — mock fetch & response
// ---------------------------------------------------------------------------

function mockResponse({ status = 200, headers = {}, body = "" } = {}) {
  const cookieKey = Object.keys(headers).find((k) => k.toLowerCase() === "set-cookie");
  const cookies = cookieKey
    ? (Array.isArray(headers[cookieKey]) ? headers[cookieKey] : [headers[cookieKey]])
    : [];
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "set-cookie") lower[k.toLowerCase()] = String(v);
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (n) => lower[n.toLowerCase()] || null,
      getSetCookie: () => cookies,
    },
    text: async () => body,
  };
}

function mockFetchOne(res) {
  return async () => res;
}

// ---------------------------------------------------------------------------
// parseSetCookie
// ---------------------------------------------------------------------------

test("parseSetCookie: extracts name + attrs", () => {
  const c = parseSetCookie("session=abc; Path=/; Secure; HttpOnly; SameSite=Strict");
  assert.equal(c.name, "session");
  assert.equal(c.attrs.has("secure"), true);
  assert.equal(c.attrs.has("httponly"), true);
  assert.equal(c.attrs.get("samesite"), "Strict");
});

test("parseSetCookie: lone Secure → flag present", () => {
  const c = parseSetCookie("x=1; Secure");
  assert.equal(c.attrs.has("secure"), true);
});

test("parseSetCookie: malformed returns null", () => {
  assert.equal(parseSetCookie(null), null);
  assert.equal(parseSetCookie(""), null);
  assert.equal(parseSetCookie("invalid no equals"), null);
});

// ---------------------------------------------------------------------------
// headerValue
// ---------------------------------------------------------------------------

test("headerValue: works on plain object + Headers-like", () => {
  assert.equal(headerValue({ "Content-Type": "text/html" }, "content-type"), "text/html");
  assert.equal(headerValue({ get: (n) => (n === "x" ? "y" : null) }, "x"), "y");
});

// ---------------------------------------------------------------------------
// findingsFromResponse
// ---------------------------------------------------------------------------

test("findingsFromResponse: missing HSTS → error", () => {
  const r = mockResponse({ headers: {} });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "missing-hsts"));
});

test("findingsFromResponse: HSTS present but short max-age → warning", () => {
  const r = mockResponse({ headers: { "strict-transport-security": "max-age=3600" } });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "hsts-short-max-age"));
});

test("findingsFromResponse: HSTS long max-age → no short warning", () => {
  const r = mockResponse({ headers: { "strict-transport-security": "max-age=31536000; includeSubDomains" } });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(!findings.some((f) => f.rule === "hsts-short-max-age"));
  assert.ok(!findings.some((f) => f.rule === "missing-hsts"));
});

test("findingsFromResponse: missing CSP → warning", () => {
  const r = mockResponse({ headers: {} });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "missing-csp"));
});

test("findingsFromResponse: CSP with unsafe-eval → error", () => {
  const r = mockResponse({ headers: { "content-security-policy": "default-src 'self'; script-src 'unsafe-eval'" } });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "csp-unsafe-eval"));
});

test("findingsFromResponse: CSP with unsafe-inline → warning", () => {
  const r = mockResponse({ headers: { "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'" } });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "csp-unsafe-inline"));
});

test("findingsFromResponse: nosniff missing → warning", () => {
  const r = mockResponse({ headers: {} });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "missing-nosniff"));
});

test("findingsFromResponse: x-frame-options missing → warning", () => {
  const r = mockResponse({ headers: {} });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "missing-x-frame-options"));
});

test("findingsFromResponse: server banner → info disclosure finding", () => {
  const r = mockResponse({ headers: { server: "nginx/1.18.0 (Ubuntu)" } });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "server-banner"));
});

test("findingsFromResponse: CORS wildcard + credentials → error", () => {
  const r = mockResponse({
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
    },
  });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "cors-wildcard-with-credentials"));
});

test("findingsFromResponse: cookie missing HttpOnly → error", () => {
  const r = mockResponse({
    headers: { "set-cookie": "session=abc; Path=/; Secure; SameSite=Strict" },
  });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "cookie-no-httponly"));
});

test("findingsFromResponse: cookie missing Secure → warning", () => {
  const r = mockResponse({
    headers: { "set-cookie": "session=abc; Path=/; HttpOnly; SameSite=Strict" },
  });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(findings.some((f) => f.rule === "cookie-no-secure"));
});

test("findingsFromResponse: cookie with full flags → no cookie findings", () => {
  const r = mockResponse({
    headers: { "set-cookie": "session=abc; Path=/; Secure; HttpOnly; SameSite=Strict" },
  });
  const findings = findingsFromResponse({ url: "https://x.com", response: r, bodySnippet: "" });
  assert.ok(!findings.some((f) => f.module === "cookieSecurity"));
});

test("findingsFromResponse: mixed content detected in HTML", () => {
  const r = mockResponse({ headers: { "content-type": "text/html" } });
  const findings = findingsFromResponse({
    url: "https://x.com",
    response: r,
    bodySnippet: '<img src="http://cdn.example.com/x.png"><script src="http://a.b/c.js"></script>',
  });
  const mc = findings.find((f) => f.rule === "mixed-content");
  assert.ok(mc);
  assert.match(mc.message, /2 http:\/\/ reference/);
});

test("findingsFromResponse: mixed content NOT flagged on non-HTML", () => {
  const r = mockResponse({ headers: { "content-type": "application/json" } });
  const findings = findingsFromResponse({
    url: "https://x.com",
    response: r,
    bodySnippet: '{"foo": "http://insecure.example/"}',
  });
  assert.ok(!findings.some((f) => f.rule === "mixed-content"));
});

// ---------------------------------------------------------------------------
// probeUrl (top-level)
// ---------------------------------------------------------------------------

test("probeUrl: invalid URL returns invalid-url error", async () => {
  const r = await probeUrl({ url: "not a url", _fetch: mockFetchOne(mockResponse()) });
  assert.equal(r.error, "invalid-url");
});

test("probeUrl: file:// protocol rejected", async () => {
  const r = await probeUrl({ url: "file:///etc/passwd", _fetch: mockFetchOne(mockResponse()) });
  assert.equal(r.error, "unsupported-protocol");
});

test("probeUrl: http:// URL flags served-over-http error", async () => {
  const r = await probeUrl({ url: "http://example.com", _fetch: mockFetchOne(mockResponse()) });
  assert.ok(r.findings.some((f) => f.rule === "served-over-http"));
});

test("probeUrl: fetch error surfaces as request-failed finding", async () => {
  const r = await probeUrl({
    url: "https://x.com",
    _fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(r.error, "fetch-error");
  assert.ok(r.findings.some((f) => f.rule === "request-failed"));
});

test("probeUrl: produces findings + status + duration", async () => {
  const r = await probeUrl({
    url: "https://example.com",
    _fetch: mockFetchOne(mockResponse({
      status: 200,
      headers: {
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
      },
    })),
  });
  assert.equal(r.status, 200);
  assert.ok(typeof r.durationMs === "number");
  // A site with all required headers shouldn't trigger missing-* errors
  assert.ok(!r.findings.some((f) => f.rule === "missing-hsts"));
});

// ---------------------------------------------------------------------------
// probeUrl — SSRF-safe redirect handling (2026-07-20)
//
// probeUrl previously used `redirect: "follow"`, so a URL that passed the
// initial hostname check could 302 to an internal/metadata address and the
// fetch would silently chase it. Now every hop uses `redirect: "manual"`
// and is re-validated through the same SSRF guard as the initial URL.
// These tests use real public hostnames (example.com/example.org) since
// probeUrl's internal SSRF check always resolves real DNS (no injection
// point) — confirmed to work in this sandbox by the existing tests above.
// ---------------------------------------------------------------------------

function mockFetchSequence(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
}

function mockRedirectResponse(location, status = 302) {
  return {
    status,
    ok: false,
    headers: {
      get: (n) => (n.toLowerCase() === "location" ? location : null),
      getSetCookie: () => [],
    },
    text: async () => "",
  };
}

test("probeUrl: follows a single redirect to a safe absolute URL", async () => {
  const r = await probeUrl({
    url: "https://example.com",
    _fetch: mockFetchSequence([
      mockRedirectResponse("https://example.org/"),
      mockResponse({ status: 200, headers: {} }),
    ]),
  });
  assert.equal(r.status, 200);
  assert.equal(r.error, undefined);
});

test("probeUrl: follows a relative redirect Location by resolving against the current URL", async () => {
  const r = await probeUrl({
    url: "https://example.com/start",
    _fetch: mockFetchSequence([
      mockRedirectResponse("/moved"),
      mockResponse({ status: 200, headers: {} }),
    ]),
  });
  assert.equal(r.status, 200);
});

test("probeUrl: refuses to follow a redirect to a blocked/private address", async () => {
  const r = await probeUrl({
    url: "https://example.com",
    _fetch: mockFetchSequence([
      mockRedirectResponse("http://127.0.0.1/secret"),
      mockResponse({ status: 200, headers: {} }), // must never be reached
    ]),
  });
  assert.equal(r.error, "redirect-blocked");
  assert.ok(r.findings.some((f) => f.rule === "redirect-blocked"));
});

test("probeUrl: refuses to follow a redirect to the cloud metadata IP", async () => {
  const r = await probeUrl({
    url: "https://example.com",
    _fetch: mockFetchSequence([
      mockRedirectResponse("http://169.254.169.254/latest/meta-data/"),
    ]),
  });
  assert.equal(r.error, "redirect-blocked");
});

test("probeUrl: caps redirect chains at MAX_REDIRECTS", async () => {
  // Every hop redirects to the next — never resolves, must give up rather
  // than loop forever.
  const responses = [];
  for (let i = 0; i < 10; i++) {
    responses.push(mockRedirectResponse(`https://example.com/hop-${i}`));
  }
  const r = await probeUrl({
    url: "https://example.com",
    _fetch: mockFetchSequence(responses),
  });
  assert.equal(r.error, "too-many-redirects");
});

test("probeUrl: a redirect response with no Location header is treated as the final response", async () => {
  const r = await probeUrl({
    url: "https://example.com",
    _fetch: mockFetchOne({
      status: 302,
      ok: false,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => "",
    }),
  });
  assert.equal(r.status, 302);
  assert.equal(r.error, undefined);
});

// ---------------------------------------------------------------------------
// scanner adapter
// ---------------------------------------------------------------------------

test("scannerAdapter: routes URL targets to probeUrl", async () => {
  const adapter = createScannerAdapter({
    _fetch: mockFetchOne(mockResponse({ headers: {} })),
  });
  const result = await adapter.scan({
    manifest: { name: "x" },
    target: { type: "url", url: "https://example.com" },
  });
  assert.ok(Array.isArray(result.findings));
  assert.ok(result.findings.length > 0);
});

test("scannerAdapter: code target with no code scanner → graceful empty result", async () => {
  const adapter = createScannerAdapter({});
  const result = await adapter.scan({
    manifest: { name: "x" },
    target: { type: "code", codeRoot: "/x" },
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.error, "no-code-scanner-adapter");
});

test("scannerAdapter: unsupported target.type throws", async () => {
  const adapter = createScannerAdapter({});
  await assert.rejects(
    adapter.scan({ manifest: { name: "x" }, target: { type: "podcast" } }),
    TypeError
  );
});

test("REQUIRED_SECURITY_HEADERS: covers the canonical set", () => {
  const rules = REQUIRED_SECURITY_HEADERS.map((s) => s.rule);
  assert.ok(rules.includes("missing-hsts"));
  assert.ok(rules.includes("missing-csp"));
  assert.ok(rules.includes("missing-nosniff"));
});
