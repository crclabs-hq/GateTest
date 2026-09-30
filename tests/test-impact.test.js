/**
 * Launch Board move 5 — `--diff` runs only the tests the import graph touches.
 *
 * Until this change `--diff` narrowed what GateTest READ and never what the
 * unitTests / integrationTests modules RAN: both executed the customer's whole
 * suite on every diff scan (`npm test`), and the runner only filtered the
 * findings afterwards.
 *
 * The fixture is the one the acceptance line describes — three source files
 * and four tests:
 *
 *   src/a.js        <- tests/a.test.js
 *   src/b.js (a)    <- tests/b.test.js          (b imports a: a change to a reaches b)
 *   src/c.js        <- tests/c.test.js, tests/d.test.js
 *
 * A diff that touches src/a.js must select exactly a.test.js and b.test.js
 * (the two that depend on it, one of them transitively). Controls: a config
 * file change selects ALL four and says why; a file the graph cannot map,
 * a computed require, a helper it cannot classify and a script it cannot pass
 * a file list to each say so instead of skipping.
 *
 * Doctrine 1 (never success while doing nothing), 3 (control pairs),
 * 4 (the one import graph, the one test-path definition), 6 (say what was
 * not checked).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { selectImpactedTests, planTestRun, commandForFiles } = require('../src/core/test-impact');
const UnitTestsModule = require('../src/modules/unit-tests');

const ROOT = path.join(__dirname, '..');

/** Every test file records that it ran, so a selection is proven by what EXECUTED. */
const marker = (name, requireLine, body) => `const { test } = require('node:test');
const assert = require('node:assert');
${requireLine}
test('${name}', () => {
  require('node:fs').appendFileSync(require('node:path').join(__dirname, '..', 'ran.log'), '${name}\\n');
  ${body}
});
`;

const BASE_FILES = {
  'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2),
  'README.md': '# fixture\n',
  'src/a.js': "module.exports = () => 'a';\n",
  'src/b.js': "const a = require('./a');\nmodule.exports = () => a() + 'b';\n",
  'src/c.js': "module.exports = () => 'c';\n",
  'tests/a.test.js': marker('a.test.js', "const a = require('../src/a');", "assert.strictEqual(a(), 'a');"),
  'tests/b.test.js': marker('b.test.js', "const b = require('../src/b');", "assert.strictEqual(b(), 'ab');"),
  'tests/c.test.js': marker('c.test.js', "const c = require('../src/c');", "assert.strictEqual(c(), 'c');"),
  'tests/d.test.js': marker('d.test.js', "const c = require('../src/c');", "assert.strictEqual(c(), 'c');"),
};

