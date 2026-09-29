'use strict';
/**
 * Is this environment variable REAL, or did someone paste the instructions?
 *
 * ── The incident this comes from (2026-08-06) ───────────────────────────────
 * `GATETEST_PRIVATE_KEY` on the production box held, literally:
 *
 *   "-----BEGIN RSA PRIVATE KEY-----\n...(all the base64 lines)...\n-----END RSA PRIVATE KEY-----"
 *
 * 112 characters. A real RSA key is ~1700. Someone pasted the *example* from
 * the setup docs instead of the downloaded .pem.
 *
 * Every check we had said **PRESENT**. `/api/status` checks `length > 0`. The
 * preflight checks `/api/status`. So the GitHub App auth path was dead for an
 * unknown number of weeks while every dashboard reported green, and it was
 * only found by minting a JWT by hand and watching OpenSSL reject the key.
 *
 * "Set" is not "valid". A variable that is present but fake is strictly worse
 * than one that is missing, because every guard we own is looking for absence.
 *
 * ── Why this is a product feature, not just an ops fix ──────────────────────
 * This is the single most common way a developer's own deployment is broken —
 * copied .env.example, half-filled. It costs hours because nothing reports it.
 * The detector lives in `src/core/` so the engine, the CLI, `/api/status`, and
 * the Marketplace preflight can all use one definition, and so a future module
 * can scan a customer's deployment for the same class.
 */

/**
 * Literal filler strings. Compared case-insensitively against the whole value
 * (trimmed), so a legitimate secret that merely CONTAINS "changeme" is safe.
 */
const EXACT_PLACEHOLDERS = new Set([
  'changeme', 'change_me', 'change-me', 'placeholder', 'your_key_here',
  'your-key-here', 'yourkeyhere', 'todo', 'tbd', 'xxx', 'xxxx', 'test',
  'example', 'none', 'null', 'undefined', 'n/a', 'na', 'foo', 'bar',
  'secret', 'password', 'string', 'value', '...', '<your key>', 'unset',
]);

/**
 * Filler SHAPES inside a committed literal — the secrets rule's list
 * (src/modules/secrets.js reads it; one definition with the env detector
 * above, issue #842 DR-6). Substring-matched, case-insensitive, against the
 * value a credential pattern captured: `changeme` / `change-me-in-production`
 * / `replace_me` / `your-api-key-here` / `placeholder` / a standalone
 * `example` or `dummy` / `TODO` / `xxx` / `<paste-key>` / an elision `...`.
 * `example` and `dummy` are bounded so a high-entropy value that merely
 * CONTAINS the substring — AWS's canonical `AKIAIOSFODNN7EXAMPLE` — is never
 * swallowed; a secrets module must fail toward detection, never silence.
 * Three dots or more, never one or two: a JWT is `header.payload.signature`.
 */
const PLACEHOLDER_VALUE_RE = /(?:change[_-]?me|placeholder|your[_-]?(?:\w+[_-])?(?:secret|key|password|token)|replace[_-]?me|(?<![a-z0-9])(?:example|dummy)(?![a-z0-9])|default[_-]?(?:secret|key|password|token)|xxx+|insert[_-]?here|todo|<[a-z0-9_. -]{2,30}>|\.{3,}|…)/i;

/**
 * Substrings that only ever appear in documentation examples. Kept narrow on
 * purpose: a false positive here tells someone their WORKING credential is
 * broken, which is its own outage.
 */
const DOC_MARKERS = [
  '...(', ')...', 'all the base64', 'your-api-key', 'your_api_key',
  'sk-ant-xxxx', 'sk_test_xxxx', 'paste-your', 'paste_your', 'replace-this',
  'replace_this', '<paste', 'insert-your', 'insert_your', 'example.com/your',
];

/**
 * Minimum plausible length for known credential shapes. A value shorter than
 * this cannot be the real thing regardless of what it looks like.
 */
const MIN_LENGTHS = [
  { match: /PRIVATE[_-]?KEY$/i, min: 500, what: 'a PEM private key (~1700 chars)' },
  { match: /^ANTHROPIC_API_KEY$/i, min: 40, what: 'an Anthropic key (sk-ant-…)' },
  { match: /^STRIPE_(SECRET|WEBHOOK)/i, min: 20, what: 'a Stripe key' },
  { match: /^RESEND_API_KEY$/i, min: 20, what: 'a Resend key (re_…)' },
  { match: /SECRET$/i, min: 12, what: 'a signing secret' },
  { match: /TOKEN$/i, min: 12, what: 'an API token' },
];

/** Prefix contracts — if the shape is known, a wrong prefix is a wrong value. */
const PREFIXES = [
  { name: 'ANTHROPIC_API_KEY', prefix: 'sk-ant-' },
  { name: 'STRIPE_SECRET_KEY', prefix: 'sk_' },
  { name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', prefix: 'pk_' },
  { name: 'STRIPE_WEBHOOK_SECRET', prefix: 'whsec_' },
  { name: 'RESEND_API_KEY', prefix: 're_' },
];

/**
 * Inspect one variable.
 *
 * @param {string} name  env var name
 * @param {string|undefined} value
 * @returns {{ok: boolean, reason: string|null}} `ok:false` means present-but-fake.
 *          A MISSING value returns ok:true — absence is a different check's job,
 *          and reporting it twice would double-count every unset optional var.
 */
function inspectEnvValue(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: true, reason: null };
  }
  // Strip wrapping quotes the same way the consuming code does, so a correctly
  // quoted value is not judged on its quotes.
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  const lower = v.toLowerCase();

  if (EXACT_PLACEHOLDERS.has(lower)) {
    return { ok: false, reason: `is the literal placeholder "${v}"` };
  }
  for (const marker of DOC_MARKERS) {
    if (lower.includes(marker)) {
      return { ok: false, reason: `contains documentation filler ("${marker}") — the example was pasted instead of the real value` };
    }
  }
  // An ellipsis inside a credential is never legitimate; it is how docs elide.
  if (/\.\.\./.test(v) && v.length < 4000) {
    return { ok: false, reason: 'contains "..." — an elided example, not a real credential' };
  }
  for (const rule of MIN_LENGTHS) {
    if (rule.match.test(name) && v.length < rule.min) {
      return { ok: false, reason: `is ${v.length} chars — too short for ${rule.what}` };
    }
  }
  for (const rule of PREFIXES) {
    if (name === rule.name && !v.startsWith(rule.prefix)) {
      return { ok: false, reason: `does not start with "${rule.prefix}"` };
    }
  }
  // PEM-shaped values must actually contain a body between the markers.
  if (v.includes('BEGIN') && v.includes('END')) {
    const body = v.replace(/-----[A-Z ]+-----/g, '').replace(/\\n/g, '').replace(/\s/g, '');
    if (body.length < 200) {
      return { ok: false, reason: `has PEM markers but only ${body.length} chars of key body — the key itself is missing` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * Inspect many variables at once.
 *
 * @param {string[]} names
 * @param {Record<string, string|undefined>} env
 * @returns {Array<{name: string, reason: string}>} only the fake ones
 */
function findPlaceholders(names, env) {
  const bad = [];
  for (const name of names) {
    const { ok, reason } = inspectEnvValue(name, env[name]);
    if (!ok) bad.push({ name, reason });
  }
  return bad;
}

module.exports = { inspectEnvValue, findPlaceholders, EXACT_PLACEHOLDERS, DOC_MARKERS, PLACEHOLDER_VALUE_RE };
