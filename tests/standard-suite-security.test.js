/**
 * Standard suite ships security — control pair (move 1, launch-board,
 * 2026-09-25, closes complaint C16).
 *
 * Before this move, `security` (injection / XSS / auth-bypass / SSRF-style
 * probes — src/modules/security.js) only ran in `full`/`nuclear`. `standard`
 * is the CLI default (bin/gatetest.js), so a plain `gatetest` on OWASP
 * NodeGoat passed the exact injections it was built to find (2026-09-14
 * audit). The fix moved `security` into `standard`; `quick` (the sub-10s
 * pre-commit suite) deliberately still excludes it, and that omission is
 * disclosed via SUITE_DEFERRALS rather than silent (Doctrine #1 / #6).
 *
 * The control pair: the suite that must run it, and the suite that must
 * not — both asserted here so a future edit that flips either one fails
 * loudly instead of quietly regressing the complaint this move closed.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { GateTestConfig } = require('../src/core/config');

const REPO = path.resolve(__dirname, '..');
const config = new GateTestConfig(REPO);

test('positive control: standard includes security', () => {
  assert.ok(
    config.getSuite('standard').includes('security'),
    'standard must run the OWASP security module — this is the CLI default suite (bin/gatetest.js)',
  );
});

test('negative control: quick does not include security', () => {
  assert.ok(
    !config.getSuite('quick').includes('security'),
    'quick is the sub-10s pre-commit suite; security re-reads every source file several times and does not fit',
  );
});

test('quick\'s deferral names security, with a reason and where it runs instead', () => {
  const deferrals = config.getSuiteDeferrals('quick');
  const entry = deferrals.find((d) => d.module === 'security');
  assert.ok(entry, 'quick must declare a SUITE_DEFERRALS entry for security — an undisclosed omission is Forbidden #16');
  assert.ok(entry.reason && entry.reason.length > 10, 'the deferral needs a real reason');
  assert.match(entry.runsIn, /standard/, 'the deferral must say security runs in standard');
});

test('end-to-end: a quick-suite run carries the security deferral on its summary', async () => {
  // Same pattern as tests/suite-deferrals.test.js's full-suite plumbing
  // check — skip every module except one trivial one so this stays a fast
  // unit test; what is being verified is that the deferral list survives
  // config -> runSuite -> runner summary for `quick`, not the modules
  // themselves.
  const { GateTest } = require('../src/index.js');
  const gt = new GateTest(REPO, { silent: true, quiet: true });
  await gt.init();
  const summary = await gt.runSuite('quick', {
    skipModules: config.getSuite('quick').filter((m) => m !== 'memory'),
  });
  assert.ok(Array.isArray(summary.deferred), 'summary.deferred must always be an array');
  assert.ok(
    summary.deferred.some((d) => d.module === 'security'),
    'a quick-suite summary must disclose that security did not run',
  );
});
