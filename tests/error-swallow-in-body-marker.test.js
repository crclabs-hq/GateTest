'use strict';

// =============================================================================
// errorSwallow — the `// error-ok` marker on the first line INSIDE a catch body
// =============================================================================
// Self-scan 2026-09-13 (332 open errorSwallow findings on this repository): the
// rule honoured the marker only on the catch line itself or the line above it.
// A multi-line `catch {` whose first body line carries the marker and the
// reason — the natural place to write it — was reported as a swallow anyway.
// Control pair: the in-body marker is honoured; the same block with a plain
// comment, and a marker further down the body, still fire.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ErrorSwallowModule = require('../src/modules/error-swallow');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
}
function run(projectRoot) {
  const mod = new ErrorSwallowModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const fired = (r) => r.checks.filter((c) => !c.passed && /^error-swallow:empty-catch/.test(c.name)).map((c) => c.name.replace(/\\/g, '/'));

describe('errorSwallow — marker on the first line inside the catch body', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-body-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('honours `// error-ok` as the first body line; a plain comment in the same shape still fires', async () => {
    write(tmp, 'src/snapshot.js', [
      'async function snapshot(sql) {',
      '  const out = {};',
      '  try {',
      '    out.locked = await sql`SELECT 1`;',
      '  } catch {',
      '    // error-ok — a partial snapshot is still useful for the dashboard',
      '  }',
      '  try {',
      '    out.failed = await sql`SELECT 2`;',
      '  } catch {',
      '    // best effort',
      '  }',
      '  return out;',
      '}',
      'module.exports = { snapshot };',
      '',
    ].join('\n'));
    const names = fired(await run(tmp));
    assert.strictEqual(names.length, 1, `exactly the plain-comment catch fires, got ${JSON.stringify(names)}`);
    assert.ok(names[0].includes('snapshot.js:10'), `line 10 (the plain comment) is the one reported: ${names[0]}`);
  });

  it('a marker further down the body, or on an unrelated next line, does not suppress', async () => {
    write(tmp, 'src/later.js', [
      'function a() {',
      '  try { doIt(); } catch {',
      '    // first we note nothing',
      '    // error-ok — too late, this is not the first body line',
      '  }',
      '}',
      'function b() {',
      '  try { doIt(); } catch {}',
      '  // error-ok — this belongs to whatever comes next, not to the catch above',
      '}',
      'module.exports = { a, b };',
      '',
    ].join('\n'));
    const names = fired(await run(tmp));
    assert.strictEqual(names.length, 2, `both catches must still fire, got ${JSON.stringify(names)}`);
  });

  it('the catch line and the line above are honoured exactly as before', async () => {
    write(tmp, 'src/same.js', [
      'function a() {',
      '  try { doIt(); } catch { /* error-ok — cache miss is the normal path */ }',
      '  // error-ok — the retry below re-raises on the second failure',
      '  try { doIt(); } catch {}',
      '  try { doIt(); } catch {}',
      '}',
      'module.exports = { a };',
      '',
    ].join('\n'));
    const names = fired(await run(tmp));
    assert.strictEqual(names.length, 1, `only the unmarked catch fires, got ${JSON.stringify(names)}`);
    assert.ok(names[0].includes('same.js:5'));
  });
});
