// =============================================================================
// The badge's flake segment (launch board move 6)
// =============================================================================
// `flake N%` when a flaky-test ledger is on record for the repo, `flake not
// measured` when it is not. The failure this pins: a repo whose tests the
// engine never ran reading as a repo with a 0% flake rate (Doctrine 1 — a
// clean-looking answer produced by not looking).
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { flakeFromResults, flakeSegment } = require('../website/app/lib/flake-badge');

const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'badge', '[owner]', '[repo]', 'route.ts'), 'utf8');

describe('flakeSegment', () => {
  it('a ledger on record: the measured rate', () => {
    const results = [{ name: 'lint', issues: 0 }, { name: 'unitTests', issues: 0, flake: { measured: true, rate: 2.5, flakyTests: 1, tests: 40, runs: 12 } }];
    assert.deepStrictEqual(flakeSegment(results), { text: 'flake 2.5%', measured: true, rate: 2.5 });
  });

  it('reads the ledger from the module entry\'s checks too', () => {
    const results = [{ name: 'unitTests', checks: [{ name: 'unit-tests:flake-ledger', flake: { measured: true, rate: 0, tests: 10, runs: 3 } }] }];
    assert.strictEqual(flakeSegment(results).text, 'flake 0%');
  });

  it('control: no ledger anywhere is "not measured", never 0%', () => {
    assert.deepStrictEqual(flakeSegment([{ name: 'lint', issues: 3 }]), { text: 'flake not measured', measured: false, rate: null });
    assert.strictEqual(flakeSegment(null).text, 'flake not measured');
    assert.strictEqual(flakeSegment([]).text, 'flake not measured');
  });

  it('control: a ledger that says it measured nothing is "not measured"', () => {
    const results = [{ name: 'unitTests', flake: { measured: false, rate: null, reason: 'telemetry consent is off' } }];
    assert.strictEqual(flakeFromResults(results), null);
    assert.strictEqual(flakeSegment(results).text, 'flake not measured');
  });

  it('control: junk is not a measurement', () => {
    for (const rate of [-1, 101, NaN, '3', null]) {
      assert.strictEqual(flakeSegment([{ flake: { measured: true, rate } }]).measured, false, String(rate));
    }
  });

  it('a tiny non-zero rate does not round down to a clean-looking 0%', () => {
    assert.strictEqual(flakeSegment([{ flake: { measured: true, rate: 0.04 } }]).text, 'flake <0.1%');
  });
});

describe('the badge route', () => {
  it('renders the flake segment last and names it in the accessible label', () => {
    assert.match(ROUTE, /import \{ flakeSegment \} from "@\/app\/lib\/flake-badge"/);
    assert.match(ROUTE, /\{ text: flake\.text, bg: flake\.measured \? SLATE : GREY \}/);
    assert.match(ROUTE, /\$\{issuesText\}, \$\{flake\.text\}/);
  });

  it('no red / orange / amber / yellow hue in what this change added', () => {
    const added = ROUTE.split('\n').filter((l) => /flake/.test(l)).join('\n');
    assert.doesNotMatch(added, /\b(?:red|orange|amber|yellow)-\d{2,3}\b/);
  });
});
