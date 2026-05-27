/**
 * Authorization Gate — hard refusal for live-active probes.
 *
 * Active pen-testing (sending SQL injection / XSS / IDOR / path-traversal
 * payloads to a customer's live URL) is legally dangerous without explicit
 * authorization. Unauthorized active probing of a system you don't own is a
 * crime in most jurisdictions (CFAA in the US, Computer Misuse Act in the
 * UK, similar laws elsewhere) regardless of the operator's intent.
 *
 * This module is the single chokepoint every live-probe module MUST call
 * before it transmits a single payload. Default state: refusal. Probes are
 * never armed by accident.
 *
 * Three-key consent model (ALL must be true):
 *
 *   1. Process-level switch: env var GATETEST_PENTEST_ARMED === '1'
 *      Operator-side opt-in. Set by the worker process at boot when running
 *      the pen-test tier. Absent means the engine is in vulnerability-scan
 *      mode and live probes are physically inert.
 *
 *   2. Per-target authorization record: passed in `consent` argument with:
 *      - `url` (string, must match target)
 *      - `acknowledgedAt` (ISO timestamp, must be within 24h)
 *      - `customerToken` (a hash of the customer's session + URL, signed by
 *        our service; prevents replay across customers)
 *      - `scopeLimits` (object describing what's allowed: payload classes,
 *        rate limits, time windows)
 *
 *   3. Domain-ownership verification: DNS TXT record at
 *      _gatetest-auth.<domain> must contain the same `customerToken`. This
 *      proves the customer actually controls the domain, not just clicked
 *      a checkbox claiming they do. Without this layer, a customer can
 *      paste any URL and we'll happily attack it.
 *
 * If ANY of the three fails, the gate refuses and the probe module must
 * abort. The gate logs every authorization attempt (granted or refused)
 * with timestamp, IP, customer, target, and reason.
 *
 * THIS MODULE IS NOT A POLICY DECISION. It is a SAFETY DEVICE. Probe
 * modules must not bypass it for any reason. The legal protection it
 * provides only works if every payload-emitting code path goes through
 * authorize() and aborts on refusal.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────

const ARMED_ENV = 'GATETEST_PENTEST_ARMED';
const MAX_CONSENT_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DNS_TXT_PREFIX = '_gatetest-auth';

const AUDIT_LOG_DIR_DEFAULT = path.join(
  process.env.HOME || process.cwd(),
  '.gatetest',
  'audit',
);

// ─── Errors ───────────────────────────────────────────────────────────────

class AuthorizationRefusedError extends Error {
  constructor(reason, details = {}) {
    super(`Pen-test authorization refused: ${reason}`);
    this.name = 'AuthorizationRefusedError';
    this.reason = reason;
    this.details = details;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isArmed() {
  return process.env[ARMED_ENV] === '1';
}

function normalizeUrl(input) {
  try {
    const u = new URL(input);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isFreshConsent(acknowledgedAt) {
  if (!acknowledgedAt) return false;
  const t = Date.parse(acknowledgedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= MAX_CONSENT_AGE_MS;
}

// ─── DNS TXT verification ─────────────────────────────────────────────────

/**
 * Resolve DNS TXT records for `_gatetest-auth.<domain>`. Resolver is
 * injectable so tests can stub without network. Default impl uses Node's
 * dns/promises.
 */
async function resolveAuthTxt(hostname, resolver) {
  if (!hostname) return [];
  const fqdn = `${DNS_TXT_PREFIX}.${hostname}`;
  try {
    if (resolver) return await resolver(fqdn);
    const dns = require('dns/promises');
    const records = await dns.resolveTxt(fqdn);
    return records.flat();
  } catch {
    return [];
  }
}

async function verifyDomainOwnership(url, expectedToken, resolver) {
  const host = hostnameOf(url);
  if (!host || !expectedToken) return false;
  const txts = await resolveAuthTxt(host, resolver);
  return txts.some((t) => typeof t === 'string' && t.trim() === expectedToken);
}

// ─── Audit log ────────────────────────────────────────────────────────────

