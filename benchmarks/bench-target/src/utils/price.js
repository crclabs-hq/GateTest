// PLANTED #6: money stored/computed as an IEEE-754 float, two sites.
function calculateTotal(price, tax) {
  const total = parseFloat(price) + parseFloat(tax);
  return total;
}

function applyDiscount(item) {
  const price = parseFloat(item.price) * 0.9;
  return price;
}

module.exports = { calculateTotal, applyDiscount };
