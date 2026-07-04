'use strict';
/**
 * Digest mailer — sends weekly developer digest emails via Resend REST API.
 *
 * Uses Node's built-in `https` module only — zero new npm dependencies.
 * Gracefully no-ops when RESEND_API_KEY is not set; callers should
 * treat { ok: false, error: 'RESEND_API_KEY not set' } as non-fatal.
 *
 * Environment variables:
 *   RESEND_API_KEY   — from resend.com (required for email delivery)
 *   RESEND_FROM      — override the From address (default: watchdog@gatetest.ai)
 */

const https = require('https');

const DEFAULT_FROM = 'GateTest <watchdog@gatetest.ai>';

// ── HTML email builder ────────────────────────────────────────────────────────

/**
 * Safe HTML escaping.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build a styled dark-theme HTML email for the weekly developer digest.
 *
 * @param {object} digest
 * @param {string} digest.repoLabel
 * @param {string} digest.trend        — 'improving' | 'stable' | 'declining' | 'insufficient-data'
 * @param {number} digest.netDelta
 * @param {number} digest.scansInWindow
 * @param {string} [digest.topModule]
 * @param {Array}  [digest.patterns]
 * @param {string} [digest.grade]      — A–F
 * @param {number} [digest.score]      — 0-100
 * @param {string} [digest.dashboardUrl]
 * @param {string} [digest.unsubscribeUrl]
 * @returns {string}
 */
