// PLANTED #4: eval() of external input — a request-supplied expression is
// evaluated directly.
function evalExpression(req) {
  return eval(req.query.expr);
}

module.exports = { evalExpression };
