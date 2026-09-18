#!/usr/bin/env node
/**
 * Head-to-head — GateTest, Semgrep and ESLint (eslint-plugin-security)
 * measured on the same twenty third-party repositories, bad columns included.
 *
 * Craig 2026-09-16: "Publish the corpus numbers against SonarQube, Semgrep
 * and CodeQL on the same twenty repos, bad columns included. That table is
 * the award submission."
 *
 * Every repository comes from reliability-corpus/real-world.json, cloned
 * shallow at its pinned commit with the same `clone` the precision gate uses,
 * so every tool sees the same bytes. Per repo, in this order:
 *
 *   1. GateTest  `scan --suite <suite> --project <clone>` — the suite the
 *                corpus gate runs (`full` by default; `--suite quick` for the
 *                pre-commit tier). Blocking = error-severity findings at or
 *                above the confidence threshold, i.e. what fails the gate.
 *                Total = every finding of any severity in the JSON report.
 *   2. Semgrep   `--config auto --json` — the default registry ruleset chosen
 *                for the languages it detects. Counted by its own severity
 *                labels (ERROR / WARNING / INFO). The exit status is recorded.
 *   3. ESLint    eslint-plugin-security's recommended rules, only when the
 *                clone's dominant language is JavaScript or TypeScript, via a
 *                throwaway package.json in the temp dir (never in this repo).
 *   4. CodeQL    the official CLI (found on PATH or at CODEQL_HOME — the
 *                workflow installs a pinned bundle) builds a database for
 *                the clone's detected language and runs that language's
 *                `*-security-extended.qls` query suite, e.g.
 *                `javascript-security-extended.qls`. A result counts as
 *                blocking-equivalent when its SARIF level is "error", its
 *                `problem.severity` is "error", or its `security-severity`
 *                is >= 7.0 (see `isCodeqlBlocking`, the one definition).
 *                Interpreted languages run with `--build-mode=none`;
 *                compiled ones fall back to CodeQL's autobuild and simply
 *                report "not measured" with the reason when it cannot build
 *                the repo. A language with no security-extended suite (this
 *                adapter currently covers JavaScript/TypeScript, Python,
 *                Ruby, Go, Java, C# and Swift) is "not measured" too.
 *
 * Each tool is time-boxed per repo (TOOL_TIMEOUT_MS, ten minutes) and a run
 * that hits the box is written as "timed out" with the seconds it burned. A
 * tool that cannot be installed on this runner is written as "tool
 * unavailable on this runner" for every repo. SonarQube (needs a server) is
 * NOT run and is written as "not measured" with the reason — a number nobody
 * measured is not a number. CodeQL is measured per repo when its CLI is
 * present; any failure (CLI absent, unsupported language, timeout, non-zero
 * exit from either CLI step) is written as "not measured" with the reason,
 * the same rule applied to every other tool here — never a fabricated zero.
 *
 * Counts are not comparable one-to-one. GateTest's "blocking" is a gate
 * verdict on error-severity findings across code quality, security, infra
 * and docs; Semgrep's ERROR is a rule author's label; eslint-plugin-security
 * reports fourteen security rules. The table shows what each tool says about
 * the same commit and how long it took to say it. The page says the same.
 *
 * Output: website/app/data/head-to-head.json, validated against the shape in
 * website/app/lib/head-to-head.js before it is written (the page renders
 * through the same module, so the two cannot drift). Never touches
 * reliability-corpus/real-world.json.
 *
 * Usage:
 *   node scripts/head-to-head.js                      # every corpus repo
 *   node scripts/head-to-head.js --repos 8            # the first 8 in priority order
 *   node scripts/head-to-head.js --repo express --repo django
 *   node scripts/head-to-head.js --json               # print the document instead of the table
 *   node scripts/head-to-head.js --merge              # keep rows for repos not in this run
 *   node scripts/head-to-head.js --suite quick        # pre-commit tier instead of full
 *   node scripts/head-to-head.js --out <path>         # default website/app/data/head-to-head.json
 *   node scripts/head-to-head.js --no-semgrep --no-eslint --no-codeql --keep --timeout-minutes 10
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATETEST = path.join(ROOT, 'bin', 'gatetest.js');
const OUT_DEFAULT = path.join(ROOT, 'website', 'app', 'data', 'head-to-head.json');
const { clone, removeTmp, MANIFEST } = require('./real-world-precision');
const h2h = require(path.join(ROOT, 'website', 'app', 'lib', 'head-to-head'));

const { STATUS, TOOL_TIMEOUT_MS, elapsedSeconds } = h2h;

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const MAX_BUFFER = 256 * 1024 * 1024;

// Pinned majors for the throwaway ESLint toolchain. Installed in the temp
// dir only — this repository gains no dependency.
const ESLINT_PACKAGES = ['eslint@9', 'eslint-plugin-security@4', '@typescript-eslint/parser@8', 'typescript@5'];
const ESLINT_CONFIG_NAME = '.gt-head-to-head.eslint.config.mjs';

const LANG_BY_EXT = Object.freeze({
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.php': 'PHP', '.java': 'Java',
  '.kt': 'Kotlin', '.kts': 'Kotlin', '.cs': 'C#', '.swift': 'Swift',
});
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.gatetest', 'target', 'bin', 'obj']);
const JS_TS = new Set(['JavaScript', 'TypeScript']);

const log = (s) => process.stderr.write(`${s}\n`);

function parseArgs(argv) {
  const opts = {
    repos: null, only: [], json: false, out: OUT_DEFAULT, suite: 'full', keep: false, merge: false,
    semgrep: true, eslint: true, codeql: true, timeoutMs: TOOL_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repos') { opts.repos = Number(argv[i + 1]); i += 1; }
    else if (a === '--repo') { opts.only.push(argv[i + 1]); i += 1; }
    else if (a === '--json') opts.json = true;
    else if (a === '--out') { opts.out = path.resolve(argv[i + 1]); i += 1; }
    else if (a === '--suite') { opts.suite = argv[i + 1]; i += 1; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--merge') opts.merge = true;
    else if (a === '--no-semgrep') opts.semgrep = false;
    else if (a === '--no-eslint') opts.eslint = false;
    else if (a === '--no-codeql') opts.codeql = false;
    else if (a === '--timeout-minutes') { opts.timeoutMs = Number(argv[i + 1]) * 60 * 1000; i += 1; }
    else { throw new Error(`unknown argument: ${a}`); }
  }
  if (opts.repos !== null && (!Number.isInteger(opts.repos) || opts.repos < 1)) throw new Error('--repos needs a positive integer');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout-minutes needs a positive number');
  return opts;
}

const timedOut = (r) => Boolean(r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'));
const tail = (s, n = 12) => String(s || '').replace(ANSI_RE, '').trim().split('\n').slice(-n).join('\n');

// ---------------------------------------------------------------------------
// Language — measured from the clone, never typed per repo
// ---------------------------------------------------------------------------

function detectLanguage(dir) {
  const counts = {};
  const walk = (d, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } // error-ok — unreadable dir counts nothing
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1); continue; }
      const lang = LANG_BY_EXT[path.extname(e.name).toLowerCase()];
      if (lang) counts[lang] = (counts[lang] || 0) + 1;
    }
  };
  walk(dir, 0);
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { language: top ? top[0] : 'unknown', fileCounts: counts };
}

// ---------------------------------------------------------------------------
// GateTest
// ---------------------------------------------------------------------------

function gatetestVersion() {
  return require(path.join(ROOT, 'package.json')).version;
}

function runGatetest(dir, suite, timeoutMs) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [GATETEST, 'scan', '--suite', suite, '--project', dir], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs,
    env: { ...process.env, GATETEST_NO_TELEMETRY: '1' },
  });
  const seconds = elapsedSeconds(start);
  if (timedOut(r)) return { status: STATUS.timedOut, seconds, exit: null };
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(dir, '.gatetest', 'reports', 'gatetest-report-latest.json'), 'utf8'));
  } catch { // error-ok — fall through to the summary line, then to "failed"
    report = null;
  }
  const checks = report && report.summary && report.summary.checks;
  if (checks && Number.isInteger(checks.blockingErrors) && Number.isInteger(checks.failed)) {
    return {
      status: STATUS.ok,
      blocking: checks.blockingErrors,
      total: checks.failed,
      errors: checks.errors,
      softErrors: checks.softErrors,
      warnings: checks.warnings,
      info: checks.infoFindings,
      modules: report.summary.modules && report.summary.modules.total,
      exit: r.status,
      seconds,
    };
  }
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(ANSI_RE, '');
  const m = out.match(/^\s*Errors:\s*(\d+)\s*(?:blocking)?/m);
  if (m) return { status: `${STATUS.failed} — no JSON report; blocking read from the summary line`, blocking: Number(m[1]), exit: r.status, seconds };
  return { status: `${STATUS.failed} (exit ${r.status})`, exit: r.status, seconds, stderr: tail(out) };
}

// ---------------------------------------------------------------------------
// Semgrep
// ---------------------------------------------------------------------------

/**
 * Find a runnable semgrep. On Windows `pip install --user semgrep` puts the
 * launcher in the per-user Scripts dir, and the launcher execs `pysemgrep`
 * from PATH — so that dir is put on PATH for the child too.
 */
