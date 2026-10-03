// a11y:input-label ignores a JS comment that opens a line (Gluecron
// workflow-secrets.tsx:160: a JSDoc naming "the name <input> element").
// Controls: an unlabelled <input> in code still fires, and one after a
// mid-line `image/*` (not a comment) still fires.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const AccessibilityModule = require('../src/modules/accessibility');

function fired(rel, content) {
  const checks = [];
  new AccessibilityModule()._checkFormLabels(rel, content, { addCheck(n, p, d = {}) { checks.push({ n, p, ...d }); } });
  return checks.filter((c) => !c.p && c.n.startsWith('a11y:input-label:')).length;
}

describe('a11y:input-label — JS comments are prose', () => {
  it('a JSDoc naming <input> does not fire', () => {
    assert.strictEqual(fired('src/routes/x.tsx', [
      'const s = `<script>',
      '  /**',
      '   * @param {HTMLInputElement} el  the name <input> element',
      '   */',
      '  // the <input> above is validated on blur',
      '</script>`;',
    ].join('\n')), 0);
  });
  it('control: an unlabelled <input> in code fires', () => {
    assert.strictEqual(fired('src/routes/x.tsx', 'export const F = () => <form><input type="text" name="q" /></form>;'), 1);
  });
  it('control: a mid-line image/* is not a comment opener', () => {
    assert.strictEqual(fired('src/routes/x.tsx', 'export const F = () => <form><input type="file" accept="image/*" /><input type="text" name="q" /></form>;'), 2);
  });
  it('control: an HTML file is not JS-comment-stripped', () => {
    assert.strictEqual(fired('public/x.html', '<form>\n// <input type="text" name="q">\n</form>'), 1);
  });
});
