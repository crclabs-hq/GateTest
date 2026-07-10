'use strict';

// =============================================================================
// noise-model — flywheel-learned per-module confidence penalties + report.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const noise = require('../src/core/noise-model');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-noise-'));
  fs.mkdirSync(path.join(root, '.gatetest', 'memory'), { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeMemory(modules) {
  fs.writeFileSync(path.join(root, '.gatetest', 'memory.json'), JSON.stringify({ version: 2, modules }));
}
function writeFalsePositives(map) {
  fs.writeFileSync(path.join(root, '.gatetest', 'memory', 'false-positives.json'), JSON.stringify(map));
}

describe('noise-model — computePenalties', () => {
  it('no penalty without enough runs', () => {
    writeMemory({ secrets: { runs: 2, fires: 2, fireRate: 1, suppressions: 9 } });
    assert.deepEqual(noise.computePenalties(root), {});
  });

  it('no penalty without enough dismissals', () => {
    writeMemory({ secrets: { runs: 20, fires: 18, fireRate: 0.9, suppressions: 1 } });
    assert.deepEqual(noise.computePenalties(root), {});
  });

  it('no penalty when fire-rate is low even if dismissed', () => {
    writeMemory({ secrets: { runs: 20, fires: 2, fireRate: 0.1, suppressions: 9 } });
    assert.deepEqual(noise.computePenalties(root), {});
  });

  it('penalizes a high-fire, repeatedly-dismissed module', () => {
    writeMemory({ secrets: { runs: 20, fires: 18, fireRate: 0.9, suppressions: 8 } });
    const p = noise.computePenalties(root);
    assert.ok(p.secrets < 1 && p.secrets >= 0.5, `expected softening, got ${p.secrets}`);
  });

  it('more dismissals → stronger (lower, floored) penalty', () => {
    writeMemory({ a: { runs: 20, fires: 18, fireRate: 0.9, suppressions: 4 },
                  b: { runs: 20, fires: 18, fireRate: 0.9, suppressions: 50 } });
    const p = noise.computePenalties(root);
    assert.ok(p.b <= p.a, `b (${p.b}) should be <= a (${p.a})`);
    assert.ok(p.b >= 0.5, 'penalty is floored at 0.5');
  });

  it('counts dismissals from false-positives.json too', () => {
    writeMemory({ secrets: { runs: 20, fires: 18, fireRate: 0.9, suppressions: 0 } });
    writeFalsePositives({
      'secrets:apiKey:a.js:1': { reason: 'fp' },
      'secrets:apiKey:b.js:2': { reason: 'fp' },
      'secrets:token:c.js:3': { reason: 'fp' },
    });
    const p = noise.computePenalties(root);
    assert.ok(p.secrets < 1, 'false-positives.json dismissals should drive the penalty');
  });
});

describe('noise-model — getNoiseReport', () => {
  it('ranks penalized modules first', () => {
    writeMemory({
      quiet: { runs: 20, fires: 1, fireRate: 0.05, suppressions: 0 },
      noisy: { runs: 20, fires: 19, fireRate: 0.95, suppressions: 10 },
    });
    const rows = noise.getNoiseReport(root);
    assert.equal(rows[0].module, 'noisy');
    assert.equal(rows[0].noisy, true);
    assert.equal(rows.find((r) => r.module === 'quiet').noisy, false);
  });

  it('empty history yields an empty report, never throws', () => {
    assert.deepEqual(noise.getNoiseReport(root), []);
  });
});
