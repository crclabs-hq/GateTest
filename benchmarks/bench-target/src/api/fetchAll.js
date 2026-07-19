const { fetchUpstream } = require('./client');

// PLANTED #8: race condition — forEach with an async callback; the outer
// function returns before any of the awaited fetches actually resolve.
function fetchAllUpstream(paths) {
  const results = [];
  paths.forEach(async (path) => {
    const res = await fetchUpstream(path);
    results.push(res);
  });
  return results;
}

module.exports = { fetchAllUpstream };
