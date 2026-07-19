// Client-bundle entry point — mounts the DOM-facing components. Colocated
// with the server code in this small full-stack corpus (same layout the
// original benchmark used).
const { renderComment, renderProfile } = require('./components/render');
const { renderFooter } = require('./components/footer');

function mount(root) {
  renderComment(root, { text: 'stub comment' });
  renderProfile(root, { displayName: 'stub user' });
  renderFooter(root);
}

module.exports = { mount };
