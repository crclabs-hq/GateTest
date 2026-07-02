'use strict';
/**
 * Slack Notifier — posts GateTest scan results to Slack channels.
 *
 * Two integration modes:
 *
 *   1. Incoming Webhook (zero-setup):
 *      Set SLACK_WEBHOOK_URL env var → every completed scan posts a summary.
 *      Per-scan: pass `slack_webhook` in the API body to override the default.
 *
 *   2. Slash command (interactive):
 *      /gatetest scan github.com/owner/repo   → triggers a scan and replies
 *      /gatetest status                        → current platform health
 *      /gatetest help                          → command list
 *
 * Block Kit formatting:
 *   - Scan complete: header + score gauge + module table + top findings + CTA
 *   - Alert: red header + finding detail + file + suggested action
 *   - Digest: weekly summary with trend + recurring patterns + velocity
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL     — default incoming webhook (all notifications)
 *   SLACK_SIGNING_SECRET  — required for slash command verification
 *   SLACK_BOT_TOKEN       — required for bot-initiated messages (optional)
 */

const https = require('https');

// ── Block Kit builders ────────────────────────────────────────────────────────

function _header(text) {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

function _section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function _divider() {
  return { type: 'divider' };
}

function _context(elements) {
  return { type: 'context', elements: elements.map(e => ({ type: 'mrkdwn', text: e })) };
}

function _button(text, url, style = 'primary') {
  return {
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text }, url, style }],
  };
}

function _severityEmoji(level) {
  if (level === 'critical' || level === 'error') return ':red_circle:';
  if (level === 'warning') return ':large_yellow_circle:';
  return ':large_blue_circle:';
}

function _gradeEmoji(grade) {
  return { A: ':white_check_mark:', B: ':large_green_circle:', C: ':large_yellow_circle:',
           D: ':large_orange_circle:', F: ':red_circle:' }[grade] || ':white_circle:';
}

// ── Scan complete notification ────────────────────────────────────────────────

/**
 * Build Block Kit blocks for a completed scan result.
 *
 * @param {object} result
 * @param {string} result.repo_url        — or project label
 * @param {string} result.tier
 * @param {number} result.totalIssues
 * @param {number} result.duration
 * @param {Array}  result.modules
 * @param {object} [result.healthScore]   — { score, grade }
 * @param {string} [opts.scanUrl]         — link to full results
 * @param {string} [opts.mention]         — Slack user/group to @mention
 * @returns {object[]}  — Slack Block Kit blocks array
 */
function buildScanCompleteBlocks(result, opts = {}) {
  const label    = result.repo_url || result.project || 'Direct upload';
  const grade    = result.healthScore?.grade;
  const score    = result.healthScore?.score;
  const passed   = (result.modules || []).filter(m => m.status === 'passed').length;
  const failed   = (result.modules || []).filter(m => m.status !== 'passed').length;
  const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : '—';

  const status = result.totalIssues === 0 ? ':white_check_mark: Clean' : `:red_circle: ${result.totalIssues} issue(s) found`;

  const blocks = [];

  // Header
  const tierLabel = { quick: 'Quick Scan', full: 'Full Scan', smart: 'Smart Scan',
                      scan_fix: 'Scan + Fix', nuclear: 'Forensic Scan' }[result.tier] || result.tier || 'Scan';
  blocks.push(_header(`GateTest ${tierLabel} Complete`));

  // Status summary
  let summaryText = `*${label}*\n${status}`;
  if (grade && score != null) summaryText += `\n*Health:* ${_gradeEmoji(grade)} ${grade} (${score}/100)`;
  if (opts.mention) summaryText += `\n${opts.mention}`;
  blocks.push(_section(summaryText));

  // Module stats
  blocks.push(_section(
    `*Modules:* ${passed} passed · ${failed} failed · ${(result.modules || []).length} total   *Time:* ${duration}   *Tier:* ${result.tier || 'quick'}`
  ));

  // Top failed modules (up to 5)
  const failedMods = (result.modules || [])
    .filter(m => m.status !== 'passed')
    .slice(0, 5);

  if (failedMods.length > 0) {
    const lines = failedMods.map(m => {
      const count = (m.errors || 0) + (m.warnings || 0);
      return `:small_red_triangle: *${m.name}* — ${count} finding(s)`;
    });
    blocks.push(_divider());
    blocks.push(_section('*Top Issues*\n' + lines.join('\n')));
  }

  // CTA button
  if (opts.scanUrl) {
    blocks.push(_divider());
    blocks.push(_button('View Full Report', opts.scanUrl));
  }

  // Footer
  blocks.push(_context([`GateTest · gatetest.ai · ${new Date().toISOString().split('T')[0]}`]));

  return blocks;
}

