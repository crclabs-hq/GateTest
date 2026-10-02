'use strict';

/**
 * Hosted-MCP subscribers may run the paid fix route with their key.
 *
 * Audit 2026-10-02: the $29/mo hosted MCP sells `fix_issue`, which POSTs to
 * /api/scan/fix — but that route only accepted a Stripe checkout `sessionId`
 * (or an admin cookie), and the MCP server sent neither. Every paid call came
 * back 402 "Missing sessionId". The subscription key IS the entitlement: the
 * MCP server forwards it as `Authorization: Bearer gtmcp_…`, and the route asks
 * this module before falling back to the checkout-session check.
 *
 * Three answers plus "no key" (never a false "paid"):
 *   none        no gtmcp_ key on the request — use the checkout-session path
 *   active      an active subscription — run the fix
 *   inactive    a well-formed key with no active subscription — 402
 *   not_checked the subscription store could not be read — 503, say why
 */

const { extractKey, keyShapeValid } = require('./mcp-remote-core.cjs');

/**
 * @param {{ headers: unknown, sql: Function | null, findByApiKey: Function }} deps
 * @returns {Promise<{ state: 'none' } | { state: 'active', customerEmail: string | null, subscriptionId: string | null } | { state: 'inactive' } | { state: 'not_checked', reason: string }>}
 */
async function verifyMcpFixEntitlement({ headers, sql, findByApiKey }) {
  const key = extractKey(headers);
  if (!key || !String(key).startsWith('gtmcp_')) return { state: 'none' };
  if (!keyShapeValid(key)) return { state: 'inactive' };
  if (!sql) return { state: 'not_checked', reason: 'subscription store not configured' };
  let row;
  try {
    row = await findByApiKey(sql, key);
  } catch (err) {
    return { state: 'not_checked', reason: err && err.message ? err.message : 'subscription lookup failed' };
  }
  if (!row || row.status !== 'active') return { state: 'inactive' };
  return { state: 'active', customerEmail: row.customerEmail || null, subscriptionId: row.stripeSubscriptionId || null };
}

module.exports = { verifyMcpFixEntitlement };
