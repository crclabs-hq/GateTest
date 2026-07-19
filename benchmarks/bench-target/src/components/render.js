// PLANTED #3: XSS — unsanitized user input written via innerHTML, two sites.
function renderComment(el, comment) {
  el.innerHTML = comment.text;
}

function renderProfile(el, profile) {
  el.innerHTML = '<h2>' + profile.displayName + '</h2>';
}

module.exports = { renderComment, renderProfile };