function buildDigestEmailHtml(digest) {
  const {
    repoLabel = 'your repository',
    trend = 'stable',
    netDelta = 0,
    scansInWindow = 0,
    topModule,
    patterns = [],
    grade,
    score,
    dashboardUrl,
    unsubscribeUrl,
  } = digest;

  const trendColor   = trend === 'improving' ? '#22c55e' : trend === 'declining' ? '#ef4444' : '#94a3b8';
  const trendIcon    = trend === 'improving' ? '↑' : trend === 'declining' ? '↓' : '→';
  const deltaStr     = netDelta > 0 ? `+${netDelta}` : `${netDelta}`;
  const deltaColor   = netDelta <= 0 ? '#22c55e' : '#ef4444';
  const gradeColor   = { A: '#22c55e', B: '#0d9488', C: '#eab308', D: '#f97316', F: '#ef4444' }[grade] || '#94a3b8';

  const patternsHtml = patterns.slice(0, 3).map(p =>
    `<li style="margin:6px 0;color:#cbd5e1;">${escapeHtml(p.description || String(p))}</li>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GateTest Weekly Digest</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#09090b;padding:40px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;">

  <!-- Wordmark -->
  <tr><td style="padding:0 0 28px;">
    <span style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px;">Gate<span style="color:#2dd4bf;">Test</span></span>
    <span style="font-size:13px;color:#475569;margin-left:12px;">Weekly Developer Digest</span>
  </td></tr>

  <!-- Repo + stat cards -->
  <tr><td style="background:#18181b;border:1px solid #27272a;border-radius:16px;padding:28px;">
    <p style="margin:0 0 6px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.1em;font-weight:600;">Repository</p>
    <p style="margin:0 0 24px;font-size:18px;font-weight:700;color:#f1f5f9;">${escapeHtml(repoLabel)}</p>

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td style="width:32%;text-align:center;background:#09090b;border:1px solid #27272a;border-radius:12px;padding:18px 12px;">
        <p style="margin:0;font-size:22px;font-weight:800;color:${trendColor};">${trendIcon} ${escapeHtml(trend)}</p>
        <p style="margin:5px 0 0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">trend</p>
      </td>
      <td width="10">&nbsp;</td>
      <td style="width:32%;text-align:center;background:#09090b;border:1px solid #27272a;border-radius:12px;padding:18px 12px;">
        <p style="margin:0;font-size:22px;font-weight:800;color:${deltaColor};">${escapeHtml(deltaStr)}</p>
        <p style="margin:5px 0 0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">net issues</p>
      </td>
      <td width="10">&nbsp;</td>
      <td style="width:32%;text-align:center;background:#09090b;border:1px solid #27272a;border-radius:12px;padding:18px 12px;">
        <p style="margin:0;font-size:22px;font-weight:800;color:#f1f5f9;">${scansInWindow}</p>
        <p style="margin:5px 0 0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">scans</p>
      </td>
    </tr>
    </table>

    ${grade ? `
    <div style="margin-top:20px;padding:14px 18px;background:#09090b;border:1px solid ${gradeColor}40;border-radius:12px;">
      <span style="font-size:13px;color:#64748b;">Health grade: </span>
      <span style="font-size:20px;font-weight:800;color:${gradeColor};">${escapeHtml(grade)}</span>
      ${score != null ? `<span style="font-size:13px;color:#64748b;"> &nbsp;·&nbsp; ${score}/100</span>` : ''}
    </div>` : ''}
  </td></tr>

  <tr><td height="12"></td></tr>

  ${topModule ? `
  <tr><td style="background:#18181b;border:1px solid #27272a;border-radius:16px;padding:22px 28px;">
    <p style="margin:0 0 8px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.1em;font-weight:600;">Top recurring module</p>
    <p style="margin:0;font-size:14px;color:#e2e8f0;"><code style="background:#09090b;border:1px solid #27272a;padding:3px 8px;border-radius:6px;color:#2dd4bf;font-size:13px;">${escapeHtml(topModule)}</code> fires most often in this codebase.</p>
  </td></tr>
  <tr><td height="12"></td></tr>` : ''}

  ${patternsHtml ? `
  <tr><td style="background:#18181b;border:1px solid #27272a;border-radius:16px;padding:22px 28px;">
    <p style="margin:0 0 12px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.1em;font-weight:600;">Recurring patterns</p>
    <ul style="margin:0;padding:0 0 0 18px;color:#94a3b8;font-size:14px;line-height:1.6;">${patternsHtml}</ul>
  </td></tr>
  <tr><td height="12"></td></tr>` : ''}

  ${dashboardUrl ? `
  <tr><td style="text-align:center;padding:12px 0;">
    <a href="${escapeHtml(dashboardUrl)}"
       style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#059669,#0891b2);color:#fff;text-decoration:none;border-radius:12px;font-size:15px;font-weight:700;letter-spacing:-.2px;">
      View full history &rarr;
    </a>
  </td></tr>
  <tr><td height="16"></td></tr>` : ''}

  <!-- Footer -->
  <tr><td style="padding:20px 0 0;border-top:1px solid #1e293b;text-align:center;">
    <p style="margin:0;font-size:12px;color:#475569;">
      GateTest &nbsp;&middot;&nbsp;
      <a href="https://gatetest.ai" style="color:#475569;text-decoration:none;">gatetest.ai</a>
      &nbsp;&middot;&nbsp; Weekly developer digest
    </p>
    ${unsubscribeUrl ? `<p style="margin:10px 0 0;font-size:11px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#374151;text-decoration:underline;">Unsubscribe</a></p>` : ''}
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Plain-text fallback ───────────────────────────────────────────────────────

/**
 * Build a plain-text version of the digest email (required by email clients
 * that block HTML).
 */
function buildDigestEmailText(digest) {
  const {
    repoLabel = 'your repository',
    trend = 'stable',
    netDelta = 0,
    scansInWindow = 0,
    topModule,
    patterns = [],
    grade,
    score,
    dashboardUrl,
  } = digest;

  const deltaStr = netDelta > 0 ? `+${netDelta}` : `${netDelta}`;
  const lines = [
    'GateTest Weekly Developer Digest',
    '================================',
    '',
    `Repository:      ${repoLabel}`,
    `Trend:           ${trend}`,
    `Net issues:      ${deltaStr}`,
    `Scans this week: ${scansInWindow}`,
  ];

  if (grade) lines.push(`Health grade:    ${grade}${score != null ? ` (${score}/100)` : ''}`);

  if (topModule) {
    lines.push('', `Top recurring module: ${topModule}`);
    lines.push('This module fires most often in your codebase.');
  }

  if (patterns.length > 0) {
    lines.push('', 'Recurring patterns:');
    patterns.slice(0, 3).forEach(p => lines.push(`  · ${p.description || p}`));
  }

  if (dashboardUrl) {
    lines.push('', `View full history: ${dashboardUrl}`);
  }

  lines.push('', '---', 'GateTest · gatetest.ai · Weekly developer digest');
  return lines.join('\n');
}

// ── Email delivery ────────────────────────────────────────────────────────────

/**
 * Send a weekly digest email via Resend REST API.
 *
 * @param {object}  opts
 * @param {string}  opts.to              — recipient email address
 * @param {object}  opts.digest          — digest payload
 * @param {string} [opts.dashboardUrl]   — optional deep-link override
 * @param {string} [opts.unsubscribeUrl] — optional unsubscribe link
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
async function sendDigestEmail(opts) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };

  const { to, digest, dashboardUrl, unsubscribeUrl } = opts || {};
  if (!to)     return { ok: false, error: 'to is required' };
  if (!digest) return { ok: false, error: 'digest is required' };

  const enriched = { ...digest, dashboardUrl, unsubscribeUrl };
  const deltaStr = digest.netDelta > 0 ? `+${digest.netDelta}` : `${digest.netDelta}`;
  const subject  = `GateTest weekly: ${digest.repoLabel} is ${digest.trend} (${deltaStr} issues)`;
  const html     = buildDigestEmailHtml(enriched);
  const text     = buildDigestEmailText(enriched);
  const from     = process.env.RESEND_FROM || DEFAULT_FROM;

  const body = JSON.stringify({ from, to: [to], subject, html, text });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, id: parsed.id });
          } else {
            resolve({ ok: false, error: parsed.message || parsed.name || `HTTP ${res.statusCode}` });
          }
        } catch {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(12_000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

/**
 * Send a one-time API key delivery email to a new MCP subscriber.
 * Called from the Stripe webhook after checkout.session.completed for
 * the $29/mo MCP tier.
 *
 * @param {{ to: string, apiKey: string }} opts
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
async function sendApiKeyEmail(opts) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { ok: false, error: 'RESEND_API_KEY not set' };

  const { to, apiKey } = opts || {};
  if (!to)     return { ok: false, error: 'to is required' };
  if (!apiKey) return { ok: false, error: 'apiKey is required' };

  const from = process.env.RESEND_FROM || DEFAULT_FROM;
  const installCmd = `claude mcp add gatetest \\\n  -e GATETEST_API_KEY=${apiKey} \\\n  -- npx -y @gatetest/mcp-server`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your GateTest MCP API Key</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#09090b;padding:40px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="padding-bottom:24px;">
    <span style="color:#22c55e;font-size:20px;font-weight:700;letter-spacing:-0.5px;">GateTest</span>
  </td></tr>
  <tr><td style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;">
    <h1 style="color:#f4f4f5;font-size:22px;font-weight:700;margin:0 0 8px;">Your MCP API Key</h1>
    <p style="color:#a1a1aa;font-size:14px;margin:0 0 24px;">
      Here&rsquo;s your GateTest MCP subscription key. Add it to Claude Code (or Cursor / Windsurf)
      to unlock all 18 tools: full 120-module scans, AI fix, 👁&nbsp;screenshot,
      👂&nbsp;production errors, and 🤝&nbsp;verify&nbsp;fix.
    </p>

    <div style="background:#09090b;border:1px solid #3f3f46;border-radius:8px;padding:16px;margin-bottom:24px;">
      <p style="color:#71717a;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">Your API Key</p>
      <code style="color:#22c55e;font-size:13px;font-family:'SF Mono',Consolas,monospace;word-break:break-all;">${escapeHtml(apiKey)}</code>
    </div>

    <p style="color:#a1a1aa;font-size:13px;margin:0 0 12px;font-weight:600;">Install in Claude Code:</p>
    <div style="background:#09090b;border:1px solid #3f3f46;border-radius:8px;padding:16px;margin-bottom:24px;">
      <code style="color:#e4e4e7;font-size:12px;font-family:'SF Mono',Consolas,monospace;white-space:pre-wrap;">${escapeHtml(installCmd)}</code>
    </div>

    <p style="color:#71717a;font-size:12px;margin:0 0 16px;">
      Keep this key secret — it grants full access to your MCP subscription.
      To regenerate, cancel and resubscribe or contact
      <a href="mailto:hello@gatetest.ai" style="color:#22c55e;">hello@gatetest.ai</a>.
    </p>

    <a href="https://gatetest.ai/mcp" style="display:inline-block;background:#22c55e;color:#09090b;font-weight:700;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:8px;">
      View Tool Reference →
    </a>
  </td></tr>
  <tr><td style="padding-top:24px;text-align:center;">
    <p style="color:#52525b;font-size:11px;margin:0;">
      GateTest · <a href="https://gatetest.ai" style="color:#52525b;">gatetest.ai</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    'Your GateTest MCP API Key',
    '',
    `Key: ${apiKey}`,
    '',
    'Install in Claude Code:',
    installCmd,
    '',
    'This unlocks all 18 MCP tools: full 120-module scans, AI fix,',
    'screenshot (Eyes), production errors (Ears), and verify_fix (Hands).',
    '',
    'Keep this key secret. To regenerate contact hello@gatetest.ai.',
    '',
    '-- GateTest | gatetest.ai',
  ].join('\n');

  const body = JSON.stringify({ from, to: [to], subject: 'Your GateTest MCP API Key', html, text });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        Authorization:    `Bearer ${resendKey}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, id: parsed.id });
          } else {
            resolve({ ok: false, error: parsed.message || parsed.name || `HTTP ${res.statusCode}` });
          }
        } catch {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(12_000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  buildDigestEmailHtml,
  buildDigestEmailText,
  sendDigestEmail,
  sendApiKeyEmail,
  escapeHtml,
};
