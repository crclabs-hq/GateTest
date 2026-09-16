// =============================================================================
// `gatetest --format json` / `--json` and `--file <path>` — the editor contract.
// =============================================================================
// The VS Code extension has always spawned
//   gatetest --suite <s> --format json --project <root> [--file <f>]
// and JSON.parsed stdout. Until 2026-09-15 the CLI had neither flag: both were
// reported as unknown options, the human report went to stdout, and the
// extension failed on every scan. These tests pin the contract from both
// ends — the parser and the document builder as units, the spawned CLI end
// to end, and the extension source against the field names the CLI ships.
//
// Timing: a single module on a two-file fixture is ~3s; the quick suite is
// ~30s. Each spawn is its own test so no test nears the 60s runner budget.
// =============================================================================

'use strict';

const { test, describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gatetest.js');
const PKG_VERSION = require('../package.json').version;
const { parseArgs, describeArgProblems, resolveFileFilter } = require('../src/core/cli-args');
const { buildJsonOutput, scanExitCode, summaryLine, SEVERITIES } = require('../src/core/json-output');

// ─── helpers ─────────────────────────────────────────────────────────────────

function runCli(args, opts = {}) {
  const env = { ...process.env, GATETEST_NO_TELEMETRY: '1', NO_COLOR: '1' };
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 120000, env, ...opts });
}

