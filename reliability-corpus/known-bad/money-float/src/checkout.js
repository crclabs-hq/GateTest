"use strict";

// BAD: storing currency in floats causes drift (0.1 + 0.2 !== 0.3)
function chargeOrder(req) {
  const amount = parseFloat(req.body.amount);
  const tax = parseFloat(req.body.tax);
  const total = amount + tax;
  // Sub-cent rounding bug — loses precision regulators care about.
  return Number(total).toFixed(1);
}

module.exports = { chargeOrder };