function findSemgrep() {
  // On Windows, Python opens the --output file with the console code page
  // (cp1252) and the first non-Latin character in a finding kills the write:
  // "'charmap' codec can't encode characters" — exit 2, an empty file, no
  // findings (express, 2026-09-16). UTF-8 mode is the fix, and harmless
  // everywhere else.
  const base = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const candidates = [{ bin: 'semgrep', env: base }];
  if (process.platform === 'win32') {
    const r = spawnSync('python', ['-c', "import sysconfig;print(sysconfig.get_path('scripts','nt_user'))"], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0 && r.stdout.trim()) {
      const dir = r.stdout.trim();
      candidates.push({ bin: path.join(dir, 'semgrep.exe'), env: { ...base, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` } });
    }
  }
  for (const c of candidates) {
    let r;
    try {
      r = spawnSync(c.bin, ['--version'], { encoding: 'utf8', env: c.env, timeout: 120000 });
    } catch { continue; } // error-ok — a candidate that cannot spawn is not a semgrep
    if (r.status === 0) {
      const version = String(r.stdout || '').trim().split('\n').pop().trim();
      if (/^\d+\.\d+/.test(version)) return { ...c, version };
    }
  }
  return null;
}

function countSemgrep(results) {
  const counts = { error: 0, warning: 0, info: 0, other: 0 };
  const otherLabels = new Set();
  for (const f of results) {
    const sev = String((f.extra && f.extra.severity) || '').toUpperCase();
    if (sev === 'ERROR') counts.error += 1;
    else if (sev === 'WARNING') counts.warning += 1;
    else if (sev === 'INFO') counts.info += 1;
    else { counts.other += 1; otherLabels.add(sev || '(none)'); }
  }
  return { ...counts, otherSeverities: [...otherLabels].sort() };
}

function runSemgrep(tool, dir, timeoutMs) {
  const outFile = path.join(path.dirname(dir), `${path.basename(dir)}.semgrep.json`);
  const start = process.hrtime.bigint();
  const r = spawnSync(tool.bin, ['--config', 'auto', '--json', '--quiet', '--output', outFile, '.'], {
    cwd: dir, encoding: 'utf8', env: tool.env, maxBuffer: MAX_BUFFER, timeout: timeoutMs,
  });
  const seconds = elapsedSeconds(start);
  if (timedOut(r)) return { status: STATUS.timedOut, seconds, exit: null };
  let json;
  try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { json = null; } // error-ok — reported as failed below
  if (!json || !Array.isArray(json.results)) {
    return { status: `${STATUS.failed} (exit ${r.status}) — no JSON output`, exit: r.status, seconds, stderr: tail(r.stderr) };
  }
  const paths = json.paths || {};
  return {
    status: STATUS.ok,
    ...countSemgrep(json.results),
    scanErrors: Array.isArray(json.errors) ? json.errors.length : null,
    filesScanned: Array.isArray(paths.scanned) ? paths.scanned.length : null,
    exit: r.status,
    seconds,
  };
}

// ---------------------------------------------------------------------------
// ESLint + eslint-plugin-security
// ---------------------------------------------------------------------------

function fileUrl(p) {
  return `file:///${path.resolve(p).replace(/\\/g, '/').replace(/^\//, '')}`;
}

/** Install the throwaway toolchain once per run, outside every clone. */
function setupEslint(tmpRoot) {
  const dir = path.join(tmpRoot, 'eslint-security');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"gatetest-head-to-head-eslint","private":true}\n');
  const start = process.hrtime.bigint();
  // npm is a .cmd shim on Windows, which Node refuses to spawn without a
  // shell. One constant command string — nothing dynamic reaches the shell.
  const r = spawnSync(`npm install --no-audit --no-fund --silent ${ESLINT_PACKAGES.join(' ')}`, {
    cwd: dir, encoding: 'utf8', timeout: 10 * 60 * 1000, shell: true, maxBuffer: MAX_BUFFER,
  });
  const installSeconds = elapsedSeconds(start);
  if (r.status !== 0) return { ok: false, reason: `npm install of the throwaway toolchain failed (exit ${r.status}): ${tail(r.stderr, 4)}` };
  const ver = (name) => {
    try { return require(path.join(dir, 'node_modules', name, 'package.json')).version; } catch { return null; } // error-ok — reported as null
  };
  const version = ver('eslint');
  if (!version) return { ok: false, reason: 'eslint did not install into the throwaway toolchain' };
  return {
    ok: true, dir, version, pluginVersion: ver('eslint-plugin-security'), parserVersion: ver('@typescript-eslint/parser'), installSeconds,
  };
}

function eslintConfig(toolDir) {
  const plugin = fileUrl(path.join(toolDir, 'node_modules', 'eslint-plugin-security', 'index.js'));
  const parser = fileUrl(path.join(toolDir, 'node_modules', '@typescript-eslint', 'parser', 'dist', 'index.js'));
  return [
    '// Written by scripts/head-to-head.js into a throwaway clone. Not part of the repository under test.',
    `import security from ${JSON.stringify(plugin)};`,
    `import tsParser from ${JSON.stringify(parser)};`,
    'export default [',
    "  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/vendor/**', '**/*.min.js'] },",
    '  {',
    "    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],",
    '    plugins: { security },',
    '    rules: security.configs.recommended.rules,',
    "    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },",
    '  },',
    '];',
    '',
  ].join('\n');
}

function runEslint(tool, dir, timeoutMs) {
  const cfg = path.join(dir, ESLINT_CONFIG_NAME);
  fs.writeFileSync(cfg, eslintConfig(tool.dir));
  const outFile = path.join(path.dirname(dir), `${path.basename(dir)}.eslint.json`);
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [
    path.join(tool.dir, 'node_modules', 'eslint', 'bin', 'eslint.js'),
    '--config', cfg, '--format', 'json', '--output-file', outFile, '--no-error-on-unmatched-pattern', '.',
  ], { cwd: dir, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs });
  const seconds = elapsedSeconds(start);
  if (timedOut(r)) return { status: STATUS.timedOut, seconds, exit: null };
  let json;
  try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { json = null; } // error-ok — reported as failed below
  if (!Array.isArray(json)) return { status: `${STATUS.failed} (exit ${r.status}) — no JSON output`, exit: r.status, seconds, stderr: tail(`${r.stdout}\n${r.stderr}`) };
  let error = 0; let warning = 0; let fatal = 0;
  for (const f of json) {
    fatal += f.fatalErrorCount || 0;
    for (const m of f.messages || []) {
      if (m.fatal) continue; // counted above — a parse failure is not a security finding
      if (m.severity === 2) error += 1; else if (m.severity === 1) warning += 1;
    }
  }
  return { status: STATUS.ok, error, warning, fatal, files: json.length, exit: r.status, seconds };
}

// ---------------------------------------------------------------------------
// CodeQL
// ---------------------------------------------------------------------------

// CodeQL's own `--language=` identifiers, keyed by the display name
// detectLanguage() returns — the one definition ESLint's JS_TS gate also
// reads. TypeScript is analysed under CodeQL's combined "javascript"
// extractor (it understands both). A language with no entry here (Rust, PHP,
// Kotlin, unknown, as of this adapter) has no security-extended suite to run,
// so a repo detected as one is "not measured" with that reason — never a
// silent zero.
const CODEQL_LANG = Object.freeze({
  JavaScript: 'javascript', TypeScript: 'javascript',
  Python: 'python', Ruby: 'ruby', Go: 'go', Java: 'java',
  'C#': 'csharp', Swift: 'swift',
});
// Interpreted languages CodeQL can extract without compiling the project.
// Java/C#/Swift still go through `database create`'s autobuild, which fails
// (honestly, as "not measured") on a repo it cannot build unassisted.
const CODEQL_BUILD_MODE_NONE = new Set(['javascript', 'python', 'ruby', 'go']);

/**
 * The database + SARIF paths for one repo's CodeQL run — always a sibling of
 * the clone inside the script's own tmp dir, never inside the clone itself,
 * so the repository under test never gains an untracked directory
 * (tests/head-to-head.test.js pins this the same way it pins the throwaway
 * ESLint toolchain never installing into this repository).
 */
function codeqlPaths(dir) {
  const base = path.join(path.dirname(dir), path.basename(dir));
  return { db: `${base}.codeql-db`, sarif: `${base}.codeql.sarif` };
}

/** Find a runnable CodeQL CLI: CODEQL_HOME first (the workflow sets it), then PATH. */
function findCodeql() {
  const exe = process.platform === 'win32' ? 'codeql.exe' : 'codeql';
  const candidates = [];
  if (process.env.CODEQL_HOME) candidates.push(path.join(process.env.CODEQL_HOME, exe));
  candidates.push(exe);
  for (const bin of candidates) {
    let r;
    try { r = spawnSync(bin, ['version', '--format=terse'], { encoding: 'utf8', timeout: 60000 }); } catch { continue; } // error-ok — not a codeql
    if (r.status === 0 && r.stdout.trim()) return { bin, version: r.stdout.trim().split('\n').pop().trim() };
  }
  return null;
}

/**
 * CodeQL SARIF severity mapping — the ONE definition of "blocking-equivalent"
 * for this column, so a code path and its test can never disagree on the
 * count. A result counts as blocking-equivalent when EITHER:
 *   - its own SARIF `level` is "error", or
 *   - its rule's (or its own) `problem.severity` property is "error", or
 *   - its `security-severity` score (a CVSS-style 0-10 the query suite sets)
 *     is >= 7.0 — CVSS "high" and above, mirroring the bar GateTest's own
 *     error severity sets for blocking.
 * Everything else (level warning/note/none with no qualifying severity) is
 * counted in the total but not blocking-equivalent.
 */
function isCodeqlBlocking(result, rules) {
  if (String(result.level || '').toLowerCase() === 'error') return true;
  const idx = Number.isInteger(result.ruleIndex) ? result.ruleIndex
    : (result.rule && Number.isInteger(result.rule.index) ? result.rule.index : null);
  const rule = Number.isInteger(idx) ? rules[idx] : null;
  const props = { ...((rule && rule.properties) || {}), ...(result.properties || {}) };
  if (String(props['problem.severity'] || '').toLowerCase() === 'error') return true;
  const sev = Number(props['security-severity']);
  return Number.isFinite(sev) && sev >= 7.0;
}

/** Blocking-equivalent / total counts from one CodeQL SARIF document (first run only — this adapter writes exactly one). */
function countCodeqlSarif(sarif) {
  const run = sarif && Array.isArray(sarif.runs) ? sarif.runs[0] : null;
  const rules = (run && run.tool && run.tool.driver && Array.isArray(run.tool.driver.rules)) ? run.tool.driver.rules : [];
  const results = (run && Array.isArray(run.results)) ? run.results : [];
  let blocking = 0;
  for (const r of results) { if (isCodeqlBlocking(r, rules)) blocking += 1; }
  return { blocking, total: results.length };
}

/**
 * One repo's CodeQL measurement: `database create` then `database analyze`
 * with the language's `*-security-extended.qls` suite. Any failure — an
 * unsupported language, a timeout on either step, or a non-zero exit from
 * either step — is written as "not measured" with the reason; this column
 * never reports a zero it did not actually count (Doctrine #1).
 */
function runCodeql(tool, dir, language, timeoutMs) {
  const lang = CODEQL_LANG[language];
  if (!lang) return { status: STATUS.notMeasured, seconds: 0, language, reason: `CodeQL has no security-extended query suite for ${language}` };
  const { db, sarif: sarifOut } = codeqlPaths(dir);
  fs.rmSync(db, { recursive: true, force: true });
  const start = process.hrtime.bigint();
  const createArgs = ['database', 'create', db, `--language=${lang}`, '--source-root', dir, '--overwrite'];
  if (CODEQL_BUILD_MODE_NONE.has(lang)) createArgs.push('--build-mode=none');
  const create = spawnSync(tool.bin, createArgs, { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs });
  let seconds = elapsedSeconds(start);
  if (timedOut(create)) return { status: STATUS.notMeasured, seconds, language, reason: `codeql database create timed out after ${seconds} s` };
  if (create.status !== 0) return { status: STATUS.notMeasured, seconds, language, reason: `codeql database create failed (exit ${create.status}): ${tail(create.stderr)}` };

  const remainingMs = Math.max(timeoutMs - Math.round(seconds * 1000), 30000);
  const analyze = spawnSync(tool.bin, [
    'database', 'analyze', db, '--format=sarif-latest', '--output', sarifOut, `${lang}-security-extended.qls`,
  ], { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: remainingMs });
  seconds = elapsedSeconds(start);
  if (timedOut(analyze)) return { status: STATUS.notMeasured, seconds, language, reason: `codeql database analyze timed out after ${seconds} s` };
  if (analyze.status !== 0) return { status: STATUS.notMeasured, seconds, language, reason: `codeql database analyze failed (exit ${analyze.status}): ${tail(analyze.stderr)}` };

  let sarifDoc;
  try { sarifDoc = JSON.parse(fs.readFileSync(sarifOut, 'utf8')); } catch (err) {
    return { status: STATUS.notMeasured, seconds, language, reason: `could not read the SARIF output: ${err.message}` }; // error-ok — reported as not-measured
  }
  const { blocking, total } = countCodeqlSarif(sarifDoc);
  return { status: STATUS.ok, blocking, total, language, seconds };
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function engineCommit() {
  try {
    return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown';
  } catch { return 'unknown'; } // error-ok — a missing .git only costs the label
}

function buildDocument({ opts, manifest, measured, semgrep, eslint, codeql, semgrepReason, eslintReason, codeqlReason }) {
  return {
    schemaVersion: h2h.SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: h2h.SOURCE,
    note: 'Measured on pinned commits of repositories we do not control, every tool on the same clone. Counts are not comparable one-to-one across tools; each column is what that tool reports and how long it took. A tool that was not run says so. Do not hand-edit — run the script.',
    engineVersion: gatetestVersion(),
    engineCommit: engineCommit(),
    suite: opts.suite,
    corpusSize: manifest.repos.length,
    toolTimeoutSeconds: Math.round(opts.timeoutMs / 1000),
    runner: { platform: process.platform, arch: process.arch, node: process.version },
    tools: {
      gatetest: { version: gatetestVersion(), command: `gatetest scan --suite ${opts.suite} --project <clone>` },
      semgrep: semgrep
        ? { version: semgrep.version, config: 'auto', command: 'semgrep --config auto --json --quiet --output <file> .' }
        : { version: null, config: 'auto', reason: semgrepReason },
      eslintSecurity: eslint && eslint.ok
        ? { version: eslint.version, pluginVersion: eslint.pluginVersion, parserVersion: eslint.parserVersion, installSeconds: eslint.installSeconds, command: 'eslint --config <security-only flat config> --format json .' }
        : { version: null, reason: eslintReason },
      sonarqube: {
        status: STATUS.notMeasured,
        reason: 'needs a running SonarQube server and a scanner token; no server is provisioned for the corpus yet, and no number is written until one measures it',
      },
      codeql: codeql
        ? {
          version: codeql.version,
          command: 'codeql database create <tmp>/<repo>.codeql-db --language=<lang> [--build-mode=none] --source-root <clone> --overwrite && codeql database analyze <db> --format=sarif-latest --output <tmp>/<repo>.codeql.sarif <lang>-security-extended.qls',
        }
        : { version: null, reason: codeqlReason },
    },
    repos: measured,
  };
}

/** Rows from the previous file for repos this run did not measure (--merge). */
function previousRows(outPath, measuredNames) {
  let prev;
  try { prev = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { return []; } // error-ok — nothing to merge
  if (h2h.validateHeadToHead(prev).length) {
    log(`(merge) ${path.relative(ROOT, outPath)} does not validate — starting fresh`);
    return [];
  }
  return prev.repos.filter((r) => !measuredNames.has(r.name));
}

function printTable(doc) {
  const table = h2h.buildTable(doc);
  const pad = (s, n) => String(s).padEnd(n);
  // gatetest, semgrep, eslintSecurity, codeql — sonarqube is a single fact
  // for every row (it is never run), so it gets one footer line instead.
  const idxs = [0, 1, 2, 4];
  const w = [18, 11, 34, 44, 40, 40];
  const cols = ['Repository', 'Language', ...idxs.map((i) => `${table.columns[i].label}${table.columns[i].version ? ` ${table.columns[i].version}` : ''}`)];
  console.log(cols.map((c, i) => pad(c, w[i])).join('  '));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const row of table.rows) {
    const cells = idxs.map((i) => `${row.cells[i].text}${row.cells[i].detail ? ` (${row.cells[i].detail})` : ''}`);
    console.log([row.name, row.language, ...cells].map((c, i) => pad(c, w[i])).join('  '));
  }
  console.log(`\nSonarQube: ${table.rows[0] ? table.rows[0].cells[3].text : STATUS.notMeasured}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let repos = h2h.limitRepos(manifest.repos, opts.repos);
  if (opts.only.length) {
    const missing = opts.only.filter((n) => !manifest.repos.some((r) => r.name === n));
    if (missing.length) { log(`No repo named ${missing.join(', ')} in ${path.relative(ROOT, MANIFEST)}`); process.exit(2); }
    repos = h2h.orderRepos(manifest.repos).filter((r) => opts.only.includes(r.name));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-h2h-'));
  const failures = [];
  const measured = [];

  let semgrep = null; let semgrepReason;
  if (opts.semgrep) {
    semgrep = findSemgrep();
    semgrepReason = semgrep ? undefined : 'semgrep is not installed on this runner (tried PATH and the per-user pip Scripts dir)';
    log(semgrep ? `semgrep ${semgrep.version} (${semgrep.bin})` : `semgrep: ${semgrepReason}`);
  } else semgrepReason = 'skipped with --no-semgrep';

  let eslint = null; let eslintReason;
  if (opts.eslint) {
    log(`installing the throwaway ESLint toolchain (${ESLINT_PACKAGES.join(', ')}) in ${tmp}`);
    eslint = setupEslint(tmp);
    eslintReason = eslint.ok ? undefined : eslint.reason;
    log(eslint.ok ? `eslint ${eslint.version}, eslint-plugin-security ${eslint.pluginVersion} (${eslint.installSeconds} s to install)` : `eslint: ${eslint.reason}`);
  } else eslintReason = 'skipped with --no-eslint';

  let codeql = null; let codeqlReason;
  if (opts.codeql) {
    codeql = findCodeql();
    codeqlReason = codeql ? undefined : 'the CodeQL CLI is not installed on this runner (tried CODEQL_HOME and PATH)';
    log(codeql ? `codeql ${codeql.version} (${codeql.bin})` : `codeql: ${codeqlReason}`);
  } else codeqlReason = 'skipped with --no-codeql';

  // Rows this run keeps from the previous file (--merge) ride along with the
  // measured ones; the manifest order is the table order.
  const kept = opts.merge ? previousRows(opts.out, new Set(repos.map((r) => r.name))) : [];
  const byManifest = h2h.orderRepos(manifest.repos).map((r) => r.name);

  // Write after every repo: a run killed at repo 12 still leaves a valid
  // file for the 11 it measured, instead of an hour of work in a dead
  // process. Each write is the whole document, validated.
  const writeDocument = () => {
    const rows = [...measured, ...kept].sort((a, b) => byManifest.indexOf(a.name) - byManifest.indexOf(b.name));
    const doc = buildDocument({ opts, manifest, measured: rows, semgrep, eslint, codeql, semgrepReason, eslintReason, codeqlReason });
    const problems = h2h.validateHeadToHead(doc);
    if (problems.length) {
      log('\nBUG: the document this script built does not validate — not writing:');
      for (const p of problems) log(`  - ${p}`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`);
    return doc;
  };

  try {
    for (const repo of repos) {
      const dest = path.join(tmp, repo.name);
      log(`\n--- ${repo.name} @ ${repo.sha.slice(0, 8)}`);
      try {
        clone(repo, dest);
      } catch (err) {
        failures.push(`${repo.name}: could not be cloned — ${err.message}`);
        log(`    ERROR  ${err.message}`);
        continue;
      }
      const { language, fileCounts } = detectLanguage(dest);
      const row = {
        name: repo.name, url: repo.url, sha: repo.sha, language, fileCounts,
        role: typeof repo.minBlocking === 'number' ? 'recall' : 'precision',
        measuredAt: new Date().toISOString(),
      };

      row.gatetest = runGatetest(dest, opts.suite, opts.timeoutMs);
      log(`    gatetest  ${row.gatetest.status === STATUS.ok ? `${row.gatetest.blocking} blocking / ${row.gatetest.total} findings` : row.gatetest.status}  ${row.gatetest.seconds} s`);
      // The scan's own report tree must not be scanned by the next tool.
      fs.rmSync(path.join(dest, '.gatetest'), { recursive: true, force: true });

      if (semgrep) {
        row.semgrep = runSemgrep(semgrep, dest, opts.timeoutMs);
        log(`    semgrep   ${row.semgrep.status === STATUS.ok ? `${row.semgrep.error} error / ${row.semgrep.warning} warning / ${row.semgrep.info} info (exit ${row.semgrep.exit})` : row.semgrep.status}  ${row.semgrep.seconds} s`);
      } else {
        row.semgrep = { status: opts.semgrep ? STATUS.unavailable : STATUS.notRun, seconds: 0, reason: semgrepReason };
        log(`    semgrep   ${row.semgrep.status}`);
      }

      if (!JS_TS.has(language)) {
        row.eslintSecurity = null;
        log(`    eslint    not run (${language})`);
      } else if (eslint && eslint.ok) {
        row.eslintSecurity = runEslint(eslint, dest, opts.timeoutMs);
        log(`    eslint    ${row.eslintSecurity.status === STATUS.ok ? `${row.eslintSecurity.error} error / ${row.eslintSecurity.warning} warning / ${row.eslintSecurity.fatal} parse failures` : row.eslintSecurity.status}  ${row.eslintSecurity.seconds} s`);
      } else {
        row.eslintSecurity = { status: opts.eslint ? STATUS.unavailable : STATUS.notRun, seconds: 0, reason: eslintReason };
        log(`    eslint    ${row.eslintSecurity.status}`);
      }

      row.codeql = codeql
        ? runCodeql(codeql, dest, language, opts.timeoutMs)
        : { status: STATUS.notMeasured, seconds: 0, language, reason: codeqlReason };
      log(`    codeql    ${row.codeql.status === STATUS.ok
        ? `${row.codeql.blocking} blocking-equivalent / ${row.codeql.total} results (${row.codeql.language})`
        : `${row.codeql.status} — ${row.codeql.reason}`}  ${row.codeql.seconds} s`);

      measured.push(row);
      writeDocument();
      // Free the disk before the next clone; the verdict is already in `row`.
      if (!opts.keep) removeTmp(dest);
    }
  } finally {
    if (!opts.keep) removeTmp(tmp);
  }

  if (measured.length === 0) {
    log('\nNothing measured — not writing.');
    for (const f of failures) log(`  - ${f}`);
    process.exit(1);
  }

  const doc = writeDocument();
  const shown = path.relative(ROOT, opts.out).startsWith('..') ? opts.out : path.relative(ROOT, opts.out);
  log(`\nWrote ${shown} (${doc.repos.length} of ${manifest.repos.length} repos, engine ${doc.engineVersion}@${doc.engineCommit})`);

  if (opts.json) console.log(JSON.stringify(doc, null, 2));
  else { console.log(''); printTable(doc); }

  if (failures.length) {
    log('\nSome repositories could not be measured:');
    for (const f of failures) log(`  - ${f}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs, detectLanguage, countSemgrep, eslintConfig, buildDocument, ESLINT_PACKAGES,
  CODEQL_LANG, codeqlPaths, findCodeql, isCodeqlBlocking, countCodeqlSarif, runCodeql,
};
