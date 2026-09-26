'use strict';

// =============================================================================
// Per-rule precision aggregate (the Fifty, move 02) — /precision "By rule"
// =============================================================================
// scripts/real-world-precision.js writes rules[] into website/app/data/
// precision.json from the same corpus run as repos[]. This is the control
// pair for: the aggregate function, the control-pair marker convention
// (src/core/control-pairs.js), the module-registry check, and the page's use
// of the generated data (no rendered number typed by hand).
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { aggregateRulesByCorpus } = require(path.join(ROOT, 'scripts', 'real-world-precision.js'));
const { controlPairCounts, MARKER_RE } = require(path.join(ROOT, 'src', 'core', 'control-pairs.js'));
const { BUILT_IN_MODULES } = require(path.join(ROOT, 'src', 'core', 'registry.js'));
const { sortRules } = require(path.join(ROOT, 'website', 'app', 'lib', 'precision-rules.js'));

const JSON_PATH = path.join(ROOT, 'website', 'app', 'data', 'precision.json');
const PAGE_PATH = path.join(ROOT, 'website', 'app', 'precision', 'page.tsx');
const RULE_TABLE_PATH = path.join(ROOT, 'website', 'app', 'precision', 'RuleTable.tsx');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'dogfood-nightly.yml');

describe('control-pairs.js — the marker convention', () => {
  it('the counter finds a known test (issue #633, tagged // control-pair: secrets)', () => {
    const counts = controlPairCounts(path.join(ROOT, 'tests'));
    assert.ok((counts.get('secrets') || 0) >= 1, 'expected at least one "// control-pair: secrets" marker under tests/');
  });

  it('the marker in tests/secrets.test.js matches the documented regex', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tests', 'secrets.test.js'), 'utf8');
    const matches = [...src.matchAll(MARKER_RE)];
    assert.ok(matches.some((m) => m[1] === 'secrets'), 'tests/secrets.test.js must carry the "secrets" control-pair marker');
  });

  it('an empty or missing tests directory yields no counts, never a throw', () => {
    const counts = controlPairCounts(path.join(ROOT, 'this-directory-does-not-exist'));
    assert.strictEqual(counts.size, 0);
  });
});

describe('aggregateRulesByCorpus — groups the same findings repos[] already carries', () => {
  const manifest = {
    repos: [
      { name: 'express', sha: 'sha-express', maxBlocking: 0 },
      { name: 'flask', sha: 'sha-flask', maxBlocking: 2 },
      { name: 'NodeGoat', sha: 'sha-nodegoat', minBlocking: 40 },
    ],
  };
  const allFindings = [
    {
      name: 'express',
      findings: [
        { rule: 'secrets', confidence: 1, module: 'secrets' },
        { rule: 'secrets', confidence: 0.4, module: 'secrets' },
        { rule: 'python:eval', confidence: 1, module: 'python' },
      ],
    },
    { name: 'flask', findings: [{ rule: 'python:eval', confidence: 1, module: 'python' }] },
    { name: 'NodeGoat', findings: null }, // not measured this run
  ];
  const controlPairsByRule = new Map([['secrets', 3]]);
  const rules = aggregateRulesByCorpus(allFindings, manifest, controlPairsByRule);

  it('sums findings per rule across repos, sorted worst-first', () => {
    assert.deepEqual(rules.map((r) => [r.rule, r.findings]), [['secrets', 2], ['python:eval', 2]]);
  });

  it('counts findings on zero-ceiling repos only', () => {
    const secrets = rules.find((r) => r.rule === 'secrets');
    assert.strictEqual(secrets.onZeroCeilingRepos, 2, 'both secrets findings were on express (ceiling 0)');
    const pythonEval = rules.find((r) => r.rule === 'python:eval');
    assert.strictEqual(pythonEval.onZeroCeilingRepos, 1, 'only the express finding was on a zero-ceiling repo');
  });

  it('carries the module and the repo/sha the finding was seen on, deduplicated', () => {
    const secrets = rules.find((r) => r.rule === 'secrets');
    assert.strictEqual(secrets.module, 'secrets');
    assert.deepEqual(secrets.repos, [{ name: 'express', sha: 'sha-express' }]);
  });

  it('reads controlPairs from the injected counter, defaulting to 0', () => {
    assert.strictEqual(rules.find((r) => r.rule === 'secrets').controlPairs, 3);
    assert.strictEqual(rules.find((r) => r.rule === 'python:eval').controlPairs, 0);
  });

  it('never includes a repo whose findings were not measured this run', () => {
    for (const r of rules) assert.ok(!r.repos.some((repo) => repo.name === 'NodeGoat'));
  });

  it('every module on a fixture rule row is a module the registry actually loads', () => {
    for (const r of rules) assert.ok(r.module === null || Object.prototype.hasOwnProperty.call(BUILT_IN_MODULES, r.module));
  });
});