// ── Alert notification (single critical finding) ──────────────────────────────

/**
 * Build blocks for a single high-severity alert.
 *
 * @param {object} finding  — { module, severity, message, file, line, fix }
 * @param {string} repoUrl
 * @param {string} [mention]
 * @returns {object[]}
 */
function buildAlertBlocks(finding, repoUrl, mention = '') {
  const emoji = _severityEmoji(finding.severity);
  return [
    _header(`${emoji} GateTest Alert — ${finding.module}`),
    _section(
      `*Repo:* ${repoUrl}\n` +
      `*Finding:* ${finding.message}\n` +
      (finding.file ? `*File:* \`${finding.file}${finding.line ? ':' + finding.line : ''}\`\n` : '') +
      (finding.fix  ? `*Suggested fix:* ${finding.fix}\n` : '') +
      (mention ? mention : '')
    ),
    _context([`Severity: ${finding.severity} · Module: ${finding.module} · ${new Date().toISOString()}`]),
  ];
}

// ── Developer digest ──────────────────────────────────────────────────────────

/**
 * Build blocks for the weekly developer digest.
 *
 * @param {object} digest
 * @param {string} digest.repoLabel
 * @param {string} digest.trend          — 'improving' | 'stable' | 'declining'
 * @param {number} digest.netDelta       — issues introduced − fixed
 * @param {number} digest.scansInWindow
 * @param {string} [digest.topModule]    — highest-firing module name
 * @param {Array}  [digest.patterns]     — recurring pattern descriptions
 * @returns {object[]}
 */
function buildDigestBlocks(digest) {
  const trendEmoji = { improving: ':chart_with_upwards_trend:', stable: ':chart_with_upwards_trend:',
                       declining: ':chart_with_downwards_trend:', 'insufficient-data': ':white_circle:' };
  const emoji = trendEmoji[digest.trend] || ':white_circle:';

  const blocks = [
    _header('GateTest Weekly Developer Digest'),
    _section(
      `${emoji} *${digest.repoLabel}*\n` +
      `Trend: *${digest.trend}*   Net delta this week: *${digest.netDelta > 0 ? '+' : ''}${digest.netDelta}* issues   Scans: *${digest.scansInWindow}*`
    ),
  ];

  if (digest.topModule) {
    blocks.push(_section(`*Top recurring module:* \`${digest.topModule}\` — fires most often in this codebase.`));
  }

  if (digest.patterns && digest.patterns.length > 0) {
    const patLines = digest.patterns.slice(0, 3).map(p => `:repeat: ${p.description}`);
    blocks.push(_divider());
    blocks.push(_section('*Recurring Patterns*\n' + patLines.join('\n')));
  }

  blocks.push(_context(['GateTest · gatetest.ai · Weekly digest — powered by persistent codebase memory']));
  return blocks;
}

// ── HTTP delivery ─────────────────────────────────────────────────────────────