function makeRepo(extra = {}, drop = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-impact-'));
  const files = { ...BASE_FILES, ...extra };
  for (const d of drop) delete files[d];
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const roots = [];
function repo(extra, drop) { const r = makeRepo(extra, drop); roots.push(r); return r; }
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const ALL_FOUR = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js', 'tests/d.test.js'];

describe('selectImpactedTests — the reverse-dependency closure over the one import graph', () => {
  it('a diff touching src/a.js selects exactly the two tests that depend on it (one transitively)', () => {
    const root = repo();
    const impact = selectImpactedTests({ projectRoot: root, changedFiles: ['src/a.js'] });
    assert.strictEqual(impact.mode, 'selected');
    assert.deepStrictEqual(impact.selected, ['tests/a.test.js', 'tests/b.test.js']);
    assert.strictEqual(impact.totalTestFiles, 4);
    assert.strictEqual(impact.line, 'running 2 of 4 test files touched by this diff (import graph)');
    assert.strictEqual(impact.reason, null);
  });

  it('a diff touching src/c.js selects the other two — the closure follows the imports, not the names', () => {
    const impact = selectImpactedTests({ projectRoot: repo(), changedFiles: ['src/c.js'] });
    assert.deepStrictEqual(impact.selected, ['tests/c.test.js', 'tests/d.test.js']);
  });

  it('a changed test selects itself', () => {
    const impact = selectImpactedTests({ projectRoot: repo(), changedFiles: ['tests/d.test.js'] });
    assert.deepStrictEqual(impact.selected, ['tests/d.test.js']);
  });

  it('CONTROL — a config file change selects ALL four tests and names the file and why', () => {
    const impact = selectImpactedTests({ projectRoot: repo(), changedFiles: ['package.json'] });
    assert.strictEqual(impact.mode, 'full');
    assert.deepStrictEqual(impact.selected, ALL_FOUR);
    assert.match(impact.reason, /package\.json/);
    assert.match(impact.reason, /config file/);
    assert.deepStrictEqual(impact.unmapped.map((u) => u.file), ['package.json']);
    assert.match(impact.line, /^running all 4 test files — cannot map 1 changed file\(s\): package\.json/);
  });

  it('CONTROL — the config change wins even when a mappable source file changed with it', () => {
    const impact = selectImpactedTests({ projectRoot: repo(), changedFiles: ['src/a.js', 'tsconfig.json'] });
    assert.strictEqual(impact.mode, 'full');
    assert.deepStrictEqual(impact.selected, ALL_FOUR);
  });

  it('--all-tests forces the full set and says it was asked for', () => {
    const impact = selectImpactedTests({ projectRoot: repo(), changedFiles: ['src/a.js'], allTests: true });
    assert.strictEqual(impact.mode, 'full');
    assert.deepStrictEqual(impact.selected, ALL_FOUR);
    assert.strictEqual(impact.reason, 'forced by --all-tests');
  });

  it('docs are ignored BY NAME, not silently: a README-only diff selects nothing and lists the file', () => {
    const impact = selectImpactedTests({ projectRoot: repo(), changedFiles: ['README.md'] });
    assert.strictEqual(impact.mode, 'selected');
    assert.deepStrictEqual(impact.selected, []);
    assert.deepStrictEqual(impact.ignored, ['README.md']);
    assert.match(impact.line, /^running 0 of 4 test files touched by this diff \(import graph\)$/);
  });

  it('a file the graph does not read (a .py, a .json fixture) falls back to the full set', () => {
    const root = repo({ 'scripts/report.py': 'print(1)\n', 'data/rows.json': '[]' });
    for (const changed of ['scripts/report.py', 'data/rows.json']) {
      const impact = selectImpactedTests({ projectRoot: root, changedFiles: [changed] });
      assert.strictEqual(impact.mode, 'full', changed);
      assert.match(impact.reason, /not in the import graph/, changed);
    }
  });

  it('a deleted file falls back to the full set — the tests that loaded it cannot be found', () => {
    const impact = selectImpactedTests({ projectRoot: repo(), changedFiles: ['src/gone.js'] });
    assert.strictEqual(impact.mode, 'full');
    assert.match(impact.reason, /src\/gone\.js \(deleted or moved/);
  });

  it('a changed source file nothing imports falls back to the full set (a config or CLI may load it by name)', () => {
    const root = repo({ 'src/loose.js': 'module.exports = 1;\n' });
    const impact = selectImpactedTests({ projectRoot: root, changedFiles: ['src/loose.js'] });
    assert.strictEqual(impact.mode, 'full');
    assert.match(impact.reason, /nothing imports it/);
  });

  it('a changed runner-config .js file is a config change even though the graph can read it', () => {
    const root = repo({ 'jest.config.js': 'module.exports = {};\n' });
    const impact = selectImpactedTests({ projectRoot: root, changedFiles: ['jest.config.js'] });
    assert.strictEqual(impact.mode, 'full');
    assert.match(impact.reason, /config file/);
  });

  it('a test reaching a computed require is KEPT and named — never dropped', () => {
    const root = repo({
      'src/loader.js': "module.exports = (n) => require('./' + n);\n",
      'tests/dyn.test.js': marker('dyn.test.js', "const load = require('../src/loader');", "assert.ok(load);"),
    });
    const impact = selectImpactedTests({ projectRoot: root, changedFiles: ['src/a.js'] });
    assert.strictEqual(impact.mode, 'selected');
    assert.deepStrictEqual(impact.selected, ['tests/a.test.js', 'tests/b.test.js', 'tests/dyn.test.js']);
    assert.strictEqual(impact.graphSelected, 2);
    assert.strictEqual(impact.conservative.length, 1);
    assert.strictEqual(impact.conservative[0].file, 'tests/dyn.test.js');
    assert.match(impact.conservative[0].reason, /src\/loader\.js:1/);
    assert.match(impact.line, /^running 3 of 5 test files touched by this diff \(import graph\) \(1 kept because it reaches a require\/import the graph cannot follow\)$/);
  });

  it('CONTROL — the same repo without the computed require keeps the two-test selection', () => {
    const root = repo({ 'src/loader.js': "module.exports = () => require('./a');\n", 'tests/lit.test.js': marker('lit.test.js', "const load = require('../src/loader');", 'assert.ok(load);') });
    const impact = selectImpactedTests({ projectRoot: root, changedFiles: ['src/c.js'] });
    assert.deepStrictEqual(impact.selected, ['tests/c.test.js', 'tests/d.test.js']);
    assert.deepStrictEqual(impact.conservative, []);
  });

  it('a test reaches the changed file through a helper in the test directory', () => {
    const root = repo({
      'tests/helpers/db.js': "module.exports = require('../../src/a');\n",
      'tests/h.test.js': marker('h.test.js', "const db = require('./helpers/db');", "assert.strictEqual(db(), 'a');"),
    });
    const impact = selectImpactedTests({ projectRoot: root, changedFiles: ['src/a.js'] });
    assert.deepStrictEqual(impact.selected, ['tests/a.test.js', 'tests/b.test.js', 'tests/h.test.js']);
  });

  it('a test-directory file named like nothing and imported by nothing cannot be classified: full set, named', () => {
    const root = repo({ 'tests/smoke.js': "require('../src/a');\n" });
    const impact = selectImpactedTests({ projectRoot: root, changedFiles: ['src/a.js'] });
    assert.strictEqual(impact.mode, 'full');
    assert.match(impact.reason, /cannot tell helper from test: tests\/smoke\.js/);
  });
});

describe('commandForFiles — a file list only where the runner will honour it', () => {
  const root = repo();
  const files = ['tests/a.test.js', 'tests/b.test.js'];

  it('node --test script → the same runner with exactly the files', () => {
    const r = commandForFiles({ name: 'npm test', command: 'npm test 2>&1', script: 'node --test' }, root, files);
    assert.strictEqual(r.command, 'node --test --test-reporter=tap "tests/a.test.js" "tests/b.test.js" 2>&1');
  });

  it('jest / vitest / mocha scripts keep their flags and take the files', () => {
    assert.match(commandForFiles({ name: 'npm test', script: 'jest --coverage' }, root, files).command, /^npx --no-install jest --runTestsByPath --coverage "tests\/a\.test\.js"/);
    assert.match(commandForFiles({ name: 'npm test', script: 'vitest' }, root, files).command, /^npx --no-install vitest run "tests\/a\.test\.js"/);
    assert.match(commandForFiles({ name: 'npm test', script: 'mocha --bail' }, root, files).command, /^npx --no-install mocha --bail "tests\/a\.test\.js"/);
  });

  it('CONTROL — a chain, an unknown runner, a script naming paths and a non-JS runner each give a reason, not a command', () => {
    for (const script of ['npm run lint && node --test', 'node scripts/run-tests.js tests/*.test.js', 'jest src', 'tap']) {
      const r = commandForFiles({ name: 'npm test', script }, root, files);
      assert.ok(r.reason && !r.command, script);
    }
    assert.match(commandForFiles({ name: 'pytest', command: 'python -m pytest' }, root, files).reason, /pytest does not take a file list/);
  });

  it('mocha with `spec` in its config is refused: positional files add to the run instead of narrowing it', () => {
    const r2 = repo({ '.mocharc.json': '{ "spec": "test/**/*.js" }' });
    assert.match(commandForFiles({ name: 'Mocha', command: 'x' }, r2, files).reason, /sets `spec`/);
    assert.ok(commandForFiles({ name: 'Mocha', command: 'x' }, root, files).command);
  });
});

describe('planTestRun — what a test-running module does for this scan', () => {
  it('is null when the scan is not narrowed: the modules behave exactly as before', () => {
    const root = repo();
    assert.strictEqual(planTestRun({ projectRoot: root, runnerOptions: { diffOnly: false }, testCommand: { name: 'npm test', command: 'npm test', script: 'node --test' } }), null);
    assert.strictEqual(planTestRun({ projectRoot: root, runnerOptions: undefined, testCommand: { name: 'npm test', command: 'npm test', script: 'node --test' } }), null);
  });

  it('--diff with no resolvable changed files runs the full set and says so', () => {
    const plan = planTestRun({ projectRoot: repo(), runnerOptions: { diffOnly: true, changedFiles: null }, testCommand: { name: 'npm test', command: 'npm test 2>&1', script: 'node --test' } });
    assert.strictEqual(plan.command, 'npm test 2>&1');
    assert.match(plan.impact.line, /no changed files were resolved/);
  });

  it('a runner that cannot take a file list runs the full set with the reason', () => {
    const plan = planTestRun({ projectRoot: repo(), runnerOptions: { diffOnly: true, changedFiles: ['src/a.js'] }, testCommand: { name: 'npm test', command: 'npm test 2>&1', script: 'node scripts/run.js' } });
    assert.strictEqual(plan.command, 'npm test 2>&1');
    assert.strictEqual(plan.impact.mode, 'full');
    assert.match(plan.impact.reason, /not a single jest, vitest, mocha or node --test invocation.*running the full set/);
  });

  it('zero selected tests runs nothing and says so', () => {
    const plan = planTestRun({ projectRoot: repo(), runnerOptions: { diffOnly: true, changedFiles: ['README.md'] }, testCommand: { name: 'npm test', command: 'npm test 2>&1', script: 'node --test' } });
    assert.strictEqual(plan.command, null);
    assert.match(plan.impact.line, /running 0 of 4 test files touched by this diff \(import graph\) — no test file imports a changed file/);
  });
});

describe('UnitTestsModule under --diff — the selection is what EXECUTES', () => {
  const runModule = async (root, runnerOptions) => {
    const result = { checks: [], addCheck(name, passed, d = {}) { this.checks.push({ name, passed, ...d }); } };
    await new UnitTestsModule().run(result, { projectRoot: root, _runnerOptions: runnerOptions });
    const log = path.join(root, 'ran.log');
    const ran = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).sort() : [];
    return { result, ran };
  };

  it('a diff touching src/a.js executes a.test.js and b.test.js and NOT c / d', async () => {
    const { result, ran } = await runModule(repo(), { diffOnly: true, changedFiles: ['src/a.js'] });
    assert.deepStrictEqual(ran, ['a.test.js', 'b.test.js']);
    assert.strictEqual(result.testImpact.line, 'running 2 of 4 test files touched by this diff (import graph)');
    const names = result.checks.map((c) => c.name);
    assert.ok(names.includes('unit-tests:impact'));
    const run = result.checks.find((c) => c.name === 'unit-tests:run');
    assert.strictEqual(run.passed, true);
    assert.match(run.message, /Selected unit tests passed \(2 of 4 test files; the rest were not run\)/);
  });

  it('CONTROL — a config change executes all four', async () => {
    const { result, ran } = await runModule(repo(), { diffOnly: true, changedFiles: ['package.json'] });
    assert.deepStrictEqual(ran, ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js']);
    assert.strictEqual(result.testImpact.mode, 'full');
    assert.match(result.checks.find((c) => c.name === 'unit-tests:run').message, /All unit tests passed/);
  });

  it('CONTROL — --all-tests executes all four for the same diff', async () => {
    const { ran } = await runModule(repo(), { diffOnly: true, changedFiles: ['src/a.js'], allTests: true });
    assert.deepStrictEqual(ran, ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js']);
  });

  it('CONTROL — a scan that is not narrowed executes all four and carries no impact block', async () => {
    const { result, ran } = await runModule(repo(), {});
    assert.deepStrictEqual(ran, ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js']);
    assert.strictEqual(result.testImpact, undefined);
  });

  it('a selected test that FAILS still blocks: the narrowing never hides a red test', async () => {
    const root = repo({ 'tests/a.test.js': marker('a.test.js', "const a = require('../src/a');", "assert.strictEqual(a(), 'WRONG');") });
    const { result } = await runModule(root, { diffOnly: true, changedFiles: ['src/a.js'] });
    const run = result.checks.find((c) => c.name === 'unit-tests:run');
    assert.strictEqual(run.passed, false);
    assert.strictEqual(run.severity, 'error');
  });

  it('a diff no test imports executes nothing and reports NOT EXECUTED, never a green pass', async () => {
    const { result, ran } = await runModule(repo(), { diffOnly: true, changedFiles: ['README.md'] });
    assert.deepStrictEqual(ran, []);
    const run = result.checks.find((c) => c.name === 'unit-tests:run');
    assert.match(run.message, /^Not executed — no test file imports a changed file \(0 of 4 selected\)/);
  });
});

describe('gatetest --diff end to end (real git diff, --format json)', () => {
  let root;
  before(() => {
    root = repo();
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    // The working-tree diff: one source file and one doc.
    fs.appendFileSync(path.join(root, 'README.md'), 'more\n');
    fs.appendFileSync(path.join(root, 'src', 'a.js'), '// touched\n');
  });

  const cli = (...extra) => {
    const env = { ...process.env, GATETEST_NO_TELEMETRY: '1', GATETEST_NO_ARTIFACTS: '1' };
    for (const k of Object.keys(env)) if (/^(?:GITHUB_|CI$|NODE_TEST_CONTEXT)/.test(k)) delete env[k];
    let out;
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'gatetest.js'), '--module', 'unitTests', '--diff', '--format', 'json', '--no-artifacts', '--project', root, ...extra], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90000 });
    } catch (err) { out = err.stdout; }
    return JSON.parse(out);
  };
  const ranLog = () => { const p = path.join(root, 'ran.log'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).sort() : []; };

  it('selects the two dependent tests, runs only them, and exposes the selection in --format json', () => {
    fs.rmSync(path.join(root, 'ran.log'), { force: true });
    const json = cli();
    assert.deepStrictEqual(ranLog(), ['a.test.js', 'b.test.js']);
    assert.ok(json.testImpact, 'testImpact present in the JSON document');
    const impact = json.testImpact.unitTests;
    assert.strictEqual(impact.mode, 'selected');
    assert.deepStrictEqual(impact.selected, ['tests/a.test.js', 'tests/b.test.js']);
    assert.strictEqual(impact.totalTestFiles, 4);
    assert.strictEqual(impact.line, 'running 2 of 4 test files touched by this diff (import graph)');
    assert.deepStrictEqual(impact.ignored, ['README.md']);
    assert.deepStrictEqual(impact.unmapped, []);
    assert.deepStrictEqual(impact.changed, ['README.md', 'src/a.js']);
  });

  it('--all-tests runs all four and the JSON says the full set was forced', () => {
    fs.rmSync(path.join(root, 'ran.log'), { force: true });
    const json = cli('--all-tests');
    assert.deepStrictEqual(ranLog(), ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js']);
    assert.strictEqual(json.testImpact.unitTests.mode, 'full');
    assert.strictEqual(json.testImpact.unitTests.reason, 'forced by --all-tests');
  });
});
