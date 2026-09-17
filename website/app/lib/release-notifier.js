'use strict';
/**
 * Release notifier — e-mails a short release-notes message to customers who
 * opted in when a new CLI version ships.
 *
 * THIS IS USER COMMUNICATION (Bible Boss Rule #9) and ships OFF by default:
 * `GATETEST_RELEASE_NOTIFY_ENABLED` must be the exact string '1' — unset,
 * 'true', 'yes', anything else is disabled. Craig flips it on the box and
 * the repo variable of the same name gates the publish workflow's trigger
 * (.github/workflows/publish.yml).
 *
 * Opt-in, never opt-out: `customers.release_emails_opt_in` defaults FALSE.
 * A customer turns it on from /account/notifications; the unsubscribe link
 * in every release e-mail flips it back off via a signed one-click token
 * (no login required — the same HMAC + timing-safe-compare pattern as
 * admin-auth.ts / self-scan-status.js / api/fixes/route.ts), because there
 * was no existing digest-unsubscribe mechanism to reuse (the weekly digest's
 * own unsubscribeUrl has pointed at this same not-yet-built page since it
 * was written).
 *
 * Idempotent per version: `release_notifications` records the version once
 * a send completes, so a re-run of the publish workflow (or a manual
 * re-trigger) never double-mails customers — notifyRelease() checks it
 * before doing any work.
 *
 * Three-state result (Doctrine #1) from notifyRelease():
 *   status: 'sent' | 'disabled' | 'already-sent' | 'no-recipients' | 'no-changelog'
 *
 * Conventions: same as continuous-subscription-store.js / usage-ledger.js —
 * the caller injects the tagged-template `sql`; schema changes are
 * `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`, never an edit to
 * a shipped CREATE. `transport` is injected the same way mail-transport's own
 * tests fake `request` — default is the real `deliver()` from ./mail-transport.
 */

const crypto = require('crypto');

const { deliver } = require('./mail-transport');
const { SITE_URL } = require('./site-url');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/** Ships OFF by default — anything but the exact string '1' is disabled. */
function releaseNotifyEnabled(env = process.env) {
  return env.GATETEST_RELEASE_NOTIFY_ENABLED === '1';
}

// ---------------------------------------------------------------------------
// Unsubscribe token — HMAC-signed, no login required
// ---------------------------------------------------------------------------

/** Same secret precedence as the other bearer/HMAC checks — no new env var. */
function unsubscribeSecret(env = process.env) {
  return env.SESSION_SECRET || env.GATETEST_INTERNAL_TOKEN || env.GATETEST_ADMIN_PASSWORD || '';
}

