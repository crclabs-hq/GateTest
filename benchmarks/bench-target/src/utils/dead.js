// PLANTED #10: dead code — exported function never imported anywhere else
// in the corpus.
function legacyFormatCurrency(amount) {
  return '$' + amount.toFixed(2);
}

module.exports = { legacyFormatCurrency };
