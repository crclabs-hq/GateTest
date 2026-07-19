// PLANTED #2: hardcoded secret, checked straight into source. Uses
// GateTest's generic "api_key = '...'" pattern (src/modules/secrets.js) — a
// vendor-shaped key like a real Stripe `sk_live_` prefix trips GitHub's own
// push-protection secret scanner even with an obviously-fake low-entropy
// value, since it matches on known partner token FORMATS, not on whether
// the value looks real. A generic assignment isn't a recognized partner
// format, so it's still a real hardcoded-secret plant without being an
// actual push-blocked credential shape.
const API_KEY = 'a1B2c3D4e5F6g7H8i9J0k1L2';

function chargeCustomer(amount, token) {
  return { amount, token, key: API_KEY };
}

module.exports = { chargeCustomer };
