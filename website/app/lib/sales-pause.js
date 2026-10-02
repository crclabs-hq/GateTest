'use strict';

/**
 * Sales pause — the ONE switch that stops GateTest from taking money.
 *
 * Craig, 2026-10-01: "we havent built the scan & repair tool properly yet …
 * build the switch and pause sales." Until the paid tiers do everything the
 * site says they do, no customer can be charged.
 *
 * Fail-closed on purpose: sales are paused unless GATETEST_SALES_PAUSED is
 * exactly "0". A missing variable, a typo or a blank line can never reopen
 * checkout by accident — reopening is a deliberate act (set it to 0 in the
 * admin secrets panel or the server env file, then restart).
 *
 * Enforced on the server in POST /api/checkout — the only place a Stripe
 * Checkout Session is created — so every buy button, the /checkout page and
 * the WordPress plugin's link all stop at the same line. The pages read
 * GET /api/sales-status only to SAY it is paused instead of offering a
 * button that would refuse.
 */

const SALES_PAUSED_MESSAGE =
  'Paid plans are not on sale yet — we are finishing them before we take anyone\'s money. ' +
  'The free scan works today. Email support@gatetest.io and we will tell you when paid plans open.';

/** @param {Record<string, string | undefined>} [env] */
function salesPaused(env = process.env) {
  return String(env.GATETEST_SALES_PAUSED == null ? '' : env.GATETEST_SALES_PAUSED).trim() !== '0';
}

/** The body POST /api/checkout answers with (HTTP 503) while sales are paused. */
function salesPausedBody() {
  return { error: SALES_PAUSED_MESSAGE, code: 'sales_paused' };
}

module.exports = { salesPaused, salesPausedBody, SALES_PAUSED_MESSAGE };
