// NOTE: intentionally NOT destructured — the sql-injection detector matches
// the `.query(...)` method-call shape real DB drivers use (mysql/pg-style),
// which a bare destructured call wouldn't look like. This makes
// connection.js's own `query` export show as a dead-code bonus finding
// (see docs/COMPETITIVE-BENCHMARK.md's "findings beyond the plants" note).
const db = require('./connection');

// PLANTED #1: SQL injection — string concat AND template-literal into
// .query(), both fed by the tainted `id` traced from routes.js -> handler.js.
function findUserById(id) {
  const sql = "SELECT * FROM users WHERE id = '" + id + "'";
  return db.query(sql);
}

function deleteUserById(id) {
  const sql = `DELETE FROM users WHERE id = '${id}'`;
  return db.query(sql);
}

module.exports = { findUserById, deleteUserById };
