// Clean control file — legitimate auth check, no planted issue.
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = requireAuth;
