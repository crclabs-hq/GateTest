/**
 * Pure helpers for the Stripe checkout route at
 * `website/app/api/checkout/route.ts`.
 *
 * The route's payload shaping, tier validation, repo-URL validation, and
 * Stripe-request URL-encoding logic live here so they can be unit-tested
 * from `tests/stripe-checkout.test.js` with `node --test`.
 *
 * Nothing in here performs network I/O. The `buildSession` helper accepts
 * an injected `fetchImpl` so tests can mock the Stripe boundary without
 * touching the real API.
 *
 * Stripe config (prices, product shapes, capture_method: manual) is
 * intentionally duplicated in route.ts — this file mirrors it so a change
 * in one must be reflected in the other. See the `TIERS` table in both.
 */

/**
 * Canonical tier table. Kept in sync with route.ts.
 * @type {Record<string, { name: string, priceInCents: number, modules: string, description: string }>}
 */
const TIERS = {
  quick: {
    name: 'Quick Scan',
    priceInCents: 2900,
    modules: 'syntax, lint, secrets, codeQuality',
    description: '4 modules — syntax, linting, secrets, code quality',
  },
  full: {
    name: 'Full Scan',
    priceInCents: 9900,
    modules: 'all-84',
    description:
      'All 84 modules — security, accessibility, SEO, AI review, and more',
  },
};

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