/** stdout must be ONE JSON document and nothing else. Returns it parsed. */
function onlyJson(stdout) {
  const trimmed = stdout.trim();
  assert.ok(trimmed.startsWith('{') && trimmed.endsWith('}'), `stdout is not a bare JSON object:\n${stdout.slice(0, 400)}`);
  assert.equal(trimmed.split('\n').length, 1, 'the document is one line — nothing printed before or after it');
  assert.doesNotMatch(stdout, /\x1b\[/, 'no ANSI escape on stdout');
  return JSON.parse(stdout);
}

const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join(''); // split so this file is not itself a finding

/** Two files with a secret each, so `--file` has something to leave out. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-json-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', private: true }));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), `const key = "${AWS_KEY}";\nmodule.exports = { key };\n`);
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), `const secret = "${AWS_KEY}";\nmodule.exports = { secret };\n`);
  return dir;
}

function makeCleanFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-json-clean-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'clean', version: '1.0.0', private: true }));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.env\n');
  fs.writeFileSync(path.join(dir, 'src', 'ok.js'), 'module.exports = function add(a, b) { return a + b; };\n');
  return dir;
}

const REQUIRED_KEYS = [
  'version', 'generatedAt', 'suite', 'module', 'project', 'files', 'passed', 'gateStatus', 'exitCode',
  'nothingChecked', 'summary', 'counts', 'modules', 'checks', 'duration', 'deferred', 'failedModules', 'report', 'issues',
];
const ISSUE_KEYS = ['id', 'module', 'ruleId', 'severity', 'message', 'file', 'line', 'column', 'blocking', 'confidence', 'fixable', 'suggestion', 'ignoreLine'];

function assertShape(doc) {
  for (const k of REQUIRED_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(doc, k), `missing top-level key "${k}"`);
  assert.equal(typeof doc.passed, 'boolean');
  assert.ok(['PASSED', 'BLOCKED'].includes(doc.gateStatus));
  assert.ok([0, 1].includes(doc.exitCode));
  assert.equal(typeof doc.summary, 'string');
  assert.ok(doc.summary.includes(doc.gateStatus), 'summary line names the verdict');
  assert.ok(!Number.isNaN(Date.parse(doc.generatedAt)), 'generatedAt is an ISO timestamp');
  for (const k of ['errors', 'warnings', 'notes', 'blocking', 'total', 'duplicatesCollapsed']) assert.equal(typeof doc.counts[k], 'number', `counts.${k}`);
  assert.equal(doc.counts.total, doc.counts.errors + doc.counts.warnings + doc.counts.notes);
  assert.equal(doc.counts.errors, doc.issues.filter((i) => i.severity === 'error').length);
  assert.equal(doc.counts.warnings, doc.issues.filter((i) => i.severity === 'warning').length);
  assert.equal(doc.counts.notes, doc.issues.filter((i) => i.severity === 'info').length);
  assert.ok(Array.isArray(doc.deferred));
  assert.ok(Array.isArray(doc.issues));
  for (const issue of doc.issues) {
    for (const k of ISSUE_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(issue, k), `issue missing "${k}": ${JSON.stringify(issue)}`);
    assert.ok(SEVERITIES.includes(issue.severity), `severity "${issue.severity}" is not one of ${SEVERITIES}`);
    assert.equal(typeof issue.message, 'string');
    assert.ok(issue.file === null || (typeof issue.file === 'string' && !issue.file.includes('\\') && !path.isAbsolute(issue.file)),
      `file is repo-relative and '/'-joined: ${issue.file}`);
    assert.ok(issue.line === null || (Number.isInteger(issue.line) && issue.line >= 1), `line is 1-based or null: ${issue.line}`);
    assert.ok(issue.column === null || (Number.isInteger(issue.column) && issue.column >= 1), `column is 1-based or null: ${issue.column}`);
    assert.equal(typeof issue.blocking, 'boolean');
    assert.equal(typeof issue.fixable, 'boolean');
  }
}

// ─── parser ──────────────────────────────────────────────────────────────────

describe('parseArgs: --format / --json / --file', () => {
  it('--format json, --format=json and --json all set format: "json"', () => {
    assert.equal(parseArgs(['--format', 'json']).format, 'json');
    assert.equal(parseArgs(['--format=json']).format, 'json');
    assert.equal(parseArgs(['--json']).format, 'json');
    assert.equal(parseArgs(['--format', 'text']).format, 'text');
  });

  it('--format with a value outside json|text is an invalid value, never a silent default', () => {
    const args = parseArgs(['--format', 'yaml', '--suite', 'quick']);
    assert.equal(args.format, undefined);
    assert.equal(args.suite, 'quick', 'the rest of the line still parses');
    assert.deepEqual(args.invalidValues, [{ arg: '--format', value: 'yaml', reason: 'expects one of: json, text' }]);
    assert.match(describeArgProblems(args).join('\n'), /--format.*json, text/);
  });

  it('--file is repeatable and comma-separated; --files is an alias; the value is required', () => {
    assert.deepEqual(parseArgs(['--file', 'a.js', '--file', 'b.js,c.js']).files, ['a.js', 'b.js', 'c.js']);
    assert.deepEqual(parseArgs(['--files', 'x.ts, y.ts ,']).files, ['x.ts', 'y.ts']);
    assert.deepEqual(parseArgs(['--file=src/z.js']).files, ['src/z.js']);
    assert.deepEqual(parseArgs(['--file', '--suite', 'quick']).missingValues, ['--file']);
  });
});

describe('resolveFileFilter', () => {
  let dir;
  before(() => { dir = makeFixture(); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns repo-relative, /-joined, de-duplicated paths for relative and absolute inputs', () => {
    const r = resolveFileFilter(['src/a.js', path.join(dir, 'src', 'b.js'), 'src\\a.js', './src/a.js'], dir);
    assert.deepEqual(r, { files: ['src/a.js', 'src/b.js'], problems: [] });
  });

  it('reports — and drops — a missing file, a directory, and a path outside the root', () => {
    const r = resolveFileFilter(['src/nope.js', 'src', path.join(dir, '..', 'elsewhere.js'), 'src/a.js'], dir);
    assert.deepEqual(r.files, ['src/a.js']);
    assert.equal(r.problems.length, 3);
    assert.match(r.problems[0], /no such file/);
    assert.match(r.problems[1], /not a file/);
    assert.match(r.problems[2], /outside the project root/);
  });
});

// ─── document builder ────────────────────────────────────────────────────────

describe('buildJsonOutput', () => {
  const root = path.resolve(os.tmpdir(), 'gt-json-unit');
  const autoFix = () => {};
  const summary = {
    gateStatus: 'BLOCKED',
    nothingChecked: false,
    duration: 1234,
    deferred: ['mutation'],
    modules: { total: 3, passed: 1, failed: 2, skipped: 0 },
    checks: { total: 6, passed: 1, failed: 5 },
    failedModules: [{ module: 'secrets', error: 'blocking', failedChecks: 1 }],
    results: [
      { module: 'secrets', checks: [
        { name: 'aws', passed: false, severity: 'error', file: path.join(root, 'src', 'a.js'), line: 3, column: 14, autoFix, message: 'AWS key' },
        { name: 'ok', passed: true },
      ] },
      { module: 'codeQuality', checks: [
        { name: 'console', passed: false, severity: 'warning', file: './src/b.js', line: '7', fix: 'remove it', message: 'console.log in library code' },
        { name: 'odd', passed: false, severity: 'critical', message: 'unknown severity from a custom module' },
        { name: 'dup', passed: false, severity: 'warning', file: 'src/a.js', line: 3, message: 'twin of the secret' },
      ] },
    ],
    findings: [
      { id: 'secrets:aws', module: 'secrets', rule: 'secrets:aws', severity: 'error', confidence: 0.95, blocking: true, file: path.join(root, 'src', 'a.js'), line: 3, message: 'AWS key', suggestion: null, ignoreLine: 'secrets:aws', duplicateOf: null },
      { id: 'codeQuality:console', module: 'codeQuality', rule: 'console', severity: 'warning', confidence: 0.6, blocking: false, file: './src/b.js', line: 7, message: 'console.log in library code', suggestion: 'remove it', ignoreLine: 'codeQuality:console', duplicateOf: null },
      { id: 'codeQuality:odd', module: 'codeQuality', rule: 'odd', severity: 'info', confidence: 1, blocking: false, file: null, line: null, message: 'unknown severity from a custom module', suggestion: null, ignoreLine: null, duplicateOf: null },
      { id: 'codeQuality:dup', module: 'codeQuality', rule: 'dup', severity: 'warning', confidence: 0.5, blocking: false, file: 'src/a.js', line: 3, message: 'twin of the secret', suggestion: null, ignoreLine: null, duplicateOf: 'secrets:aws' },
    ],
  };

  it('reuses the registry findings: repo-relative files, 1-based ints or null, duplicates folded and counted', () => {
    const doc = buildJsonOutput(summary, { projectRoot: root, suite: 'quick', files: null, exitCode: 1, reportPath: null });
    assertShape(doc);
    assert.equal(doc.version, PKG_VERSION);
    assert.equal(doc.suite, 'quick');
    assert.equal(doc.module, null);
    assert.equal(doc.project, root);
    assert.equal(doc.passed, false);
    assert.equal(doc.exitCode, 1);
    assert.deepEqual(doc.deferred, ['mutation']);
    assert.equal(doc.duration, 1234);
    assert.equal(doc.issues.length, 3, 'the cross-module duplicate is folded');
    assert.deepEqual(doc.counts, { errors: 1, warnings: 1, notes: 1, blocking: 1, total: 3, duplicatesCollapsed: 1 });

    const [aws, consoleLog, odd] = doc.issues;
    assert.equal(aws.file, 'src/a.js', 'absolute path made repo-relative');
    assert.equal(aws.line, 3);
    assert.equal(aws.column, 14, 'column read off the underlying check');
    assert.equal(aws.fixable, true, 'an autoFix closure makes it fixable');
    assert.equal(aws.blocking, true);
    assert.equal(aws.ruleId, 'secrets:aws');
    assert.equal(consoleLog.file, 'src/b.js', 'leading ./ stripped');
    assert.equal(consoleLog.line, 7, 'numeric string coerced');
    assert.equal(consoleLog.column, null);
    assert.equal(consoleLog.fixable, false, 'a text suggestion is not an auto-fix');
    assert.equal(consoleLog.suggestion, 'remove it');
    assert.equal(odd.severity, 'info', 'a severity outside the three is info, as the registry decides');
    assert.equal(odd.file, null);
    assert.equal(odd.line, null);
  });

  it('a module run, a file filter and a report path are echoed; the summary line names them', () => {
    const doc = buildJsonOutput({ ...summary, gateStatus: 'PASSED', findings: [], results: [] },
      { projectRoot: root, module: 'secrets', files: ['src/a.js'], exitCode: 0, reportPath: '/r/latest.json' });
    assert.equal(doc.suite, null);
    assert.equal(doc.module, 'secrets');
    assert.deepEqual(doc.files, ['src/a.js']);
    assert.equal(doc.report, '/r/latest.json');
    assert.equal(doc.passed, true);
    assert.match(doc.summary, /^module secrets PASSED — 0 errors, 0 warnings, 0 notes in 1 file across 3 modules \(1\.2s\)$/);
  });

  it('an empty project is disclosed in the document and the summary line', () => {
    const doc = buildJsonOutput({ ...summary, gateStatus: 'PASSED', nothingChecked: true, findings: [], results: [] },
      { projectRoot: root, suite: 'quick', exitCode: 0 });
    assert.equal(doc.nothingChecked, true);
    assert.match(doc.summary, /no source files found/);
    assert.match(summaryLine({ scope: 'x', gateStatus: 'PASSED', counts: { errors: 0, warnings: 0, notes: 0 }, modules: { total: 0 }, nothingChecked: true }), /no source files/);
  });

  it('scanExitCode is the one gate rule both output modes share', () => {
    assert.equal(scanExitCode({ gateStatus: 'PASSED' }), 0);
    assert.equal(scanExitCode({ gateStatus: 'BLOCKED' }), 1);
    assert.equal(scanExitCode({ gateStatus: 'BLOCKED', baseline: { captured: 3 } }, { baseline: true }), 0, '--baseline is setup, not a gate run');
    assert.equal(scanExitCode({ gateStatus: 'PASSED', baseline: { error: 'disk full' } }, { baseline: true }), 1);
  });
});

// ─── the spawned CLI ─────────────────────────────────────────────────────────

describe('gatetest --format json (spawned)', () => {
  let fixture;
  let clean;
  before(() => { fixture = makeFixture(); clean = makeCleanFixture(); });
  after(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(clean, { recursive: true, force: true });
  });

  test('--module secrets --format json: one JSON document on stdout, nothing else, exit code preserved and echoed', () => {
    const r = runCli(['--module', 'secrets', '--format', 'json', '--project', fixture]);
    const doc = onlyJson(r.stdout);
    assertShape(doc);
    assert.equal(r.status, 1, 'a blocking secret fails the gate exactly as in human mode');
    assert.equal(doc.exitCode, 1);
    assert.equal(doc.passed, false);
    assert.equal(doc.gateStatus, 'BLOCKED');
    assert.equal(doc.module, 'secrets');
    assert.equal(doc.suite, null);
    assert.equal(doc.files, null);
    assert.equal(doc.project, path.resolve(fixture));
    assert.equal(doc.version, PKG_VERSION);
    assert.ok(doc.counts.errors >= 2, `expected a finding per file, got ${JSON.stringify(doc.issues)}`);
    const files = new Set(doc.issues.map((i) => i.file));
    assert.ok(files.has('src/a.js') && files.has('src/b.js'), `issues name both files: ${[...files]}`);
    assert.ok(doc.report && fs.existsSync(doc.report), 'the on-disk report the run wrote is named');
    assert.match(fs.readFileSync(doc.report, 'utf8'), /"gateStatus": "BLOCKED"/, 'and it is the same run');
  });

  test('exit code parity: the JSON run and the human run of the same scan exit alike', () => {
    const human = runCli(['--module', 'secrets', '--project', fixture]);
    const json = runCli(['--module', 'secrets', '--json', '--project', fixture]);
    assert.equal(human.status, 1);
    assert.equal(json.status, human.status);
    assert.equal(onlyJson(json.stdout).exitCode, human.status);
    assert.match(human.stdout, /GATETEST/, 'human mode still prints the report');
  });

  test('a passing scan exits 0 and says so; warnings do not change that', () => {
    const r = runCli(['--module', 'secrets', '--format', 'json', '--project', clean]);
    const doc = onlyJson(r.stdout);
    assertShape(doc);
    assert.equal(r.status, 0);
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.passed, true);
    assert.equal(doc.counts.blocking, 0);
    const human = runCli(['--module', 'secrets', '--project', clean]);
    assert.equal(human.status, 0);
  });

  test('--suite quick --format json: the whole suite, still one document', () => {
    const r = runCli(['--suite', 'quick', '--format', 'json', '--project', fixture]);
    const doc = onlyJson(r.stdout);
    assertShape(doc);
    assert.equal(doc.suite, 'quick');
    assert.equal(doc.module, null);
    assert.ok(doc.modules.total > 5, `the quick suite ran more than one module: ${doc.modules.total}`);
    assert.equal(r.status, doc.exitCode);
    assert.ok(doc.issues.some((i) => i.file === 'src/a.js'), 'the secret in src/a.js is among the issues');
  });

  test('a usage error in JSON mode prints nothing on stdout and exits 2', () => {
    const r = runCli(['--suite', 'quick', '--format', 'json', '--project', path.join(fixture, 'does-not-exist')]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /project path does not exist/);
  });
});

describe('gatetest --file (spawned)', () => {
  let fixture;
  before(() => { fixture = makeFixture(); });
  after(() => { fs.rmSync(fixture, { recursive: true, force: true }); });

  test('--file src/a.js: only that file is scanned; repo-level findings (no file) may remain', () => {
    const r = runCli(['--module', 'secrets', '--format', 'json', '--project', fixture, '--file', 'src/a.js']);
    const doc = onlyJson(r.stdout);
    assertShape(doc);
    assert.deepEqual(doc.files, ['src/a.js']);
    assert.ok(doc.issues.some((i) => i.file === 'src/a.js'), 'the named file is scanned');
    assert.ok(!doc.issues.some((i) => i.file === 'src/b.js'), 'the other file is not');
    for (const i of doc.issues) assert.ok(i.file === null || i.file === 'src/a.js', `unexpected file ${i.file}`);
    assert.equal(r.status, 1, 'the secret in the named file still blocks');
  });

  test('an absolute path and a comma-separated list are accepted; --files is the alias', () => {
    const r = runCli(['--module', 'secrets', '--json', '--project', fixture, '--files', `${path.join(fixture, 'src', 'a.js')},src/b.js`]);
    const doc = onlyJson(r.stdout);
    assert.deepEqual(doc.files, ['src/a.js', 'src/b.js']);
    const files = new Set(doc.issues.map((i) => i.file));
    assert.ok(files.has('src/a.js') && files.has('src/b.js'));
  });

  test('--file naming nothing scannable is a usage error, not a green scan of nothing', () => {
    const r = runCli(['--module', 'secrets', '--format', 'json', '--project', fixture, '--file', 'src/nope.js']);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /--file src\/nope\.js: no such file/);
    assert.match(r.stderr, /Nothing was scanned/);
  });
});

// ─── the other end of the contract ───────────────────────────────────────────

describe('the VS Code extension consumes the shape the CLI ships', () => {
  const src = fs.readFileSync(path.join(ROOT, 'vscode-extension', 'src', 'extension.ts'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode-extension', 'package.json'), 'utf8'));

  it('spawns the flags this CLI accepts', () => {
    assert.match(src, /'--format',\s*'json'/);
    assert.match(src, /'--file'/);
    assert.match(src, /'--project'/);
  });

  it('reads the fields the document carries, with 1-based lines and columns', () => {
    for (const field of ['issues', 'passed', 'summary', 'exitCode', 'counts', 'ruleId', 'column']) {
      assert.ok(src.includes(field), `extension never reads "${field}"`);
    }
    assert.match(src, /issue\.line\s*(\?\?|\|\|)\s*1\)\s*-\s*1/, 'line converted from 1-based to VS Code 0-based');
    assert.match(src, /issue\.column\s*(\?\?|\|\|)\s*1\)\s*-\s*1/, 'column converted from 1-based to VS Code 0-based');
  });

  it('never spawns a bare .js, never launches a .cmd shim without a shell, and names the real package', () => {
    assert.match(src, /process\.execPath/, 'scripts run under the extension host node');
    assert.match(src, /ELECTRON_RUN_AS_NODE/, 'the host is Electron; without this it opens a window');
    assert.match(src, /shell:\s*(true|launch\.shell)/, '.cmd shims need a shell on Windows');
    assert.ok(src.includes('npm install -g @gatetest/cli'), 'install hint names the published package');
    assert.ok(!src.includes('npm install -g gatetest'), 'the unscoped name is not the package');
  });

  it('does not write settings at activation — MCP registration is a command', () => {
    const activateBody = src.slice(src.indexOf('export function activate'), src.indexOf('export function deactivate'));
    assert.doesNotMatch(activateBody, /config\.update|writeIdeMcpConfig|writeWorkspaceMcp|ConfigurationTarget\.Global/);
    assert.ok(pkg.contributes.commands.some((c) => /Mcp/i.test(c.command)), 'an MCP command is contributed instead');
  });
});
