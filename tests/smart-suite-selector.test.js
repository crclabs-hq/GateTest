'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  selectModules,
  getChangedFiles,
  computeSmartSuite,
  BASELINE_MODULES,
  AFFINITY_RULES,
} = require('../src/core/smart-suite-selector');

// ── AFFINITY_RULES shape ──────────────────────────────────────────────────────

test('AFFINITY_RULES is a non-empty array', () => {
  assert.ok(Array.isArray(AFFINITY_RULES) && AFFINITY_RULES.length > 0);
});

test('every AFFINITY_RULE has test (RegExp), modules (string[]), and weight (number)', () => {
  for (const rule of AFFINITY_RULES) {
    assert.ok(rule.test instanceof RegExp, `rule.test must be RegExp: ${JSON.stringify(rule)}`);
    assert.ok(Array.isArray(rule.modules) && rule.modules.length > 0, 'rule.modules must be non-empty array');
    assert.ok(typeof rule.weight === 'number' && rule.weight > 0, 'rule.weight must be positive number');
  }
});

// ── BASELINE_MODULES ──────────────────────────────────────────────────────────

test('BASELINE_MODULES is a non-empty array', () => {
  assert.ok(Array.isArray(BASELINE_MODULES) && BASELINE_MODULES.length > 0);
});

test('BASELINE_MODULES always included in selectModules output', () => {
  const result = selectModules(['src/foo.ts']);
  for (const b of BASELINE_MODULES) {
    assert.ok(result.includes(b), `baseline module "${b}" missing from result`);
  }
});

test('BASELINE_MODULES present even when file list is empty', () => {
  const result = selectModules([]);
  for (const b of BASELINE_MODULES) {
    assert.ok(result.includes(b), `baseline module "${b}" missing for empty file list`);
  }
});

// ── selectModules — relevance scoring ────────────────────────────────────────

test('auth file triggers cookieSecurity, tlsSecurity, crossFileTaint', () => {
  const modules = selectModules(['src/middleware/auth.ts']);
  assert.ok(modules.includes('cookieSecurity'), 'missing cookieSecurity');
  assert.ok(modules.includes('tlsSecurity'),    'missing tlsSecurity');
  assert.ok(modules.includes('crossFileTaint'), 'missing crossFileTaint');
});

test('api route file triggers ssrf, asyncIteration, nPlusOne', () => {
  const modules = selectModules(['website/app/api/scan/run/route.ts']);
  assert.ok(modules.includes('ssrf'),           'missing ssrf');
  assert.ok(modules.includes('asyncIteration'), 'missing asyncIteration');
  assert.ok(modules.includes('nPlusOne'),       'missing nPlusOne');
});

test('Dockerfile triggers dockerfile, shell modules', () => {
  const modules = selectModules(['Dockerfile']);
  assert.ok(modules.includes('dockerfile'), 'missing dockerfile');
  assert.ok(modules.includes('shell'),      'missing shell');
});

test('SQL migration file triggers sqlMigrations, raceCondition', () => {
  const modules = selectModules(['db/migrations/0042_add_users.sql']);
  assert.ok(modules.includes('sqlMigrations'), 'missing sqlMigrations');
  assert.ok(modules.includes('raceCondition'), 'missing raceCondition');
});

test('money/payment file triggers moneyFloat', () => {
  const modules = selectModules(['src/services/payment-processor.ts']);
  assert.ok(modules.includes('moneyFloat'), 'missing moneyFloat');
});

test('GitHub Actions workflow triggers ciSecurity, cronExpression', () => {
  const modules = selectModules(['.github/workflows/deploy.yml']);
  assert.ok(modules.includes('ciSecurity'),    'missing ciSecurity');
  assert.ok(modules.includes('cronExpression'), 'missing cronExpression');
});

test('test file triggers flakyTests', () => {
  const modules = selectModules(['tests/auth.test.js']);
  assert.ok(modules.includes('flakyTests'), 'missing flakyTests');
});

test('Terraform file triggers terraform module', () => {
  const modules = selectModules(['infra/main.tf']);
  assert.ok(modules.includes('terraform'), 'missing terraform');
});

test('Python file triggers python, datetimeBug', () => {
  const modules = selectModules(['scripts/processor.py']);
  assert.ok(modules.includes('python'),      'missing python');
  assert.ok(modules.includes('datetimeBug'), 'missing datetimeBug');
});

test('cron/scheduler file triggers cronExpression, datetimeBug', () => {
  const modules = selectModules(['src/jobs/email-cron.ts']);
  assert.ok(modules.includes('cronExpression'), 'missing cronExpression');
  assert.ok(modules.includes('datetimeBug'),    'missing datetimeBug');
});

test('AI/LLM integration file triggers promptSafety, secrets', () => {
  const modules = selectModules(['src/lib/openai-client.ts']);
  assert.ok(modules.includes('promptSafety'), 'missing promptSafety');
  assert.ok(modules.includes('secrets'),      'missing secrets');
});

