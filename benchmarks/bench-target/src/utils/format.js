// Clean control file — no planted issue.
function slugify(value) {
  return value.toLowerCase().trim().replace(/\s+/g, '-');
}

module.exports = { slugify };
