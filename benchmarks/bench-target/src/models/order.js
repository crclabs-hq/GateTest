// Clean control file — no planted issue.
function buildOrderSummary(order) {
  return { id: order.id, itemCount: order.items.length };
}

module.exports = { buildOrderSummary };
