// Clean control file — static markup, no user input, no planted issue.
// Uses textContent (not innerHTML) precisely so it doesn't trip the same
// rule render.js is planted to trip.
function renderFooter(el) {
  el.textContent = '© bench-target';
}

module.exports = { renderFooter };