/** Sign one recipient's unsubscribe token: base64url(email).base64url(hmac). */
function signUnsubscribeToken(email, env = process.env) {
  const secret = unsubscribeSecret(env);
  if (!secret) return null;
  const normalised = String(email || '').trim().toLowerCase();
  if (!normalised) return null;
  const payload = Buffer.from(normalised, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Verify a token from an unsubscribe link. Returns the email, or null. */
function verifyUnsubscribeToken(token, env = process.env) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const secret = unsubscribeSecret(env);
  if (!secret) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let email;
  try {
    email = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  return EMAIL_RE.test(email) ? email : null;
}

/** The one-click unsubscribe link embedded in every release e-mail. */
function buildUnsubscribeUrl(email, env = process.env) {
  const token = signUnsubscribeToken(email, env);
  if (!token) return null;
  return `${SITE_URL}/account/notifications?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Email content — plain, no marketing tone
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the release-notes e-mail: what changed, how to update, unsubscribe.
 *
 * @param {{ version: string, changelogEntry?: { title?: string }|null, unsubscribeUrl?: string|null }} opts
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildReleaseEmail({ version, changelogEntry, unsubscribeUrl } = {}) {
  if (!version) throw new Error('buildReleaseEmail: version is required');
  const title = changelogEntry && typeof changelogEntry.title === 'string' ? changelogEntry.title : null;
  const installCmd = `npm i -g @gatetest/cli@${version}`;

  const subject = `GateTest ${version} is out`;

  const textLines = [
    `GateTest ${version} is out.`,
    '',
  ];
  if (title) textLines.push('What changed:', `  ${title}`, '');
  textLines.push(
    'How to update:',
    `  CLI:               ${installCmd}`,
    '  Editor extension:  updates automatically',
    '',
    '---',
    'GateTest · gatetest.io',
  );
  if (unsubscribeUrl) textLines.push(`Unsubscribe: ${unsubscribeUrl}`);
  const text = textLines.join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#09090b;padding:40px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 0 24px;">
    <span style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.5px;">Gate<span style="color:#2dd4bf;">Test</span></span>
  </td></tr>
  <tr><td style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:28px;">
    <h1 style="margin:0 0 12px;color:#f4f4f5;font-size:18px;font-weight:700;">GateTest ${escapeHtml(version)} is out</h1>
    ${title ? `<p style="margin:0 0 20px;color:#a1a1aa;font-size:14px;">${escapeHtml(title)}</p>` : ''}
    <p style="margin:0 0 8px;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">How to update</p>
    <div style="background:#09090b;border:1px solid #3f3f46;border-radius:8px;padding:14px 16px;margin-bottom:8px;">
      <code style="color:#e4e4e7;font-size:13px;font-family:'SF Mono',Consolas,monospace;">${escapeHtml(installCmd)}</code>
    </div>
    <p style="margin:0;color:#71717a;font-size:12px;">Editor extension: updates automatically.</p>
  </td></tr>
  <tr><td style="padding-top:20px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#475569;">GateTest &middot; gatetest.io</p>
    ${unsubscribeUrl ? `<p style="margin:8px 0 0;font-size:11px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#374151;text-decoration:underline;">Unsubscribe</a></p>` : ''}
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Schema — customers.release_emails_opt_in + release_notifications
// ---------------------------------------------------------------------------

/**
 * Idempotent, ledger-style migration (usage-ledger.js ensureSchema): the
 * CREATE mirrors schema.sql's committed `customers` table so a fresh test
 * database and a database that already has the table both end up the same;
 * the new column is added with ADD COLUMN IF NOT EXISTS, default FALSE
 * (opt-IN, never opt-out), never by editing the CREATE above it.
 */
async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    github_login TEXT,
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    total_scans INTEGER DEFAULT 0,
    total_spent_usd NUMERIC(10,2) DEFAULT 0
  )`;
  await sql`ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS release_emails_opt_in BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`CREATE TABLE IF NOT EXISTS release_notifications (
    version TEXT PRIMARY KEY,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recipient_count INTEGER NOT NULL DEFAULT 0
  )`;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Customers opted in with a usable e-mail. "Verified" here means
 * well-formed — this codebase has no separate e-mail-confirmation step
 * (schema.sql's `customers.email` is already NOT NULL UNIQUE), so a
 * malformed value is the only thing left to guard against before mailing it.
 *
 * @param {{ sql: Function }} args
 * @returns {Promise<string[]>}
 */
async function selectRecipients({ sql } = {}) {
  if (!sql || typeof sql !== 'function') throw new Error('selectRecipients: sql is required');
  await ensureSchema(sql);
  const rows = await sql`SELECT email FROM customers WHERE release_emails_opt_in = TRUE`;
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((r) => (r && typeof r.email === 'string' ? r.email.trim() : ''))
    .filter((email) => EMAIL_RE.test(email));
}

// ---------------------------------------------------------------------------
// Changelog lookup — one definition, imported (Doctrine §4/§7)
// ---------------------------------------------------------------------------

/**
 * The generated changelog entry that carried this version, or null.
 *
 * @param {string} version
 * @param {{ entries: Array }} [data] — test seam; defaults to the real
 *   generated file (website/app/data/changelog.json, one definition,
 *   Doctrine §4/§7 — never hand-typed).
 */
function findChangelogEntry(version, data) {
  let source = data;
  if (!source) {
    try {
      // eslint-disable-next-line global-require
      source = require('../data/changelog.json');
    } catch {
      return null;
    }
  }
  const entries = Array.isArray(source && source.entries) ? source.entries : [];
  return entries.find((e) => e && e.version === version) || null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Send the release-notes e-mail to every opted-in customer, once per
 * version. Never throws on a per-recipient delivery failure — those count
 * as skipped, not a thrown error, so one bad address can't stop the batch.
 *
 * @param {{ sql: Function, transport?: { deliver: Function }, version: string, now?: Date, changelog?: { entries: Array } }} args
 *   `changelog` is a test seam — omit it in production to read the real
 *   generated website/app/data/changelog.json.
 * @returns {Promise<{ status: 'sent'|'disabled'|'already-sent'|'no-recipients'|'no-changelog', sent: number, skipped: number, reason: string|null }>}
 */
async function notifyRelease({ sql, transport, version, now = new Date(), changelog } = {}) {
  if (!sql || typeof sql !== 'function') throw new Error('notifyRelease: sql is required');
  if (!version) throw new Error('notifyRelease: version is required');

  if (!releaseNotifyEnabled()) {
    return { status: 'disabled', sent: 0, skipped: 0, reason: 'GATETEST_RELEASE_NOTIFY_ENABLED is not "1"' };
  }

  const changelogEntry = findChangelogEntry(version, changelog);
  if (!changelogEntry) {
    return { status: 'no-changelog', sent: 0, skipped: 0, reason: `no changelog entry carries version ${version}` };
  }

  await ensureSchema(sql);

  const already = await sql`SELECT version FROM release_notifications WHERE version = ${version}`;
  if (Array.isArray(already) && already.length > 0) {
    return { status: 'already-sent', sent: 0, skipped: 0, reason: `release_notifications already has ${version}` };
  }

  const recipients = await selectRecipients({ sql });
  if (recipients.length === 0) {
    return { status: 'no-recipients', sent: 0, skipped: 0, reason: 'no customer is opted in with a usable email' };
  }

  const mailer = transport && typeof transport.deliver === 'function' ? transport : { deliver };

  let sent = 0;
  let skipped = 0;
  for (const email of recipients) {
    const unsubscribeUrl = buildUnsubscribeUrl(email);
    const { subject, text, html } = buildReleaseEmail({ version, changelogEntry, unsubscribeUrl });
    let result;
    try {
      result = await mailer.deliver({ to: email, subject, text, html });
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (result && result.ok) sent += 1;
    else skipped += 1;
  }

  await sql`INSERT INTO release_notifications (version, sent_at, recipient_count)
    VALUES (${version}, ${now.toISOString()}, ${sent})
    ON CONFLICT (version) DO NOTHING`;

  return { status: 'sent', sent, skipped, reason: null };
}

module.exports = {
  releaseNotifyEnabled,
  buildReleaseEmail,
  buildUnsubscribeUrl,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  ensureSchema,
  selectRecipients,
  findChangelogEntry,
  notifyRelease,
};
