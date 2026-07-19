// Clean control file — no planted issue.
function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}

module.exports = cors;
