'use strict';
/**
 * scripts/run-tests.js — the runner that cannot report success while doing
 * nothing. Control pairs: a passing file passes; a failing file fails the
 * suite with its `not ok` shown; a file that leaks a timer still finishes
 * (the runner ends it after the summary — this is what --test-force-exit
 * was for, and where it dropped tests); a file that exits before its summary
 * is a FAILURE, not a silent zero; a file with no tests is a failure.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.js');
let root;
function write(rel, body) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; }
function run(files, extra = []) {
  const r = spawnSync(process.execPath, [RUNNER, '--timeout', '5000', '--file-timeout', '20000', ...extra, ...files], { cwd: root, encoding: 'utf-8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const line = (out, key) => { const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(out); return m ? Number(m[1]) : null; };
// The runner's own wall clock for the whole run — asserting on it instead
// of a clock read in this file keeps the "did not hang" bound honest without
// a fake timer, which would defeat a test about real child processes.
const seconds = (out) => { const m = /^# duration_s ([\d.]+)$/m.exec(out); return m ? Number(m[1]) : Infinity; };

describe('scripts/run-tests.js — every file must report its summary', () => {
  let passing, failing, leaking, exiting, empty;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-runner-'));
    passing = write('t/pass.test.js', "const { test } = require('node:test'); const assert = require('node:assert');\ntest('one', () => assert.ok(true));\ntest('two', () => assert.ok(true));\n");
    failing = write('t/fail.test.js', "const { test } = require('node:test'); const assert = require('node:assert');\ntest('good', () => assert.ok(true));\ntest('bad', () => assert.strictEqual(1, 2));\n");
    // A leaked interval keeps the child's event loop alive. Node <=22 then
    // cancels the file itself after --test-timeout and prints the summary,
    // and the runner ends the child after it. Node 24 bounds only the tests
    // INSIDE the file (measured 2026-09-14: no summary, ever), so the file
    // runs into the runner's file timeout — where the runner ends the TEST
    // process and reads the summary the parent then prints, green test
    // included. The assertions below are the contract both paths meet.
    leaking = write('t/leak.test.js', "const { test } = require('node:test'); const assert = require('node:assert');\nsetInterval(() => {}, 1000);\ntest('leaky but green', () => assert.ok(true));\n");
    // A file still running at the runner's file timeout (a test that never
    // ends, with --test-timeout too long to catch it). The runner ends the
    // TEST process and reads the summary its parent then prints — the file
    // failed, the tests before it counted — or, if the parent prints nothing
    // either, reports the file as NOT finished. Both are the failure that
    // --test-force-exit produced silently from the other side (it exited the
    // parent early and counted what it had, exit 0).
    exiting = write('t/hang.test.js', "const { test } = require('node:test');\ntest('first', () => {});\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 30000)); });\n");
    // Node reports the file ITSELF as its one passing test (`ok 1 - <path>`),
    // and the TAP reporter escapes the path's backslashes on Windows — the
    // runner has to unescape before it can tell that entry from a real test.
    empty = write('t/empty.test.js', "'use strict';\nmodule.exports = 1;\n");
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('POSITIVE CONTROL — a passing file: exit 0, its tests counted, SUITE: PASSED', () => {
    const { code, out } = run([passing]);
    assert.strictEqual(code, 0, out);
    assert.strictEqual(line(out, 'tests'), 2);
    assert.strictEqual(line(out, 'pass'), 2);
    assert.match(out, /SUITE: PASSED/);
  });

  it('a failing file fails the suite and its `not ok` is shown', () => {
    const { code, out } = run([passing, failing]);
    assert.strictEqual(code, 1, out);
    assert.strictEqual(line(out, 'fail'), 1);
    assert.match(out, /not ok 2 - bad/);
    assert.match(out, /SUITE: FAILED — 1 of 2 file\(s\)/);
  });

  it('a file that leaks a timer is a failure with the leak named, its green test still counted, and the runner does not hang on it', () => {
    // --test-timeout 5 s is where Node <=22 cancels the file; the 8 s file
    // timeout is where the runner steps in on Node 24. Either way the
    // leaked interval (alive for ever) is not waited on.
    const { code, out } = run([leaking], ['--file-timeout', '8000']);
    assert.strictEqual(code, 1, out);
    assert.strictEqual(line(out, 'pass'), 1, 'the green test inside it is still counted');
    assert.strictEqual(line(out, 'fail') + line(out, 'cancelled'), 1, 'the file itself is the one failure');
    assert.strictEqual(line(out, 'files that did not finish'), 0, 'its summary was read');
    assert.match(out, /leaked timer, socket or child/);
    assert.ok(seconds(out) < 15, `must not wait for the leaked interval (${seconds(out)} s)`);
  });

  it('NEGATIVE CONTROL — a file still running at the file timeout is a failure, not a silent partial count', () => {
    const { code, out } = run([passing, exiting], ['--timeout', '60000', '--file-timeout', '3000']);
    assert.strictEqual(code, 1, out);
    assert.match(out, /hang\.test\.js: (did not finish within the file timeout|.*still running at the file timeout)/);
    assert.doesNotMatch(out, /SUITE: PASSED/);
    // Whichever way it was reported, the file is either uncounted and said
    // so, or counted with itself as the failure — never a green partial.
    const unfinished = line(out, 'files that did not finish');
    assert.ok(unfinished === 1 || line(out, 'fail') + line(out, 'cancelled') >= 1, out);
    assert.strictEqual(line(out, 'pass') <= 3, true, 'the test that never ended is not a pass');
    assert.ok(seconds(out) < 20, `ended at the file timeout (${seconds(out)} s)`);
  });

  it('a file that reports zero tests is a failure', () => {
    const { code, out } = run([empty]);
    assert.strictEqual(code, 1, out);
    assert.match(out, /reported zero tests/);
  });
});
