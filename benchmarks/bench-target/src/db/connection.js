// Clean control file — no planted issue. A parameterized query helper would
// normally live here; this benchmark corpus stubs the driver itself.
function query(sql, params) {
  return Promise.resolve({ sql, params, rows: [] });
}

module.exports = { query };
