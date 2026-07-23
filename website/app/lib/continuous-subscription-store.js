/**
 * Continuous-subscription store — the $49/mo "Continuous" tier's
 * persistence layer. Two tables:
 *
 *   continuous_subscriptions(
 *     id                     BIGSERIAL PRIMARY KEY,
 *     stripe_subscription_id TEXT UNIQUE NOT NULL,
 *     stripe_customer_id     TEXT,
 *     repo_url               TEXT NOT NULL,   -- normalised (lowercase, no trailing slash / .git)
 *     status                 TEXT NOT NULL,   -- 'active' | 'past_due' | 'canceled'
 *     current_period_end     TIMESTAMPTZ,
 *     customer_email         TEXT,            -- for weekly digest emails
 *     slack_webhook_url      TEXT,            -- per-repo Slack webhook (digest + alerts)
 *     created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   )
 *
 *   continuous_ai_ledger(
 *     id              BIGSERIAL PRIMARY KEY,
 *     subscription_id TEXT NOT NULL,          -- stripe_subscription_id
 *     month           TEXT NOT NULL,          -- 'YYYY-MM' (UTC)
 *     spent_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
 *     ai_scans        INTEGER NOT NULL DEFAULT 0,
 *     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     UNIQUE (subscription_id, month)
 *   )
 *
 * Economics (Craig green-light 2026-06-12): unlimited deterministic
 * scans (near-zero marginal cost), AI reviews metered by a monthly USD
 * allowance. Default budget $10/month — override with
 * CONTINUOUS_AI_BUDGET_USD. Worst-case abuse ≈ $12-15 cost against $49
 * revenue; typical ≈ $2-5 (~90% margin).
 *
 * Same conventions as scan-queue-store.js: the caller injects the
 * Neon tagged-template `sql` so unit tests run against a recorder.
 * Every helper is serverless-safe (single queries, no in-memory state).
 */

'use strict';

const DEFAULT_MONTHLY_AI_BUDGET_USD = 10;

function monthlyAiBudgetUsd() {
  const raw = Number(process.env.CONTINUOUS_AI_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MONTHLY_AI_BUDGET_USD;
}

/**
 * Normalise a repo URL so webhook-time lookups match checkout-time writes:
 * lowercase host+path, strip protocol variations, trailing slashes, ".git".
 * Returns null for garbage input.
 */
function normalizeRepoUrl(repoUrl) {
  if (typeof repoUrl !== 'string' || !repoUrl.trim()) return null;
  let s = repoUrl.trim().toLowerCase();
  s = s.replace(/^git@([^:]+):/, 'https://$1/'); // git@host:owner/repo → https://host/owner/repo
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/, '');
  if (!s.includes('/')) return null;
  return s;
}