/**
 * Post a payload to a Slack Incoming Webhook URL.
 *
 * @param {string}   webhookUrl
 * @param {object[]} blocks       — Block Kit blocks array
 * @param {string}   [text]       — fallback plain text (required for notifications)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function postToWebhook(webhookUrl, blocks, text = 'GateTest scan complete') {
  if (!webhookUrl) return { ok: false, error: 'No webhook URL configured' };

  const body = JSON.stringify({ text, blocks });

  return new Promise((resolve) => {
    const url = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + (url.search || ''),
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve(res.statusCode === 200 && body === 'ok' ? { ok: true } : { ok: false, error: body });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(10_000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// ── Main notification entry points ────────────────────────────────────────────

/**
 * Notify Slack that a scan completed.
 * Uses SLACK_WEBHOOK_URL env var, or the per-call webhookUrl override.
 *
 * @param {object} result      — scan result
 * @param {object} [opts]
 * @param {string} [opts.webhookUrl]  — override the env var
 * @param {string} [opts.scanUrl]     — deep-link to results page
 * @param {string} [opts.mention]     — @user or @here to mention
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function notifyScanComplete(result, opts = {}) {
  const webhookUrl = opts.webhookUrl || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return { ok: false, error: 'SLACK_WEBHOOK_URL not set' };

  const blocks  = buildScanCompleteBlocks(result, opts);
  const label   = result.repo_url || result.project || 'scan';
  const issues  = result.totalIssues || 0;
  const fallback = issues === 0
    ? `GateTest: ${label} is clean!`
    : `GateTest: ${label} has ${issues} issue(s)`;

  return postToWebhook(webhookUrl, blocks, fallback);
}

/**
 * Send a critical finding alert to Slack.
 *
 * @param {object} finding
 * @param {string} repoUrl
 * @param {object} [opts]
 * @param {string} [opts.webhookUrl]
 * @param {string} [opts.mention]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function notifyAlert(finding, repoUrl, opts = {}) {
  const webhookUrl = opts.webhookUrl || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return { ok: false, error: 'SLACK_WEBHOOK_URL not set' };

  const blocks = buildAlertBlocks(finding, repoUrl, opts.mention);
  return postToWebhook(webhookUrl, blocks, `GateTest Alert: ${finding.module} — ${finding.message}`);
}

/**
 * Post a developer digest to Slack.
 *
 * @param {object} digest
 * @param {object} [opts]
 * @param {string} [opts.webhookUrl]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function notifyDigest(digest, opts = {}) {
  const webhookUrl = opts.webhookUrl || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return { ok: false, error: 'SLACK_WEBHOOK_URL not set' };

  const blocks = buildDigestBlocks(digest);
  return postToWebhook(webhookUrl, blocks, `GateTest Weekly Digest — ${digest.repoLabel}`);
}

// ── Slash command helpers ─────────────────────────────────────────────────────

/**
 * Verify a Slack slash command request signature.
 * HMAC-SHA256 over the raw body using SLACK_SIGNING_SECRET.
 *
 * @param {string}  timestamp     — from X-Slack-Request-Timestamp
 * @param {string}  rawBody       — raw URL-encoded body
 * @param {string}  signature     — from X-Slack-Signature
 * @param {string}  signingSecret — SLACK_SIGNING_SECRET
 * @returns {boolean}
 */
function verifySlashSignature(timestamp, rawBody, signature, signingSecret) {
  if (!signingSecret) return false;
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  // Reject stale requests (> 5 minutes)
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
  const expected = `v0=${hmac}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Parse a slash command body (URL-encoded) into a structured object.
 *
 * @param {string} rawBody  — e.g. "command=%2Fgatetest&text=scan+github.com%2Fowner%2Frepo"
 * @returns {object}        — { command, text, response_url, user_id, user_name, channel_id, ... }
 */
function parseSlashBody(rawBody) {
  const params = new URLSearchParams(rawBody);
  const result = {};
  for (const [k, v] of params.entries()) result[k] = v;
  return result;
}

/**
 * Build an immediate Slack slash command response (ephemeral or in-channel).
 *
 * @param {string}   text
 * @param {boolean}  [inChannel] — true = visible to all; false = ephemeral (default)
 * @returns {object}
 */
function slashResponse(text, inChannel = false) {
  return {
    response_type: inChannel ? 'in_channel' : 'ephemeral',
    text,
  };
}

module.exports = {
  buildScanCompleteBlocks,
  buildAlertBlocks,
  buildDigestBlocks,
  postToWebhook,
  notifyScanComplete,
  notifyAlert,
  notifyDigest,
  verifySlashSignature,
  parseSlashBody,
  slashResponse,
};
