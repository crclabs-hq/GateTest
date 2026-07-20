/**
 * Pure helpers for the Stripe checkout flow, unit-tested from
 * `tests/stripe-checkout.test.js`.
 *
 * IMPORTANT: `validateCheckoutInput` / `buildStripeCheckoutParams` /
 * `createCheckoutSession` below are NOT called by the real checkout route
 * (`website/app/api/checkout/route.ts`) — it has its own self-contained
 * implementation (`stripeRequest` + the inline POST handler) that evolved
 * independently and now also supports `mode: "subscription"` for the
 * Continuous/MCP tiers, which this file's `buildStripeCheckoutParams`
 * does not. This file's checkout-flow functions are therefore a parallel,
 * untested-against-production implementation — kept for now (their own
 * unit tests are still valid as tests of THIS code), but anyone touching
 * checkout behavior should look at route.ts as the actual source of truth,
 * not assume this file mirrors it. Worth a follow-up decision (delete this
 * dead flow, or wire route.ts to actually use it) rather than fixing here.
 *
 * The `TIERS` table below is NOT duplicated — previously was a hand-
 * written second copy that drifted (missing scan_fix/nuclear/continuous/
 * mcp, stale "all-84" module count vs the real "all-120"); now imported
 * directly from route.ts so there is exactly one tier table to update.
 */

const { TIERS } = require("./checkout-tiers.ts");

/**
 * Validate the request input. Returns `{ ok: true, tier, tierKey, repoUrl }`
 * on success, or `{ ok: false, status, error }` on failure.
 *
 * @param {unknown} input
 */
function validateCheckoutInput(input) {
  if (input === null || typeof input !== 'object') {
    return { ok: false, status: 400, error: 'Invalid request body' };
  }
  const obj = /** @type {Record<string, unknown>} */ (input);
  const tierKey = typeof obj.tier === 'string' ? obj.tier : '';
  const tier = TIERS[tierKey];
  if (!tier) {
    return {
      ok: false,
      status: 400,
      error: `Invalid tier. Options: ${Object.keys(TIERS).join(', ')}`,
    };
  }
  const repoUrl = typeof obj.repoUrl === 'string' ? obj.repoUrl : '';
  if (!repoUrl || !repoUrl.includes('github.com')) {
    return {
      ok: false,
      status: 400,
      error: 'A valid GitHub repository URL is required',
    };
  }
  return { ok: true, tier, tierKey, repoUrl };
}

/**
 * Build the URL-encoded form body Stripe expects for
 * POST /v1/checkout/sessions. Deliberately mirrors route.ts shape: manual
 * capture, line_items with price_data + product_data, metadata on both the
 * session and the payment_intent, return URLs built from baseUrl.
 *
 * @param {{
 *   tier: { name: string, priceInCents: number, modules: string, description: string },
 *   tierKey: string,
 *   repoUrl: string,
 *   baseUrl: string,
 * }} args
 */
function buildStripeCheckoutParams({ tier, tierKey, repoUrl, baseUrl }) {
  // Per-scan upfront charge (Craig 2026-05-18). No capture_method:manual;
  // payment captures at checkout. Scan-failure handling is a support
  // touchpoint, not an automatic refund trigger.
  return new URLSearchParams({
    'payment_method_types[0]': 'card',
    mode: 'payment',
    'payment_intent_data[metadata][tier]': tierKey,
    'payment_intent_data[metadata][repo_url]': repoUrl,
    'payment_intent_data[metadata][modules]': tier.modules,
    'metadata[tier]': tierKey,
    'metadata[repo_url]': repoUrl,
    'metadata[modules]': tier.modules,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(tier.priceInCents),
    'line_items[0][price_data][product_data][name]': `GateTest ${tier.name}`,
    'line_items[0][price_data][product_data][description]': tier.description,
    'line_items[0][quantity]': '1',
    success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/checkout/cancel`,
  });
}

/**
 * Full create-session flow expressed as a pure function.
 *
 * Accepts an injected `fetchImpl` so tests can mock the Stripe boundary
 * with zero network calls. `env.STRIPE_SECRET_KEY` and
 * `env.NEXT_PUBLIC_BASE_URL` are read off the supplied env map so the
 * caller (route.ts) decides where they come from.
 *
 * Returns:
 *   { ok: true, checkoutUrl, sessionId }
 *   { ok: false, status, error }
 *
 * @param {{
 *   input: unknown,
 *   env: Record<string, string | undefined>,
 *   fetchImpl: (url: string, init: { method: string, headers: Record<string, string>, body: string }) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>,
 * }} args
 */
async function createCheckoutSession({ input, env, fetchImpl }) {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) {
    return { ok: false, status: 503, error: 'Payments not configured yet' };
  }

  const validation = validateCheckoutInput(input);
  if (!validation.ok) {
    return { ok: false, status: validation.status, error: validation.error };
  }

  const baseUrl = env.NEXT_PUBLIC_BASE_URL || 'https://gatetest.ai';
  const params = buildStripeCheckoutParams({
    tier: validation.tier,
    tierKey: validation.tierKey,
    repoUrl: validation.repoUrl,
    baseUrl,
  });

  let response;
  try {
    response = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, status: 500, error: message };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    // Parse failure mirrors the route's outer try/catch → 500.
    const message =
      err instanceof Error ? err.message : 'Stripe returned invalid JSON';
    return { ok: false, status: 500, error: message };
  }

  // Mirrors route.ts: a `session.error` in the response body → 400, carrying
  // Stripe's own error message through.
  if (body && typeof body === 'object' && 'error' in body) {
    const errObj = /** @type {{ error: unknown }} */ (body).error;
    const message =
      errObj &&
      typeof errObj === 'object' &&
      'message' in errObj &&
      typeof (/** @type {{ message: unknown }} */ (errObj).message) === 'string'
        ? /** @type {{ message: string }} */ (errObj).message
        : 'Stripe API error';
    return { ok: false, status: 400, error: message };
  }

  // Any other non-OK response → map through the outer catch path (500).
  if (!response.ok) {
    return { ok: false, status: 500, error: `Stripe HTTP ${response.status}` };
  }

  const session = /** @type {{ url?: string, id?: string }} */ (body);
  return {
    ok: true,
    checkoutUrl: session.url,
    sessionId: session.id,
  };
}

module.exports = {
  TIERS,
  validateCheckoutInput,
  buildStripeCheckoutParams,
  createCheckoutSession,
};
