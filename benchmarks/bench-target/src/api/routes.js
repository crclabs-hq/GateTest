const express = require('express');
const { getUser, deleteUser, login, checkout, bulkUpstream } = require('./handler');
const requireAuth = require('../auth/middleware');
const { evalExpression } = require('../utils/eval-config');

const router = express.Router();

router.post('/login', login);
router.post('/checkout', requireAuth, checkout);
router.post('/bulk-upstream', requireAuth, bulkUpstream);
router.get('/:id', getUser);
router.delete('/:id', requireAuth, deleteUser);

// PLANTED #4 (reachability): exposes eval-config's evalExpression as a real
// endpoint rather than leaving it unreferenced dead code.
router.get('/config/eval', (req, res) => {
  res.json({ result: evalExpression(req) });
});

module.exports = router;
