/**
 * Suite deferrals — a module dropped from a suite must never be dropped
 * silently, and must never be dropped entirely.
 *
 * Background (2026-09-04): `--suite full` took 158.6s on this repo, of which
 * 58.7s was the `mutation` module re-running the whole 7559-test suite as a
 * baseline and then reporting a single "cannot measure" info line. Mutation
 * left the `full` suite for a nightly workflow. These tests exist so that
 * move stays honest: the omission is disclosed to the user, the module still
 * runs somewhere, and the workflow that runs it still exists.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GateTestConfig, SUITE_DEFERRALS } = require('../src/core/config');

const REPO = path.resolve(__dirname, '..');
const config = new GateTestConfig(REPO);

test('every deferred module is genuinely absent from the suite that defers it', () => {
  for (const [suiteName, deferrals] of Object.entries(SUITE_DEFERRALS)) {
    const suite = config.getSuite(suiteName);
    for (const d of deferrals) {
      assert.ok(
        !suite.includes(d.module),
        `${suiteName} declares "${d.module}" deferred but still runs it — the notice would be a lie`,
      );
    }
  }
});

test('every deferred module still runs in at least one other suite', () => {
  // Without this, SUITE_DEFERRALS becomes a way to quietly retire a module:
  // "deferred" with nowhere to defer TO is deletion with a nicer word.
  const allSuites = Object.keys(config.config.suites);
  for (const [suiteName, deferrals] of Object.entries(SUITE_DEFERRALS)) {
    for (const d of deferrals) {
      const homes = allSuites.filter((s) => config.getSuite(s).includes(d.module));
      assert.ok(
        homes.length > 0,
        `${suiteName} defers "${d.module}" but no suite runs it — that is a silent coverage cut, not a deferral`,
      );
    }
  }
});

test('every deferral states a reason and where the work runs instead', () => {
  for (const [suiteName, deferrals] of Object.entries(SUITE_DEFERRALS)) {
    assert.ok(Array.isArray(deferrals), `${suiteName} deferrals must be an array`);
    for (const d of deferrals) {
      assert.ok(d.module && typeof d.module === 'string', 'deferral needs a module name');
      assert.ok(d.reason && d.reason.length > 10, `${d.module}: needs a real reason, got "${d.reason}"`);
      assert.ok(d.runsIn && d.runsIn.length > 5, `${d.module}: needs to say where it runs instead`);
    }
  }
});

test('getSuiteDeferrals returns an array for suites that defer nothing', () => {
  assert.deepEqual(config.getSuiteDeferrals('standard'), []);
  assert.deepEqual(config.getSuiteDeferrals('nope-not-a-suite'), []);
});

test('quick defers security — the sub-10s pre-commit bar (move 1, launch-board, 2026-09-25)', () => {
  const deferred = config.getSuiteDeferrals('quick').map((d) => d.module);
  assert.ok(
    deferred.includes('security'),
    'quick must disclose that it does not run the OWASP security module',
  );
  assert.ok(
    !config.getSuite('quick').includes('security'),
    'suites.quick must not contain security',
  );
});

test('security runs in standard — the CLI default suite (closes complaint C16)', () => {
  assert.ok(
    config.getSuite('standard').includes('security'),
    'standard must include security so the CLI default catches OWASP-class findings',
  );
});

test('the full suite defers mutation — the 60s interactive bar (CLAUDE.md §9)', () => {
  const deferred = config.getSuiteDeferrals('full').map((d) => d.module);
  assert.ok(
    deferred.includes('mutation'),
    'mutation must stay out of the interactive full suite — it re-runs the whole test suite per mutant',
  );
  assert.ok(
    !config.getSuite('full').includes('mutation'),
    'suites.full must not contain mutation',
  );
  // The README has always sold the $99 Full Scan as 88 modules with mutation
  // + chaos running via the Action instead. The code now matches the copy.
  assert.equal(config.getSuite('full').length, 88, 'suites.full is the 88 modules the README advertises');
});

test('mutation still runs in the nuclear suite (the CI/Action path)', () => {
  assert.ok(
    config.getSuite('nuclear').includes('mutation'),
    'nuclear runs on a CI runner where a full mutation pass is affordable — it must keep mutation',
  );
});

test('the nightly workflow that actually runs mutation exists and is uncapped', () => {
  const wf = path.join(REPO, '.github', 'workflows', 'mutation-nightly.yml');
  assert.ok(fs.existsSync(wf), 'mutation must have a home now that it left the full suite');
  const src = fs.readFileSync(wf, 'utf8');
  assert.match(src, /--module mutation/, 'the nightly must actually invoke the mutation module');
  assert.match(src, /schedule:/, 'the nightly must be scheduled, not workflow_dispatch-only');
  assert.match(src, /maxMutants/, 'the nightly must raise the interactive mutant cap');
});

test('the console reporter discloses deferrals next to the module count', () => {
  const src = fs.readFileSync(
    path.join(REPO, 'src', 'reporters', 'console-reporter.js'),
    'utf8',
  );
  assert.match(
    src,
    /summary\.deferred/,
    'the console summary must print summary.deferred — an undisclosed omission is Forbidden #16',
  );
});

test('a full-suite run carries the deferrals on its summary', async () => {
  // The end-to-end wire: config → runSuite → runner summary. Run a
  // single cheap module so this stays a fast unit test; what is being
  // checked is that the deferral list survives the plumbing.
  const { GateTest } = require('../src/index.js');
  const gt = new GateTest(REPO, { silent: true, quiet: true });
  await gt.init();
  const summary = await gt.runSuite('full', {
    // Skip everything except one trivial module — we are testing plumbing,
    // not the engine.
    skipModules: config.getSuite('full').filter((m) => m !== 'openapiDrift'),
  });
  assert.ok(Array.isArray(summary.deferred), 'summary.deferred must always be an array');
  assert.deepEqual(
    summary.deferred.map((d) => d.module),
    ['mutation'],
    'a full-suite summary must name what it did not run',
  );
});
