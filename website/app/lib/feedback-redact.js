/**
 * Feedback ingest — validation and redaction for POST /api/feedback.
 *
 * Two customer loops post here (Craig 2026-09-16, "bad feedback must reach
 * us before it reaches a review site"):
 *   - the one-question prompt under every hosted scan result
 *     ("Was this scan useful?" → up / down + one optional line), and
 *   - the "Wrong?" link on a finding row (rating down, surface "finding",
 *     rule = the finding's module:rule — never code content).
 *
 * Everything the customer types is treated as hostile: the body is shape-
 * checked field by field, and free text is REDACTED before it is stored —
 * a pasted API key or e-mail address must never reach the database or the
 * public GitHub issue the escalation opens. The redaction set is a compact
 * copy of the vendor-shaped patterns in src/modules/secrets.js; that module
 * is a scanner class over a file tree and is not importable from a Next
 * route, so the shapes are restated here and tests/feedback-loop.test.js
 * holds them to the same control pair (a token and an e-mail go, prose
 * stays).
 *
 * Pure CommonJS, no I/O — the route and the tests both load it directly.
 */

'use strict';

const MAX_TEXT_LEN = 1000;
const MAX_RAW_TEXT_LEN = 4000;
const MAX_SURFACE_LEN = 40;
const MAX_TIER_LEN = 40;
const MAX_SCAN_ID_LEN = 100;
const MAX_PAGE_LEN = 300;
const MAX_RULE_LEN = 120;

const RATINGS = new Set(['up', 'down']);
const SURFACE_RE = /^[a-z][a-z0-9-]*$/;
// `module` | `module:rule` — the .gatetestignore grammar src/core/ignore-file.js parses.
const RULE_RE = /^[A-Za-z][\w-]*(:[A-Za-z][\w./-]*)?$/;

// Vendor-shaped credentials — recognisable from the value alone.
const VENDOR_TOKEN_RES = [
  /-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g,   // PEM blocks
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g,         // Stripe-style keys
  /\bsk-[A-Za-z0-9_-]{16,}/g,                           // sk-… API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                    // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,                  // GitHub fine-grained
  /\bAKIA[0-9A-Z]{16}\b/g,                              // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,                    // Slack tokens
  /\bgtmcp_[A-Za-z0-9]{20,}\b/g,                        // our own hosted-MCP key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,               // Authorization headers
];
// `password = …`, `token: …` — identifier-keyed, any 6+ char value.
const IDENTIFIER_KEYED_RE =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization)\b\s*[:=]\s*["']?[^\s"',;]{6,}/gi;
// user:pass@host inside a URL.
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
// A 40+ character run mixing letters and digits is key material, not prose.
const LONG_OPAQUE_RE = /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Strip anything that looks like a credential or an e-mail address, then
 * cap the result. Returns null for empty / non-string input.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function redactFeedbackText(raw) {
  if (typeof raw !== 'string') return null;
  // Drop control characters (keep tab / newline for the whitespace collapse
  // below). Unicode property escape, not `\u` ranges — the homoglyph rule
  // reads escaped control characters in a regex literal as the characters.
  let s = raw.slice(0, MAX_RAW_TEXT_LEN).replace(/(?![\t\n\r])\p{Cc}/gu, '');
  for (const re of VENDOR_TOKEN_RES) s = s.replace(re, '[redacted]');
  s = s.replace(URL_USERINFO_RE, '$1[redacted]@');
  s = s.replace(IDENTIFIER_KEYED_RE, '$1=[redacted]');
  s = s.replace(EMAIL_RE, '[redacted-email]');
  s = s.replace(LONG_OPAQUE_RE, '[redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, MAX_TEXT_LEN);
}

function optionalString(value, max, field, errors) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') { errors.push(`${field} must be a string`); return null; }
  const trimmed = value.trim();
  if (trimmed.length > max) { errors.push(`${field} too long (max ${max} chars)`); return null; }
  return trimmed || null;
}

/**
 * Shape-check a feedback body. Returns the normalised, REDACTED event or
 * the 400 the route should send. `page` is reduced to its path — a query
 * string can carry a Stripe session id and belongs to nobody's feedback row.
 *
 * @param {unknown} body
 * @returns {{ ok: true, event: object } | { ok: false, status: 400, error: string }}
 */
function validateFeedbackBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Invalid request body' };
  }
  const errors = [];
  const surface = typeof body.surface === 'string' ? body.surface.trim().toLowerCase() : '';
  if (!surface) errors.push('missing required field: surface');
  else if (surface.length > MAX_SURFACE_LEN || !SURFACE_RE.test(surface)) errors.push('invalid surface');

  const rating = typeof body.rating === 'string' ? body.rating.trim().toLowerCase() : '';
  if (!rating) errors.push('missing required field: rating');
  else if (!RATINGS.has(rating)) errors.push('invalid rating — expected "up" or "down"');

  const tier = optionalString(body.tier, MAX_TIER_LEN, 'tier', errors);
  const scanId = optionalString(body.scanId, MAX_SCAN_ID_LEN, 'scanId', errors);
  // A rule that does not parse as `module` / `module:rule` is dropped, not
  // rejected — the text still records the complaint; the escalation just
  // cannot key an issue on it.
  const ruleRaw = optionalString(body.rule, MAX_RULE_LEN, 'rule', errors);
  const rule = ruleRaw && RULE_RE.test(ruleRaw) ? ruleRaw : null;
  let page = optionalString(body.page, MAX_PAGE_LEN, 'page', errors);
  if (page) page = page.split(/[?#]/)[0] || null;
  if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') errors.push('text must be a string');

  if (errors.length) return { ok: false, status: 400, error: errors.join('; ') };
  return {
    ok: true,
    event: { surface, rating, tier, scanId, rule, page, text: redactFeedbackText(body.text) },
  };
}

module.exports = {
  redactFeedbackText,
  validateFeedbackBody,
  MAX_TEXT_LEN,
  RATINGS,
  RULE_RE,
};
