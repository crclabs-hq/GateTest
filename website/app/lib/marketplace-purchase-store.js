/**
 * Persistence for GitHub Marketplace `marketplace_purchase` webhook events —
 * see website/app/api/marketplace/webhook/route.ts for the wire contract.
 *
 * This is a distinct concern from the GitHub App's push/PR webhook
 * (scan-queue-store.js / github-events.js): that one enqueues scans; this one
 * only observes the Marketplace listing's install lifecycle (purchased /
 * cancelled / changed / pending_change / pending_change_cancelled) so the
 * active-install count can be surfaced on the admin/ops stats page.
 *
 * Only the columns below are ever stored. The sender, any e-mail, and the raw
 * payload are deliberately never persisted — GateTest does not need them and
 * the Bible forbids storing more customer data than a feature requires.
 *
 * Idempotent insert: GitHub redelivers a webhook on transient failure, and
 * `X-GitHub-Delivery` is the natural dedupe key — same pattern as
 * scan-queue-store.enqueueScan's `ON CONFLICT (event_id) DO NOTHING`.
 */

'use strict';

const ACTIONS = Object.freeze([
  'purchased',
  'cancelled',
  'changed',
  'pending_change',
  'pending_change_cancelled',
]);

function textOrNull(v, max = 200) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function bigintOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Reduce a raw `marketplace_purchase` payload down to exactly the columns we
 * store. Never returns the sender, the raw payload, or any e-mail address —
 * GitHub's payload carries `sender.email` and `marketplace_purchase.account`
 * details beyond what is listed here, and none of it is read.
 */
function extractPurchaseFields(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const mp = p.marketplace_purchase && typeof p.marketplace_purchase === 'object' ? p.marketplace_purchase : {};
  const account = mp.account && typeof mp.account === 'object' ? mp.account : {};
  const plan = mp.plan && typeof mp.plan === 'object' ? mp.plan : {};
  return {
    action: textOrNull(p.action, 40),
    account_login: textOrNull(account.login, 200),
    account_type: textOrNull(account.type, 40),
    account_id: bigintOrNull(account.id),
    plan_name: textOrNull(plan.name, 200),
    plan_id: bigintOrNull(plan.id),
    on_free_trial: mp.on_free_trial === true,
    effective_date: typeof p.effective_date === 'string' && p.effective_date.trim()
      ? p.effective_date.trim()
      : null,
  };
}

/**
 * Idempotent — safe to call before every write and every read (same
 * convention as usage-ledger.js / scan-queue-store.js).
 */
async function ensureSchema(sql) {
  if (!sql || typeof sql !== 'function') throw new Error('sql tagged-template is required');
  await sql`CREATE TABLE IF NOT EXISTS marketplace_purchases (
    id SERIAL PRIMARY KEY,
    delivery_id TEXT UNIQUE,
    action TEXT,
    account_login TEXT,
    account_type TEXT,
    account_id BIGINT,
    plan_name TEXT,
    plan_id BIGINT,
    on_free_trial BOOLEAN,
    effective_date TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}

/**
 * Record one `marketplace_purchase` delivery. `ON CONFLICT (delivery_id) DO
 * NOTHING` so a GitHub redelivery of the same `X-GitHub-Delivery` id never
 * double-counts installs or cancellations.
 *
 * @param {Function} sql
 * @param {{ deliveryId: string, payload: object }} args
 * @returns {Promise<{ inserted: boolean, id: number|null }>}
 */
async function recordPurchaseEvent(sql, { deliveryId, payload } = {}) {
  if (!sql || typeof sql !== 'function') throw new Error('sql tagged-template is required');
  const delivery = textOrNull(deliveryId, 200);
  if (!delivery) throw new Error('deliveryId is required');
  await ensureSchema(sql);
  const row = extractPurchaseFields(payload);
  const rows = await sql`INSERT INTO marketplace_purchases
      (delivery_id, action, account_login, account_type, account_id, plan_name, plan_id, on_free_trial, effective_date)
    VALUES
      (${delivery}, ${row.action}, ${row.account_login}, ${row.account_type}, ${row.account_id},
       ${row.plan_name}, ${row.plan_id}, ${row.on_free_trial}, ${row.effective_date}::timestamptz)
    ON CONFLICT (delivery_id) DO NOTHING
    RETURNING id`;
  const list = Array.isArray(rows) ? rows : [];
  const inserted = list.length > 0;
  return { inserted, id: inserted ? list[0].id : null };
}

/**
 * Counts by action, plus the current active-install count.
 *
 * "Active" is computed per account (purchased events minus cancelled events
 * for that account_id), not as a single global purchased-minus-cancelled
 * total — an account can cancel and later re-purchase, and netting per
 * account is the only way that cycle still reads as one active install
 * rather than silently drifting the global count negative or double-counting.
 *
 * @param {Function} sql
 * @returns {Promise<{ counts: Record<string, number>, activeInstalls: number }>}
 */
async function summarize(sql) {
  if (!sql || typeof sql !== 'function') throw new Error('sql tagged-template is required');
  await ensureSchema(sql);
  const byAction = await sql`SELECT action, COUNT(*)::int AS count
    FROM marketplace_purchases
    GROUP BY action`;
  const netRows = await sql`SELECT account_id,
      SUM(CASE WHEN action = 'purchased' THEN 1 WHEN action = 'cancelled' THEN -1 ELSE 0 END)::int AS net
    FROM marketplace_purchases
    WHERE account_id IS NOT NULL
    GROUP BY account_id`;

  const counts = {};
  for (const a of ACTIONS) counts[a] = 0;
  for (const r of (Array.isArray(byAction) ? byAction : [])) {
    if (r && typeof r.action === 'string') counts[r.action] = Number(r.count) || 0;
  }
  const activeInstalls = (Array.isArray(netRows) ? netRows : [])
    .filter((r) => Number(r && r.net) > 0)
    .length;

  return { counts, activeInstalls };
}

module.exports = {
  ACTIONS,
  extractPurchaseFields,
  ensureSchema,
  recordPurchaseEvent,
  summarize,
};
