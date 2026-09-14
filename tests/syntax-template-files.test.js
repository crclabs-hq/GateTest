'use strict';

// =============================================================================
// syntax — a Django/Jinja template that renders to JavaScript is not JavaScript
// =============================================================================
// django/django @ main, scanned 2026-09-14: `django/views/templates/
// i18n_catalog.js` is the source the JavaScriptCatalog view renders — it opens
// with `{% autoescape off %}` and is threaded with `{% if plural %}` /
// `{{ plural }}`. The JS parser read the first `%` and the whole scan was
// gate-BLOCKED on "Unexpected token '%'" at confidence 1.0.
//
// `{% ... %}` is never valid JavaScript, so a whole line of it settles the
// question on content alone; a `templates/` path segment counts only together
// with a `{{` / `{%` in the file, because a JS project can keep real modules
// under `src/templates/` and those still deserve a parse. Control pairs: a
// genuine syntax error in shipped JS still fails; `{{ b(); }}` (a block inside
// a block) is not a template.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const SyntaxModule = require('../src/modules/syntax');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
}
function run(projectRoot) {
  const mod = new SyntaxModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const check = (r, rel) => r.checks.find((c) => c.name === `syntax:${rel}`);

// The opening of django/views/templates/i18n_catalog.js, verbatim.
const DJANGO_I18N_CATALOG = [
  '{% autoescape off %}',
  "'use strict';",
  '{',
  '  const globals = this;',
  '  const django = globals.django || (globals.django = {});',
  '',
  '  {% if plural %}',
  '  django.pluralidx = function(n) {',
  '    const v = {{ plural }};',
  "    if (typeof v === 'boolean') {",
  '      return v ? 1 : 0;',
  '    } else {',
  '      return v;',
  '    }',
  '  };',
  '  {% else %}',
  '  django.pluralidx = function(count) { return (count == 1) ? 0 : 1; };',
  '  {% endif %}',
  '',
  '  /* gettext library */',
  '',
  '  django.catalog = django.catalog || {};',
  '  {% if catalog_str %}',
  '  const newcatalog = {{ catalog_str }};',
  '  for (const key in newcatalog) {',
  '    django.catalog[key] = newcatalog[key];',
  '  }',
  '  {% endif %}',
  '}',
  '{% endautoescape %}',
  '',
].join('\n');

describe('syntax — Django/Jinja templates with a .js extension', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-syn-tpl-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('django/views/templates/i18n_catalog.js is classified, not parsed — a passing info check', async () => {
    write(tmp, 'django/views/templates/i18n_catalog.js', DJANGO_I18N_CATALOG);
    const r = await run(tmp);
    const c = check(r, 'django/views/templates/i18n_catalog.js');
    assert.ok(c, 'the file is still on the report');
    assert.strictEqual(c.passed, true);
    assert.strictEqual(c.severity, 'info');
    assert.match(c.message, /template/i);
    assert.deepStrictEqual(
      r.checks.filter((x) => !x.passed).map((x) => x.name),
      [],
      'no failing check of any kind — the dangling-pattern heuristics must not trip on the tags either',
    );
  });

  it('the same content OUTSIDE a templates/ directory is still a template — `{% %}` on its own line is never JS', async () => {
    write(tmp, 'static/catalog.js', DJANGO_I18N_CATALOG);
    const r = await run(tmp);
    const c = check(r, 'static/catalog.js');
    assert.strictEqual(c.passed, true);
    assert.strictEqual(c.severity, 'info');
  });

  it('POSITIVE CONTROL — a genuine syntax error in shipped JS still fails the gate', async () => {
    write(tmp, 'src/broken.js', 'const x = ;\n');
    const r = await run(tmp);
    const c = check(r, 'src/broken.js');
    assert.ok(c && c.passed === false, 'the parser still runs on real JavaScript');
  });

  it('POSITIVE CONTROL — real JavaScript under templates/ is still parsed (and a broken one still fails)', async () => {
    write(tmp, 'src/templates/email.js', 'module.exports = (name) => `Hello ${name}`;\n');
    write(tmp, 'src/templates/broken.js', 'function ( {\n');
    const r = await run(tmp);
    const ok = check(r, 'src/templates/email.js');
    assert.strictEqual(ok.passed, true);
    assert.notStrictEqual(ok.severity, 'info', 'a parsed file is a plain pass, not a template classification');
    const bad = check(r, 'src/templates/broken.js');
    assert.strictEqual(bad.passed, false, 'a templates/ path alone does not exempt a file from the parser');
  });

  it('NEGATIVE CONTROL — `{{ b(); }}` is a block inside a block, not a template tag', () => {
    assert.strictEqual(SyntaxModule.isTemplateSource('src/a.js', 'if (a) {{ b(); }}\n'), false);
    assert.strictEqual(SyntaxModule.isTemplateSource('src/a.js', 'const pct = "100%"; // {% not a tag\n'), false);
  });

  it('the classifier reads either separator', () => {
    assert.strictEqual(SyntaxModule.isTemplateSource('app\\templates\\widget.js', 'var x = {{ value }};\n'), true);
    assert.strictEqual(SyntaxModule.isTemplateSource('app/templates/widget.js', 'var x = 1;\n'), false);
  });
});