function appendAudit(entry, dir = AUDIT_LOG_DIR_DEFAULT) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `pentest-audit-${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch { // error-ok — audit log is best-effort; never blocks the safety decision
    // Audit failure must not block the safety decision. If the log can't
    // be written we still return the gate result.
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Throws AuthorizationRefusedError if the live-probe must not run. Returns
 * an authorization receipt on success.
 *
 * @param {Object} args
 * @param {string} args.url               Target URL (must match consent.url)
 * @param {Object} args.consent           Customer consent record
 * @param {string} args.consent.url       URL the customer authorized
 * @param {string} args.consent.acknowledgedAt   ISO timestamp
 * @param {string} args.consent.customerToken    Signed token, also in DNS
 * @param {Object} [args.consent.scopeLimits]    Probe-class allowlist
 * @param {string} [args.actorId]         Customer / session identifier
 * @param {string} [args.actorIp]         Request source IP
 * @param {string} [args.moduleName]      The probe module asking
 * @param {Function} [args.dnsResolver]   Override DNS resolver (tests)
 * @param {string} [args.auditDir]        Override audit-log dir (tests)
 * @returns {Promise<{granted: true, receipt: object}>}
 */
async function authorize(args) {
  const {
    url, consent, actorId, actorIp, moduleName,
    dnsResolver, auditDir,
  } = args || {};

  const baseAudit = {
    ts: new Date().toISOString(),
    actorId: actorId || null,
    actorIp: actorIp || null,
    moduleName: moduleName || null,
    url: url || null,
  };

  // ── Layer 1: process armed? ──
  if (!isArmed()) {
    appendAudit({ ...baseAudit, decision: 'refused', reason: 'process-not-armed' }, auditDir);
    throw new AuthorizationRefusedError('process-not-armed', {
      hint: `Set ${ARMED_ENV}=1 in the worker environment to enable live probes.`,
    });
  }

  // ── Layer 2: per-target consent ──
  if (!consent || typeof consent !== 'object') {
    appendAudit({ ...baseAudit, decision: 'refused', reason: 'no-consent' }, auditDir);
    throw new AuthorizationRefusedError('no-consent', { hint: 'consent object missing' });
  }

  const normUrl = normalizeUrl(url);
  const normConsentUrl = normalizeUrl(consent.url);
  if (!normUrl || !normConsentUrl || normUrl !== normConsentUrl) {
    appendAudit({ ...baseAudit, decision: 'refused', reason: 'url-mismatch' }, auditDir);
    throw new AuthorizationRefusedError('url-mismatch', {
      expected: normConsentUrl, got: normUrl,
    });
  }

  if (!isFreshConsent(consent.acknowledgedAt)) {
    appendAudit({ ...baseAudit, decision: 'refused', reason: 'consent-stale' }, auditDir);
    throw new AuthorizationRefusedError('consent-stale', {
      acknowledgedAt: consent.acknowledgedAt,
      maxAgeMs: MAX_CONSENT_AGE_MS,
    });
  }

  if (!consent.customerToken || typeof consent.customerToken !== 'string'
      || consent.customerToken.length < 32) {
    appendAudit({ ...baseAudit, decision: 'refused', reason: 'token-missing-or-weak' }, auditDir);
    throw new AuthorizationRefusedError('token-missing-or-weak', {
      hint: 'customerToken must be >= 32 chars',
    });
  }

  // ── Layer 3: DNS ownership proof ──
  const ownsDomain = await verifyDomainOwnership(url, consent.customerToken, dnsResolver);
  if (!ownsDomain) {
    appendAudit({
      ...baseAudit,
      decision: 'refused',
      reason: 'dns-txt-not-found',
      expectedRecord: `${DNS_TXT_PREFIX}.${hostnameOf(url)}`,
    }, auditDir);
    throw new AuthorizationRefusedError('dns-txt-not-found', {
      expectedRecord: `${DNS_TXT_PREFIX}.${hostnameOf(url)}`,
      expectedValue: consent.customerToken,
      hint: 'Customer must add a DNS TXT record proving domain ownership.',
    });
  }

  // ── All layers passed — issue receipt. ──
  const receipt = {
    grantedAt: new Date().toISOString(),
    url: normUrl,
    actorId: actorId || null,
    moduleName: moduleName || null,
    scopeLimits: consent.scopeLimits || null,
    receiptId: crypto.randomBytes(16).toString('hex'),
  };

  appendAudit({ ...baseAudit, decision: 'granted', receiptId: receipt.receiptId }, auditDir);
  return { granted: true, receipt };
}

/**
 * Generate the customer token (signed). Customer adds this to DNS TXT
 * and we verify it at probe time.
 */
function generateCustomerToken(customerId, url, secret) {
  const payload = `${customerId}|${normalizeUrl(url)}|${Date.now()}`;
  return crypto
    .createHmac('sha256', secret || 'dev-secret-change-me')
    .update(payload)
    .digest('hex');
}

module.exports = {
  authorize,
  generateCustomerToken,
  verifyDomainOwnership,
  AuthorizationRefusedError,
  ARMED_ENV,
  DNS_TXT_PREFIX,
  MAX_CONSENT_AGE_MS,
  // exposed for tests
  isArmed,
  normalizeUrl,
  isFreshConsent,
};
