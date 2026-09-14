'use strict';

// =============================================================================
// shell — `rm -f $VAR` is not `rm -rf $VAR`
// =============================================================================
// django/django @ main, scanned 2026-09-14: `scripts/backport.sh:33` reads
// `rm -f ${TMPFILE}` (the temp file `mktemp` created three lines up). The rule
// reported it at confidence 1.0, gate-BLOCKING, as "`rm -rf ${TMPFILE}` — if
// the variable is empty/unset this wipes the filesystem root". Two things were
// wrong: the flag cluster `-[rRfF]+` accepted a bare `-f`, and the message
// then printed a `-rf` that is not in the source.
//
// Recursion is the hazard. With an empty variable `rm -f` is "missing operand"
// — a no-op `-f` even silences — while `rm -rf` of an empty expansion is the
// root wipe. Control pairs below: the django line does not fire; the same line
// with `-rf`, `-fr`, `-r -f`, `-f -r` and `--recursive` all still fire.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ShellModule = require('../src/modules/shell');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
}
function run(projectRoot) {
  const mod = new ShellModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const unsafeRm = (r) => r.checks.filter((c) => !c.passed && c.name.startsWith('shell:unsafe-rm:'));

// The django script, verbatim from scripts/backport.sh (lines 27-33).
const DJANGO_BACKPORT = [
  '#!/bin/bash',
  'set -e',
  'TMPFILE=$(mktemp)',
  'git log -1 --format=%B > ${TMPFILE}',
  'git commit --amend -F ${TMPFILE}',
  '',
  '# Clean up temporary files',
  'rm -f ${TMPFILE}',
  '',
].join('\n');

describe('shell — the recursive flag is what makes an unquoted rm a root wipe', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-rmf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('django scripts/backport.sh — `rm -f ${TMPFILE}` does not fire', async () => {
    write(tmp, 'scripts/backport.sh', DJANGO_BACKPORT);
    const r = await run(tmp);
    assert.deepStrictEqual(unsafeRm(r).map((c) => c.name), [],
      'a non-recursive rm of an empty expansion is "missing operand", not a wipe');
  });

  const RECURSIVE_SPELLINGS = ['rm -rf ${TMPFILE}', 'rm -fr ${TMPFILE}', 'rm -r -f ${TMPFILE}', 'rm -f -r ${TMPFILE}', 'rm --recursive --force ${TMPFILE}', 'rm -Rf ${TMPFILE}'];
  for (const line of RECURSIVE_SPELLINGS) {
    it(`POSITIVE CONTROL — the same line as \`${line}\` still fires at error`, async () => {
      write(tmp, 'scripts/backport.sh', DJANGO_BACKPORT.replace('rm -f ${TMPFILE}', line));
      const r = await run(tmp);
      const hits = unsafeRm(r);
      assert.strictEqual(hits.length, 1, `expected exactly one unsafe-rm for ${line}`);
      assert.strictEqual(hits[0].severity, 'error');
      assert.strictEqual(hits[0].line, 8);
      assert.match(hits[0].message, /\$\{TMPFILE\}/);
    });
  }

  it('the message names the target, and no longer invents an `-rf` that is not in the source', async () => {
    write(tmp, 'a.sh', '#!/bin/bash\nset -e\nrm -f $LOG\nrm -rf $BUILD_DIR\n');
    const r = await run(tmp);
    const hits = unsafeRm(r);
    assert.deepStrictEqual(hits.map((c) => c.line), [4]);
    assert.match(hits[0].message, /\$BUILD_DIR/);
  });

  it('non-recursive long-form flags do not fire either: `rm --force $X`, `rm -fv $X`', async () => {
    write(tmp, 'a.sh', '#!/bin/bash\nset -e\nrm --force $X\nrm -fv $Y\nrm -f -- $Z\n');
    const r = await run(tmp);
    assert.deepStrictEqual(unsafeRm(r), []);
  });

  it('literal root targets still need the recursive flag to be a wipe: `rm -f /` is an error at the shell, not a wipe', async () => {
    write(tmp, 'a.sh', '#!/bin/bash\nset -e\nrm -f /\nrm -rf /\n');
    const r = await run(tmp);
    assert.deepStrictEqual(unsafeRm(r).map((c) => c.line), [4]);
  });
});
