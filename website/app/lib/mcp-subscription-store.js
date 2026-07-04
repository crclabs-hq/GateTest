'use strict';
/**
 * MCP Subscription store — the $29/mo "MCP" tier's persistence layer.
 *
 *   mcp_subscriptions(
 *     id                     BIGSERIAL PRIMARY KEY,
 *     stripe_subscription_id TEXT UNIQUE NOT NULL,
 *     stripe_customer_id     TEXT,
 *     api_key                TEXT UNIQUE NOT NULL,   -- gtmcp_<64 hex>
 *     status                 TEXT NOT NULL,          -- 'active' | 'past_due' | 'canceled'
 *     customer_email         TEXT,
 *     created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   )
 *
 * Same conventions as continuous-subscription-store.js: the caller
 * injects the Neon tagged-template `sql` so unit tests run against a
 * recorder. Every helper is serverless-safe (single queries, no state).
 */

const crypto = require('crypto');

/**
 * Generate a cryptographically random MCP API key.
 * Format: gtmcp_<64 hex chars>  (70 chars total)
 */
function generateApiKey() {
  return `gtmcp_${crypto.randomBytes(32).toString('hex')}`;
}

const VALID_STATUSES = new Set(['active', 'past_due', 'canceled']);

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS mcp_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    stripe_subscription_id TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    api_key TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    customer_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_mcp_subs_api_key
    ON mcp_subscriptions (api_key)`;
}

/**
 * Create-or-update an MCP subscription record (idempotent on
 * stripe_subscription_id — Stripe retries webhooks).
 *
 * On conflict, the api_key is preserved so the customer's existing key
 * is never rotated by a webhook retry.
 */
async function upsertMcpSubscription(sql, opts) {
  const { stripeSubscriptionId, stripeCustomerId, apiKey, status, customerEmail } = opts || {};
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!stripeSubscriptionId) throw new Error('stripeSubscriptionId is required');
  if (!apiKey) throw new Error('apiKey is required');
  const safeStatus = VALID_STATUSES.has(status) ? status : 'active';
  await ensureSchema(sql);
  const rows = await sql`INSERT INTO mcp_subscriptions
      (stripe_subscription_id, stripe_customer_id, api_key, status, customer_email)
    VALUES (${stripeSubscriptionId}, ${stripeCustomerId || null}, ${apiKey}, ${safeStatus}, ${customerEmail || null})
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, mcp_subscriptions.stripe_customer_id),
      status             = EXCLUDED.status,
      customer_email     = COALESCE(EXCLUDED.customer_email, mcp_subscriptions.customer_email),
      updated_at         = NOW()
    RETURNING id, stripe_subscription_id, api_key, status`;
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Look up a subscription by API key.
 * Returns { stripeSubscriptionId, status } or null (unknown key).
 * Used by /api/mcp/validate.
 */
async function findByApiKey(sql, apiKey) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!apiKey) return null;
  await ensureSchema(sql);
  const rows = await sql`SELECT stripe_subscription_id, status
    FROM mcp_subscriptions
    WHERE api_key = ${apiKey}
    LIMIT 1`;
  return rows && rows[0] ? { stripeSubscriptionId: rows[0].stripe_subscription_id, status: rows[0].status } : null;
}

/** Sync status from Stripe subscription lifecycle webhooks. */
async function setMcpSubscriptionStatus(sql, stripeSubscriptionId, status) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!stripeSubscriptionId) throw new Error('stripeSubscriptionId is required');
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  await ensureSchema(sql);
  const rows = await sql`UPDATE mcp_subscriptions
    SET status = ${status}, updated_at = NOW()
    WHERE stripe_subscription_id = ${stripeSubscriptionId}
    RETURNING id, stripe_subscription_id, status`;
  return rows && rows[0] ? rows[0] : null;
}

module.exports = {
  generateApiKey,
  ensureSchema,
  upsertMcpSubscription,
  findByApiKey,
  setMcpSubscriptionStatus,
};