/** Current ledger month key in UTC, e.g. '2026-06'. */
function monthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS continuous_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    stripe_subscription_id TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    repo_url TEXT NOT NULL,
    status TEXT NOT NULL,
    current_period_end TIMESTAMPTZ,
    customer_email TEXT,
    slack_webhook_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_continuous_subs_repo
    ON continuous_subscriptions (repo_url) `;
  // Safe migration: add columns if they don't exist (idempotent)
  await sql`ALTER TABLE continuous_subscriptions
    ADD COLUMN IF NOT EXISTS customer_email TEXT`;
  await sql`ALTER TABLE continuous_subscriptions
    ADD COLUMN IF NOT EXISTS slack_webhook_url TEXT`;
  await sql`CREATE TABLE IF NOT EXISTS continuous_ai_ledger (
    id BIGSERIAL PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    month TEXT NOT NULL,
    spent_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    ai_scans INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (subscription_id, month)
  )`;
}

const VALID_STATUSES = new Set(['active', 'past_due', 'canceled']);

/**
 * Create-or-update a subscription record (idempotent on
 * stripe_subscription_id — Stripe retries webhooks).
 */
async function upsertSubscription(sql, opts) {
  const { stripeSubscriptionId, stripeCustomerId, repoUrl, status, currentPeriodEnd, customerEmail, slackWebhookUrl } = opts || {};
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!stripeSubscriptionId) throw new Error('stripeSubscriptionId is required');
  const normalized = normalizeRepoUrl(repoUrl);
  if (!normalized) throw new Error('a valid repoUrl is required');
  const safeStatus = VALID_STATUSES.has(status) ? status : 'active';
  const periodEnd  = currentPeriodEnd instanceof Date ? currentPeriodEnd.toISOString() : currentPeriodEnd || null;
  const email      = customerEmail || null;
  const slack      = slackWebhookUrl || null;
  await ensureSchema(sql);
  const rows = await sql`INSERT INTO continuous_subscriptions
      (stripe_subscription_id, stripe_customer_id, repo_url, status, current_period_end, customer_email, slack_webhook_url)
    VALUES (${stripeSubscriptionId}, ${stripeCustomerId || null}, ${normalized}, ${safeStatus}, ${periodEnd}, ${email}, ${slack})
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      repo_url           = EXCLUDED.repo_url,
      status             = EXCLUDED.status,
      current_period_end = EXCLUDED.current_period_end,
      customer_email     = COALESCE(EXCLUDED.customer_email, continuous_subscriptions.customer_email),
      slack_webhook_url  = COALESCE(EXCLUDED.slack_webhook_url, continuous_subscriptions.slack_webhook_url),
      updated_at         = NOW()
    RETURNING id, stripe_subscription_id, repo_url, status`;
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Update the Slack webhook URL for a subscription (called from /api/account/notifications).
 */
async function setSlackWebhook(sql, stripeSubscriptionId, slackWebhookUrl) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!stripeSubscriptionId) throw new Error('stripeSubscriptionId is required');
  await ensureSchema(sql);
  const rows = await sql`UPDATE continuous_subscriptions
    SET slack_webhook_url = ${slackWebhookUrl || null}, updated_at = NOW()
    WHERE stripe_subscription_id = ${stripeSubscriptionId}
    RETURNING id`;
  return rows && rows[0] ? rows[0] : null;
}

/** Sync status from Stripe subscription lifecycle webhooks. */
async function setSubscriptionStatus(sql, stripeSubscriptionId, status) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!stripeSubscriptionId) throw new Error('stripeSubscriptionId is required');
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  await ensureSchema(sql);
  const rows = await sql`UPDATE continuous_subscriptions
    SET status = ${status}, updated_at = NOW()
    WHERE stripe_subscription_id = ${stripeSubscriptionId}
    RETURNING id, stripe_subscription_id, status`;
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Active subscription covering a repo, or null. Used by the push-scan
 * pipeline to decide whether a push is subscription-covered.
 *
 * ORG-FLAT since 2026-07-23 (Craig-authorized pricing change): one $49/mo
 * subscription covers EVERY repo under the same owner/org on the same host,
 * not just the repo named at checkout. Normalized shape is
 * "host/owner/repo" (see normalizeRepoUrl), so the org prefix is the first
 * two segments. Exact repo match is preferred when both exist (its ledger
 * carries any per-repo history); otherwise any active subscription under
 * the owner covers the push. The AI allowance stays per-subscription, so an
 * org's repos share one monthly AI budget — that's the intended economics
 * (deterministic scans are near-free; AI spend is the metered part).
 */
async function findActiveByRepo(sql, repoUrl) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  const normalized = normalizeRepoUrl(repoUrl);
  if (!normalized) return null;
  await ensureSchema(sql);
  const segments = normalized.split('/');
  // host/owner prefix — "github.com/acme". A malformed value with fewer
  // than 3 segments (no repo part) falls back to exact-match-only.
  const ownerPrefix = segments.length >= 3 ? `${segments[0]}/${segments[1]}/%` : null;
  const rows = ownerPrefix
    ? await sql`SELECT stripe_subscription_id, stripe_customer_id, repo_url, status, current_period_end
        FROM continuous_subscriptions
        WHERE (repo_url = ${normalized} OR repo_url LIKE ${ownerPrefix}) AND status = 'active'
        ORDER BY (repo_url = ${normalized}) DESC, updated_at DESC
        LIMIT 1`
    : await sql`SELECT stripe_subscription_id, stripe_customer_id, repo_url, status, current_period_end
        FROM continuous_subscriptions
        WHERE repo_url = ${normalized} AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1`;
  return rows && rows[0] ? rows[0] : null;
}

/**
 * This month's AI usage for a subscription.
 * @returns {{ spentUsd: number, aiScans: number }}
 */
async function getMonthUsage(sql, subscriptionId, month = monthKey()) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!subscriptionId) throw new Error('subscriptionId is required');
  await ensureSchema(sql);
  const rows = await sql`SELECT spent_usd, ai_scans FROM continuous_ai_ledger
    WHERE subscription_id = ${subscriptionId} AND month = ${month}
    LIMIT 1`;
  const row = rows && rows[0];
  return {
    spentUsd: row ? Number(row.spent_usd) || 0 : 0,
    aiScans: row ? Number(row.ai_scans) || 0 : 0,
  };
}

/** Accumulate AI spend for the month (upsert — first spend creates the row). */
async function recordAiSpend(sql, subscriptionId, usd, month = monthKey()) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!subscriptionId) throw new Error('subscriptionId is required');
  const amount = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  await ensureSchema(sql);
  await sql`INSERT INTO continuous_ai_ledger (subscription_id, month, spent_usd, ai_scans)
    VALUES (${subscriptionId}, ${month}, ${amount}, 1)
    ON CONFLICT (subscription_id, month) DO UPDATE SET
      spent_usd = continuous_ai_ledger.spent_usd + ${amount},
      ai_scans = continuous_ai_ledger.ai_scans + 1,
      updated_at = NOW()`;
}

/**
 * The gate: may this subscription run another AI-reviewed scan this month?
 * Deterministic scans NEVER consult this — they're unlimited by design.
 *
 * @returns {{ allowed: boolean, spentUsd: number, remainingUsd: number, budgetUsd: number }}
 */
async function checkAiAllowance(sql, subscriptionId, opts = {}) {
  const budgetUsd = Number.isFinite(opts.budgetUsd) && opts.budgetUsd > 0
    ? opts.budgetUsd
    : monthlyAiBudgetUsd();
  const usage = await getMonthUsage(sql, subscriptionId, opts.month);
  const remainingUsd = Math.max(0, budgetUsd - usage.spentUsd);
  return {
    allowed: usage.spentUsd < budgetUsd,
    spentUsd: usage.spentUsd,
    remainingUsd,
    budgetUsd,
  };
}

module.exports = {
  DEFAULT_MONTHLY_AI_BUDGET_USD,
  monthlyAiBudgetUsd,
  normalizeRepoUrl,
  monthKey,
  ensureSchema,
  upsertSubscription,
  setSubscriptionStatus,
  setSlackWebhook,
  findActiveByRepo,
  getMonthUsage,
  recordAiSpend,
  checkAiAllowance,
};
