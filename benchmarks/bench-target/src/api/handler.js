const { findUserById, deleteUserById } = require('../db/query');
const { buildUserRecord } = require('../db/models');
const { chargeCustomer } = require('../auth/login');
const { createSession } = require('../auth/session');
const { calculateTotal, applyDiscount } = require('../utils/price');
const { buildOrderSummary } = require('../models/order');
const { buildProductView } = require('../models/product');
const { looksLikeEmail } = require('../utils/regex');
const { isNonEmptyString } = require('../utils/validate');
const { fetchAllUpstream } = require('./fetchAll');

// PLANTED #1 (route hop): user-controlled req.params.id flows unsanitized
// into query.findUserById, which builds a SQL string with it two files away.
async function getUser(req, res) {
  const userId = req.params.id;
  const row = await findUserById(userId);
  res.json(buildUserRecord(row || { id: userId, name: 'unknown' }));
}

async function deleteUser(req, res) {
  try {
    await deleteUserById(req.params.id);
    res.status(204).end();
  } catch (err) {
    // PLANTED #9: comment-only catch — error is silently swallowed, never
    // logged, never rethrown, never surfaced to the caller.
  }
}

function login(req, res) {
  const { email, password } = req.body;
  if (!isNonEmptyString(password) || !looksLikeEmail(email)) {
    return res.status(400).json({ error: 'invalid credentials' });
  }
  const result = chargeCustomer(0, 'auth-only');
  const created = createSession({ email }, result.token);
  res.json(created);
}

function checkout(req, res) {
  const { price: itemPrice, tax, item } = req.body;
  const total = calculateTotal(itemPrice, tax);
  const discounted = applyDiscount(item || { price: itemPrice });
  const productView = item ? buildProductView(item) : null;
  const summary = buildOrderSummary({ id: 'ord_1', items: [item].filter(Boolean) });
  res.json({ total, discounted, product: productView, summary });
}

function bulkUpstream(req, res) {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  res.json({ queued: fetchAllUpstream(paths).length });
}

module.exports = { getUser, deleteUser, login, checkout, bulkUpstream };
