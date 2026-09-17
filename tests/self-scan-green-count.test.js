// self-scan-green-count.test.js
//
// The nightly dogfood self-scan used to count a module "not green" whenever
// ANY check on it had severity 'error' and !passed — even when that check
// was suppressed via .gatetestignore (a deliberately-excluded fixture
// corpus, e.g. benchmarks/bench-target/**). The module's own `errors` field
// (src/core/runner.js) already excludes suppressed findings; this is the
// control pair proving the extracted script uses that field instead of
// recounting checks naively.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { computeGreenCount } = require('../scripts/self-scan-green-count');

describe('computeGreenCount', () => {
  test('a module with zero errors is green', () => {
    const report = { results: [{ module: 'a', errors: 0 }, { module: 'b', errors: 0 }] };
    assert.deepEqual(computeGreenCount(report), { green: 2, scanned: 2 });
  });

  test('a module with a real (non-suppressed) error is not green', () => {
    const report = { results: [{ module: 'a', errors: 1 }, { module: 'b', errors: 0 }] };
    assert.deepEqual(computeGreenCount(report), { green: 1, scanned: 2 });
  });

  // Control pair: `errors` is the module-level field the engine already
  // computes as suppression-aware (ScanResult.errorChecks filters out
  // `suppressed`). A module whose only error-severity check is suppressed
  // reports `errors: 0` and must count as green.
  test('POSITIVE CONTROL: a module whose only error check is .gatetestignore-suppressed counts as green', () => {
    const report = {
      results: [
        {
          module: 'codeQuality',
          errors: 0, // suppressed findings already excluded here by the engine
          suppressedChecks: 5,
          checks: [
            { name: 'x', passed: false, severity: 'error', suppressed: true },
          ],
        },
      ],
    };
    assert.deepEqual(computeGreenCount(report), { green: 1, scanned: 1 });
  });

  test('handles a missing/empty report gracefully', () => {
    assert.deepEqual(computeGreenCount({}), { green: 0, scanned: 0 });
    assert.deepEqual(computeGreenCount({ results: [] }), { green: 0, scanned: 0 });
  });
});
