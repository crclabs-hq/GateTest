// Clean control file — no planted issue.
const hits = new Map();

function rateLimit(req, res, next) {
  const key = req.ip;
  const count = (hits.get(key) || 0) + 1;
  hits.set(key, count);
  if (count > 1000) {
    return res.status(429).json({ error: 'rate limited' });
  }
  next();
}

module.exports = rateLimit;
