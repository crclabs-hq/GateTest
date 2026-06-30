'use strict';
/**
 * Weekly digest orchestrator.
 *
 * Queries active Continuous subscribers, computes each repo's 7-day quality
 * trend from scan history, and dispatches the digest via Slack and/or email.
 *
 * Callers:
 *   - /api/digest route          — admin on-demand trigger
 *   - .github/workflows/digest-weekly.yml — Monday 08:00 UTC cron
 *
 * Data flow:
 *   continuous_subscriptions (active, with email/slack)
 *     → getRepoHistory() for each repo
 *     → buildTrendFromHistory()
 *     → notifyDigest()    (Slack)
 *     → sendDigestEmail() (email)
 */

const { getRepoHistory }  = require('./scan-history-store');
const { notifyDigest }    = require('./slack-notifier');
const { sendDigestEmail } = require('./digest-mailer');

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://gatetest.ai';

// ── Trend computation ─────────────────────────────────────────────────────────

/**
 * Derive a quality trend from raw scan_history rows.
 *
 * @param {Array}  rows        — from getRepoHistory(), newest first
 * @param {number} windowDays  — look-back window (default 7)
 * @returns {{ trend, netDelta, scansInWindow, topModule, lastGrade, lastScore }}
 */
function buildTrendFromHistory(rows, windowDays = 7) {
  const empty = { trend: 'insufficient-data', netDelta: 0, scansInWindow: 0, topModule: null, lastGrade: null, lastScore: null };
  if (!rows || rows.length === 0) return empty;

  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  const recent = rows.filter(r => new Date(r.scanned_at) >= cutoff);
  if (recent.length === 0) return empty;

  // Oldest → newest in the window so we can compute a delta
  const newest = recent[0];
  const oldest = recent[recent.length - 1];
  const netDelta = newest.total_issues - oldest.total_issues;
  const trend = netDelta < -3 ? 'improving' : netDelta > 3 ? 'declining' : 'stable';

  // Top module: whichever fired the most issues in the latest scan
  let topModule = null;
  let topCount  = 0;
  for (const m of (newest.module_summary || [])) {
    if ((m.issues || 0) > topCount) { topCount = m.issues; topModule = m.name; }
  }

  // Approximate grade from latest issue count
  const penalty     = Math.min(50, newest.total_issues * 2);
  const lastScore   = Math.max(0, 100 - penalty);
  const lastGrade   = lastScore >= 90 ? 'A' : lastScore >= 75 ? 'B' : lastScore >= 60 ? 'C' : lastScore >= 40 ? 'D' : 'F';

  return { trend, netDelta, scansInWindow: recent.length, topModule, lastGrade, lastScore };
}

// ── Single-repo dispatch ──────────────────────────────────────────────────────

/**
 * Compile and send the digest for one repo.
 *
 * @param {object}  opts
 * @param {string}  opts.repoUrl
 * @param {string} [opts.customerEmail]
 * @param {string} [opts.slackWebhookUrl]
 * @param {Function} opts.sql
 * @returns {Promise<{ slack: object, email: object, trend: object }>}
 */
async function sendRepoDigest(opts) {
  const { repoUrl, customerEmail, slackWebhookUrl, sql } = opts;
  if (!repoUrl) throw new Error('sendRepoDigest: repoUrl is required');
  if (typeof sql !== 'function') throw new Error('sendRepoDigest: sql is required');

  const repoLabel = repoUrl
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '');

  // Fetch scan history (30-row window covers 7-day trend even at high velocity)
  let rows = [];
  try {
    rows = await getRepoHistory(sql, repoUrl, 30);
  } catch {
    // DB unavailable — proceed with empty trend rather than crashing
  }

  const trend = buildTrendFromHistory(rows);
  const digest = {
    repoLabel,
    trend:          trend.trend,
    netDelta:       trend.netDelta,
    scansInWindow:  trend.scansInWindow,
    topModule:      trend.topModule,
    grade:          trend.lastGrade,
    score:          trend.lastScore,
    patterns:       [],
    dashboardUrl:   `${BASE_URL}/dashboard`,
    unsubscribeUrl: `${BASE_URL}/account/notifications`,
  };

  const results = {
    slack: { ok: false, error: 'not configured' },
    email: { ok: false, error: 'not configured' },
    trend,
  };

  // Slack — per-repo webhook takes priority; fall back to global env var
  const slackUrl = slackWebhookUrl || process.env.SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      results.slack = await notifyDigest(digest, { webhookUrl: slackUrl });
    } catch (e) {
      results.slack = { ok: false, error: e.message };
    }
  }

  // Email — only when customer email is known and Resend key is set
  if (customerEmail) {
    try {
      results.email = await sendDigestEmail({
        to:             customerEmail,
        digest,
        dashboardUrl:   digest.dashboardUrl,
        unsubscribeUrl: digest.unsubscribeUrl,
      });
    } catch (e) {
      results.email = { ok: false, error: e.message };
    }
  }

  return results;
}

// ── Full-fleet dispatch ───────────────────────────────────────────────────────

/**
 * Run weekly digests for every active Continuous subscriber.
 *
 * Works with both the old schema (repo_url only) and the new schema
 * (+ customer_email + slack_webhook_url) so it degrades gracefully
 * before the migration is applied.
 *
 * @param {Function} sql — injected DB tagged-template
 * @returns {Promise<{ sent: number, failed: number, skipped: number, results: Array }>}
 */
async function runWeeklyDigests(sql) {
  if (typeof sql !== 'function') throw new Error('runWeeklyDigests: sql is required');

  let subs = [];

  // Try the full schema first; fall back to minimal if columns don't exist yet
  try {
    subs = await sql`
      SELECT repo_url, customer_email, slack_webhook_url
      FROM   continuous_subscriptions
      WHERE  status = 'active'
    `;
  } catch {
    try {
      subs = await sql`
        SELECT repo_url, NULL::text AS customer_email, NULL::text AS slack_webhook_url
        FROM   continuous_subscriptions
        WHERE  status = 'active'
      `;
    } catch (e) {
      throw new Error(`runWeeklyDigests: cannot query subscriptions — ${e.message}`);
    }
  }

  let sent    = 0;
  let failed  = 0;
  let skipped = 0;
  const results = [];

  for (const sub of subs) {
    const hasChannel = sub.customer_email || sub.slack_webhook_url || process.env.SLACK_WEBHOOK_URL;
    if (!hasChannel) { skipped++; continue; }

    try {
      const r = await sendRepoDigest({
        repoUrl:        sub.repo_url,
        customerEmail:  sub.customer_email || null,
        slackWebhookUrl: sub.slack_webhook_url || null,
        sql,
      });

      const delivered = r.email.ok || r.slack.ok;
      if (delivered) sent++; else failed++;

      results.push({
        repoUrl:  sub.repo_url,
        email:    r.email,
        slack:    r.slack,
        trend:    r.trend,
        delivered,
      });
    } catch (e) {
      failed++;
      results.push({ repoUrl: sub.repo_url, error: e.message, delivered: false });
    }
  }

  return { sent, failed, skipped, results };
}

module.exports = {
  buildTrendFromHistory,
  sendRepoDigest,
  runWeeklyDigests,
};