describe('website/app/lib/precision-rules.js — sortRules', () => {
  const fixture = [
    { rule: 'b:rule', module: 'b', findings: 5, onZeroCeilingRepos: 0, controlPairs: 1, repos: [] },
    { rule: 'a:rule', module: 'a', findings: 5, onZeroCeilingRepos: 2, controlPairs: 0, repos: [] },
    { rule: 'c:rule', module: 'c', findings: 1, onZeroCeilingRepos: 1, controlPairs: 2, repos: [] },
  ];

  it('sorts descending by default, tying on findings breaks by rule name', () => {
    assert.deepEqual(sortRules(fixture).map((r) => r.rule), ['a:rule', 'b:rule', 'c:rule']);
  });

  it('sorts ascending when asked', () => {
    assert.deepEqual(sortRules(fixture, 'findings', 'asc').map((r) => r.rule), ['c:rule', 'a:rule', 'b:rule']);
  });

  it('sorts by a different column', () => {
    assert.deepEqual(sortRules(fixture, 'controlPairs', 'desc').map((r) => r.rule), ['c:rule', 'b:rule', 'a:rule']);
  });

  it('does not mutate its input', () => {
    const before = fixture.map((r) => r.rule);
    sortRules(fixture, 'onZeroCeilingRepos', 'asc');
    assert.deepEqual(fixture.map((r) => r.rule), before);
  });
});

describe('precision.json — rules[] present (empty-but-present awaits the nightly)', () => {
  const page = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  it('carries a rules array, never an absent key', () => {
    assert.ok(Array.isArray(page.rules), 'rules[] must be present, even if empty, per the Sync Rule');
  });

  it('says why it is empty, if it is', () => {
    if (page.rules.length === 0) assert.match(page.rulesNote || '', /nightly/i);
  });

  it('every populated row has a module the registry loads, and repos present in repos[]', () => {
    const repoNames = new Set(page.repos.map((r) => r.name));
    for (const r of page.rules) {
      assert.ok(r.module === null || Object.prototype.hasOwnProperty.call(BUILT_IN_MODULES, r.module), `unknown module "${r.module}" for rule "${r.rule}"`);
      for (const repo of r.repos || []) assert.ok(repoNames.has(repo.name), `rule "${r.rule}" cites repo "${repo.name}" not in repos[]`);
    }
  });
});

describe('/precision — the "By rule" section renders the generated table, never a typed number', () => {
  const src = fs.readFileSync(PAGE_PATH, 'utf8');

  it('imports the rule table and reads precision.rules / rulesNote', () => {
    assert.match(src, /from "\.\/RuleTable"/);
    assert.match(src, /precision as \{ rules\?/);
    assert.match(src, /rulesNote/);
  });

  it('has the "By rule" heading', () => {
    assert.match(src, /By rule/);
  });

  it('states the regeneration cadence honestly — nightly, not on every merge', () => {
    assert.match(src, /nightly corpus run/i);
    assert.match(src, /not on every merge/i);
  });

  it('the nightly workflow this sentence cites actually runs on a schedule, not per merge (it must not gain a push/pull_request trigger without this test being revisited)', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.match(workflow, /schedule:/);
    assert.doesNotMatch(workflow, /^\s*(push|pull_request):/m, 'dogfood-nightly.yml gained a per-merge trigger — update the /precision sentence too');
  });
});

describe('RuleTable.tsx — sortable client component over the generated rows', () => {
  it('is a client component that sorts via the shared pure sortRules', () => {
    const src = fs.readFileSync(RULE_TABLE_PATH, 'utf8');
    assert.match(src, /"use client"/);
    assert.match(src, /from "\.\.\/lib\/precision-rules"/);
    assert.match(src, /sortRules/);
  });
});
