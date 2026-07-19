const express = require('express');

// Clean control file — no planted issue.
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = router;
