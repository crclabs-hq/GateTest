'use strict';

// website/app/lib/rule-noise.js — the leaderboard maths (the Fifty, move 07),
// pure so it runs without a database.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateRuleNoise, candidatesForRetirement, noisePublication, MIN_SCANS, MIN_FINDINGS_FLOOR,
} = require('../website/app/lib/rule-noise');
const { ruleIdentity } = require('../src/core/rule-identity');

const row = (rules) => ({ ts: '2026-09-05T00:00:00Z', rules });

test('silenced rate is silenced over everything the rule produced; scan rate is scans that silenced it', () => {
  const rows = [
    row([{ id: 'a:x', fired: 3, silenced: 1 }]),
    row([{ id: 'a:x', fired: 0, silenced: 2 }, { id: 'b:y', fired: 5, silenced: 0 }]),
    row([{ id: 'a:x', fired: 4, silenced: 0 }]),
  ];
  const agg = aggregateRuleNoise(rows, { minScans: 1 });
  assert.equal(agg.scans, 3);
  const ax = agg.rules.find((r) => r.id === 'a:x');
  assert.deepEqual({ ...ax }, { id: 'a:x', module: 'a', scans: 3, scansSilenced: 2, fired: 7, silenced: 3, silencedRate: 0.3, silencedScanRate: 2 / 3, thin: false });
  assert.equal(agg.rules.find((r) => r.id === 'b:y').silencedRate, 0);
});

test('worst first; a rule below MIN_SCANS is thin and ranked last however bad it looks', () => {
  const rows = [
    ...Array.from({ length: MIN_SCANS }, () => row([{ id: 'ok:rule', fired: 10, silenced: 0 }, { id: 'noisy:rule', fired: 1, silenced: 1 }])),
    row([{ id: 'seen:once', fired: 0, silenced: 9 }]),
  ];
  const agg = aggregateRuleNoise(rows);
  assert.deepEqual(agg.rules.map((r) => r.id), ['noisy:rule', 'ok:rule', 'seen:once']);
  assert.equal(agg.rules[2].thin, true);
  assert.equal(agg.rules[2].silencedRate, 1);
});

test('rows without rules, entries with nothing counted, and malformed entries are ignored', () => {
  const agg = aggregateRuleNoise([row([]), row(null), { ts: 't' }, row([{ id: 'z:z', fired: 0, silenced: 0 }, { fired: 1 }, null])]);
  assert.equal(agg.scans, 1, 'a row counts as a scan only when it carries rules');
  assert.deepEqual(agg.rules, []);
});

test('candidatesForRetirement: over 20%, not thin (the Fifty, move 08)', () => {
  const rows = Array.from({ length: MIN_SCANS }, () => row([
    { id: 'retire:me', fired: 3, silenced: 2 }, { id: 'keep:me', fired: 9, silenced: 1 },
  ]));
  rows.push(row([{ id: 'thin:one', fired: 0, silenced: 5 }]));
  const agg = aggregateRuleNoise(rows);
  assert.deepEqual(candidatesForRetirement(agg).map((r) => r.id), ['retire:me']);
});

test('noisePublication: candidate needs BOTH the rate line and the sample-size floor (the Fifty, move 08)', () => {
  const rows = Array.from({ length: MIN_SCANS }, () => row([
    { id: 'retire:me', fired: 13, silenced: 7 }, // -> 100 total, 35% silenced: over rate, over floor
    { id: 'keep:me', fired: 45, silenced: 5 },   // -> 250 total, 10% silenced: under rate
    { id: 'too:thin', fired: 3, silenced: 2 },   // -> 25 total, 40% silenced: over rate, UNDER the floor
  ]));
  const agg = aggregateRuleNoise(rows);
  const table = noisePublication(agg);
  const byId = Object.fromEntries(table.map((r) => [r.id, r]));

  assert.equal(byId['retire:me'].sampleSize, 100);
  assert.equal(byId['retire:me'].silencedRate, 0.35);
  assert.equal(byId['retire:me'].candidate, true);

  assert.equal(byId['keep:me'].candidate, false, 'below the retirement rate is untouched');

  assert.equal(byId['too:thin'].sampleSize, 25);
  assert.ok(byId['too:thin'].sampleSize < MIN_FINDINGS_FLOOR);
  assert.equal(byId['too:thin'].candidate, false, 'noisy-looking but not enough samples to trust the rate');

  // Worst-first by silenced rate, independent of candidate status — a rule
  // below the floor is still shown, just not flagged for demotion.
  assert.equal(table[0].id, 'too:thin');
  assert.equal(table[1].id, 'retire:me');
});

test('rule identity has one home: the runner re-exports src/core/rule-identity.js', () => {
  const { _ruleIdentity } = require('../src/core/runner');
  assert.equal(_ruleIdentity, ruleIdentity);
  assert.equal(ruleIdentity({ name: 'hardcoded-url:localhost:src/cfg.js:12', file: 'src/cfg.js' }), 'hardcoded-url:localhost');
});