// ── selectModules — output shape ──────────────────────────────────────────────

test('selectModules returns an array of strings', () => {
  const result = selectModules(['src/app.ts', 'README.md']);
  assert.ok(Array.isArray(result));
  assert.ok(result.every(m => typeof m === 'string'));
});

test('selectModules respects the max option', () => {
  // Feed many different file types to score many modules
  const files = [
    'src/auth.ts', '.github/workflows/ci.yml', 'Dockerfile',
    'db/migrations/001.sql', 'src/payment.ts', 'src/cron.ts',
    'src/api/routes.ts', 'tsconfig.json', 'src/logger.ts',
  ];
  const result = selectModules(files, { max: 5 });
  // 5 dynamic + 3 baseline = 8 max
  assert.ok(result.length <= BASELINE_MODULES.length + 5);
});

test('selectModules returns baseline even with max: 0', () => {
  const result = selectModules(['src/auth.ts'], { max: 0 });
  assert.ok(result.length >= BASELINE_MODULES.length);
  for (const b of BASELINE_MODULES) assert.ok(result.includes(b));
});

test('selectModules never duplicates module names', () => {
  const files = ['src/auth.ts', 'src/api/route.ts', 'src/middleware/auth.ts'];
  const result = selectModules(files);
  const seen = new Set();
  for (const m of result) {
    assert.ok(!seen.has(m), `duplicate module: ${m}`);
    seen.add(m);
  }
});

// ── computeSmartSuite ─────────────────────────────────────────────────────────

test('computeSmartSuite with files array returns modules and selectionReason', () => {
  const result = computeSmartSuite({
    projectRoot: '/tmp',
    files: ['src/auth.ts', 'src/api/route.ts'],
  });
  assert.ok(Array.isArray(result.modules), 'modules must be array');
  assert.ok(typeof result.selectionReason === 'string', 'selectionReason must be string');
  assert.ok(result.changedFiles.length === 2);
});

test('computeSmartSuite with no files returns null modules and no-diff reason', () => {
  // Override getChangedFiles by providing an empty files array
  const result = computeSmartSuite({ projectRoot: '/nonexistent-path-12345', files: [] });
  assert.equal(result.modules, null);
  assert.equal(result.selectionReason, 'no-diff-detected');
});

test('computeSmartSuite selectionReason mentions file count and module count', () => {
  const result = computeSmartSuite({ projectRoot: '/tmp', files: ['src/auth.ts', 'Dockerfile'] });
  assert.match(result.selectionReason, /2 changed file/);
  assert.match(result.selectionReason, /modules selected/);
});

test('computeSmartSuite scores object has positive scores for known modules', () => {
  const result = computeSmartSuite({ projectRoot: '/tmp', files: ['src/auth.ts'] });
  assert.ok(result.scores, 'scores should be present');
  const nonZero = Object.values(result.scores).some(v => Number(v) > 0);
  assert.ok(nonZero, 'at least one module should have a positive score');
});

test('computeSmartSuite applies memoryBoosts without erroring', () => {
  const result = computeSmartSuite({
    projectRoot:  '/tmp',
    files:        ['src/generic.ts'],
    memoryBoosts: { nPlusOne: 5, moneyFloat: 3 },
  });
  // nPlusOne should now appear (it got a big boost)
  assert.ok(Array.isArray(result.modules));
  // One of the boosted modules should appear
  const has = result.modules.includes('nPlusOne') || result.modules.includes('moneyFloat');
  assert.ok(has, 'boosted module should appear in result');
});

// ── Mixed change sets (real-world scenarios) ──────────────────────────────────

test('full-stack change: auth + api + db → covers security + data layers', () => {
  const modules = selectModules([
    'src/auth/login.ts',
    'src/api/users/route.ts',
    'db/models/user.ts',
  ]);
  assert.ok(modules.includes('cookieSecurity'), 'auth file missing cookieSecurity');
  assert.ok(modules.includes('ssrf'),           'api route missing ssrf');
  assert.ok(modules.includes('nPlusOne'),       'db model missing nPlusOne');
});

test('infra-only change: Dockerfile + terraform + k8s → infra modules selected', () => {
  const modules = selectModules([
    'Dockerfile',
    'infra/main.tf',
    'k8s/deployment.yaml',
  ]);
  assert.ok(modules.includes('dockerfile'),  'missing dockerfile');
  assert.ok(modules.includes('terraform'),   'missing terraform');
  assert.ok(modules.includes('kubernetes'),  'missing kubernetes');
});

test('frontend-only change: component + page → accessibility, featureFlag', () => {
  const modules = selectModules([
    'website/app/components/Pricing.tsx',
    'website/app/pages/dashboard.tsx',
  ]);
  assert.ok(modules.includes('accessibility'), 'missing accessibility');
  assert.ok(modules.includes('featureFlag'),   'missing featureFlag');
});
