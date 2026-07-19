// PLANTED #12: unused variable.
function buildUserRecord(row) {
  const unusedTimestamp = Date.now();
  return { id: row.id, name: row.name };
}

module.exports = { buildUserRecord };
