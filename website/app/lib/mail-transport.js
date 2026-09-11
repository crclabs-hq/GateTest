'use strict';
/**
 * One way out for every e-mail the site sends (digests, MCP API keys,
 * billing-portal links). Two providers:
 *
 *   resend  — POST https://api.resend.com/emails        (Bearer RESEND_API_KEY)
 *   vapron  — POST {VAPRON_BASE_URL}/api/platform/email/send
 *                                                     (Bearer VAPRON_API_KEY)
 *
 * The Vapron platform is where gatetest.io is being consolidated
 * (CLAUDE.md → DEPLOYMENT DOCTRINE, Craig 2026-09-11). The switch is
 * deliberate, not automatic: MAIL_PROVIDER=vapron selects it; with the
 * variable unset the live path stays Resend while it is configured, so a
 * half-finished cutover can never leave the $29/mo MCP key e-mail dark.
 * Prove a provider with `node scripts/ops/mail-test.js <to>` on the box
 * BEFORE flipping the flag.
 *
 * Secrets are read from process.env at call time and never appear in any
 * return value, error string or log line.
 */
const https = require('https');
const { URL } = require('url');

const DEFAULT_FROM = 'GateTest <watchdog@gatetest.io>';
const TIMEOUT_MS = 12_000;

/** Which provider a send will use: 'resend' | 'vapron' | 'none'. */
function mailProvider(env = process.env) {
  const explicit = String(env.MAIL_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'vapron' || explicit === 'resend') return explicit;
  if (env.RESEND_API_KEY) return 'resend';
  if (env.VAPRON_API_KEY && env.VAPRON_BASE_URL) return 'vapron';
  return 'none';
}

/** True when the selected provider has what it needs to send. */
function mailConfigured(env = process.env) {
  const p = mailProvider(env);
  if (p === 'resend') return Boolean(env.RESEND_API_KEY);
  if (p === 'vapron') return Boolean(env.VAPRON_API_KEY && env.VAPRON_BASE_URL);
  return false;
}

/** The From header. RESEND_FROM is honoured for both providers (legacy name). */
function fromAddress(env = process.env) {
  return (env.MAIL_FROM || env.RESEND_FROM || DEFAULT_FROM).trim();
}

/** Minimal JSON POST over https. Resolves { status, body } — never rejects. */
function httpsJson(target, bearer, payload, timeoutMs = TIMEOUT_MS) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (e) => resolve({ status: 0, body: JSON.stringify({ message: e.message }) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: JSON.stringify({ message: 'timeout' }) }); });
    req.write(body);
    req.end();
  });
}

/**
 * Send one message through the configured provider.
 * @param {{ to: string|string[], subject: string, html?: string, text?: string, from?: string }} msg
 * @param {{ env?: object, request?: typeof httpsJson }} [deps] — test seams
 * @returns {Promise<{ ok: boolean, id?: string, error?: string, provider: string }>}
 */
async function deliver(msg, deps = {}) {
  const env = deps.env || process.env;
  const request = deps.request || httpsJson;
  const provider = mailProvider(env);
  if (!mailConfigured(env)) return { ok: false, error: `mail provider not configured (${provider})`, provider };
  if (!msg || !msg.to) return { ok: false, error: 'to is required', provider };
  if (!msg.subject) return { ok: false, error: 'subject is required', provider };

  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  const from = msg.from || fromAddress(env);
  let target; let bearer; let payload;

  if (provider === 'vapron') {
    let base;
    try { base = new URL(env.VAPRON_BASE_URL); } catch { return { ok: false, error: 'VAPRON_BASE_URL is not a valid URL', provider }; }
    target = { hostname: base.hostname, port: base.port || 443, path: '/api/platform/email/send' };
    bearer = env.VAPRON_API_KEY;
    // The Vapron API documents a single-recipient string; pass an array only
    // when there genuinely is more than one.
    payload = { from, to: recipients.length === 1 ? recipients[0] : recipients, subject: msg.subject, html: msg.html, text: msg.text };
  } else {
    target = { hostname: 'api.resend.com', path: '/emails' };
    bearer = env.RESEND_API_KEY;
    payload = { from, to: recipients, subject: msg.subject, html: msg.html, text: msg.text };
  }

  const res = await request(target, bearer, payload, TIMEOUT_MS);
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch { parsed = {}; }
  if (res.status >= 200 && res.status < 300) {
    const id = parsed.id || parsed.messageId || (parsed.data && parsed.data.id) || undefined;
    return { ok: true, id, provider };
  }
  const error = parsed.message || parsed.error || parsed.name || `HTTP ${res.status}`;
  return { ok: false, error: String(error), provider };
}

module.exports = { DEFAULT_FROM, mailProvider, mailConfigured, fromAddress, deliver, httpsJson };
