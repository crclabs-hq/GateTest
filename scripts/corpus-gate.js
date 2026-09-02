#!/usr/bin/env node
/**
 * corpus-gate — precision AND recall, pinned, on real third-party repos.
 *
 * Why this exists (2026-09-02). The nine-repo benchmark that found four
 * scope defects on 2026-09-01 (docs/benchmarks/2026-09-01-corpus-nine-repos.md)
 * was run by hand. Nothing referenced it from CI. The same day, precision
 * fixes over-muted two rules and the only thing that noticed was a pair of
 * negative-control unit tests — and those only failed on Linux. A benchmark
 * that is run by hand is run when someone remembers, and a dev agent kicking
 * the tyres on a Tuesday afternoon does not wait for that.
 *
 * What it pins, per repo, against a committed baseline
 * (benchmarks/corpus/baselines/<name>.json):
 *
 *   clean repos (kind: "clean")
 *     - every BLOCKING finding must already be in the baseline. A new blocking
 *       signature on a repo asserted clean is a false positive until a human
 *       reviews it and re-captures. (The baseline may legitimately hold a
 *       few: lodash's devDependency CVEs are real. They are itemised, never
 *       a count.)
 *     - per-module WARNING volume may not exceed baseline * 1.25 + 5. A rule
 *       that starts firing 300 times on axios is a bug even though it never
 *       blocks — volume is how a tool teaches developers to stop reading it.
 *
 *   vulnerable repos (kind: "vulnerable")
 *     - every blocking CLASS (module:rule) in the baseline must still fire.
 *       Precision work that silences a planted bug is a recall regression,
 *       and "recall did not move once" is the only reason a precision change
 *       can be trusted.
 *     - total blocking may not drop below 80% of baseline.
 *
 * Exit 1 on any violation. `--capture` rewrites baselines from the current
 * engine so a reviewed change can be accepted in the same PR — the diff of
 * the baseline file IS the review artifact.
 *
 * Usage:
 *   node scripts/corpus-gate.js                 # gate every repo
 *   node scripts/corpus-gate.js --only axios    # one repo (repeatable)
 *   node scripts/corpus-gate.js --capture       # rewrite baselines
 *   node scripts/corpus-gate.js --cache /path   # clone cache (default .corpus-cache)
 *   node scripts/corpus-gate.js --json          # machine-readable report on stdout
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'benchmarks', 'corpus', 'manifest.json');
const BASELINES = path.join(ROOT, 'benchmarks', 'corpus', 'baselines');
const { isBlockingFinding } = require(path.join(ROOT, 'src', 'core', 'confidence.js'));

const WARNING_GROWTH = 1.25;
const WARNING_SLACK = 5;
const RECALL_FLOOR = 0.8;

function parseArgs(argv) {
  const out = { only: [], capture: false, json: false, cache: path.join(ROOT, '.corpus-cache') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') out.only.push(argv[++i]);
    else if (a === '--capture') out.capture = true;
    else if (a === '--json') out.json = true;
    else if (a === '--cache') out.cache = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

/** Shallow-ish clone pinned to a SHA. Partial clone keeps juice-shop at ~60 MB. */
function ensureCheckout(entry, cacheDir) {
  const dir = path.join(cacheDir, entry.name);
  const at = () => run('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
  if (fs.existsSync(path.join(dir, '.git')) && at() === entry.sha) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const url = `https://github.com/${entry.repo}.git`;
  let r = run('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', url, dir]);
  if (r.status !== 0) throw new Error(`clone ${entry.repo} failed: ${r.stderr}`);
  r = run('git', ['checkout', '-q', entry.sha], { cwd: dir });
  if (r.status !== 0) throw new Error(`checkout ${entry.sha} in ${entry.repo} failed: ${r.stderr}`);
  if (at() !== entry.sha) throw new Error(`${entry.name}: HEAD ${at()} != pinned ${entry.sha}`);
  return dir;
}

/** Strip line numbers and other per-run noise so a signature is stable. */
function signature(moduleName, check) {
  const name = String(check.name || '')
    .replace(/:\d+(?::\d+)?$/, '')        // trailing :line or :line:col
    .replace(/:\d+(?=:)/g, ':N')          // interior line numbers
    .replace(/\s+at line \d+/g, '');
  return `${moduleName}|${name}`;
}

function classOf(sig) {
  // module|rule:detail... -> module:rule (the first two colon segments of the name)
  const [mod, name] = sig.split('|');
  const parts = name.split(':');
  return `${mod}:${parts[0]}${parts.length > 1 ? ':' + parts[1] : ''}`;
}

function scanRepo(dir, manifest) {
  const args = [path.join(ROOT, 'bin', 'gatetest.js'), '--suite', 'full', '--parallel', '--project', dir];
  for (const m of manifest.skipModules || []) args.push('--skip-module', m);
  const r = run(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, GATETEST_NO_TELEMETRY: '1', GATETEST_ADMIN: '', CI: '1' },
  });
  const reportPath = path.join(dir, '.gatetest', 'reports', 'gatetest-report-latest.json');
  if (!fs.existsSync(reportPath)) {
    throw new Error(`no report written for ${dir} (exit ${r.status})\n${(r.stderr || r.stdout).slice(-2000)}`);
  }
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function measure(report) {
  const blocking = new Set();
  const warnings = {};
  let blockingCount = 0;
  for (const m of report.results || []) {
    const mod = m.module || m.name;
    for (const c of m.checks || []) {
      if (c.passed || c.suppressReason) continue;
      if (isBlockingFinding(c)) { blocking.add(signature(mod, c)); blockingCount++; }
      else if (c.severity === 'warning') warnings[mod] = (warnings[mod] || 0) + 1;
    }
  }
  const modulesRan = (report.results || []).length;
  return { blocking: [...blocking].sort(), blockingCount, warnings, modulesRan };
}

function baselinePath(name) { return path.join(BASELINES, `${name}.json`); }

function compare(entry, measured, baseline) {
  const failures = [];
  if (!baseline) {
    failures.push(`no baseline — run \`node scripts/corpus-gate.js --capture --only ${entry.name}\` and commit the file`);
    return failures;
  }
  if (entry.kind === 'clean') {
    const known = new Set(baseline.blocking);
    for (const sig of measured.blocking) {
      if (!known.has(sig)) failures.push(`NEW BLOCKING finding on a clean repo (false positive until reviewed): ${sig}`);
    }
    for (const [mod, n] of Object.entries(measured.warnings)) {
      const base = baseline.warnings[mod] || 0;
      const ceiling = Math.ceil(base * WARNING_GROWTH + WARNING_SLACK);
      if (n > ceiling) failures.push(`warning volume regression in ${mod}: ${n} > ceiling ${ceiling} (baseline ${base})`);
    }
  } else {
    const have = new Set(measured.blocking.map(classOf));
    const mustFire = new Set(baseline.blocking.map(classOf));
    for (const cls of mustFire) {
      if (!have.has(cls)) failures.push(`RECALL regression: planted class no longer detected: ${cls}`);
    }
    const floor = Math.floor(baseline.blockingCount * RECALL_FLOOR);
    if (measured.blockingCount < floor) {
      failures.push(`RECALL regression: blocking ${measured.blockingCount} < floor ${floor} (baseline ${baseline.blockingCount})`);
    }
  }
  return failures;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const repos = manifest.repos.filter((r) => args.only.length === 0 || args.only.includes(r.name));
  if (repos.length === 0) throw new Error('no repos selected');

  const rows = [];
  let failed = false;
  for (const entry of repos) {
    const started = Date.now();
    const dir = ensureCheckout(entry, args.cache);
    const report = scanRepo(dir, manifest);
    const measured = measure(report);
    let failures = [];
    if (args.capture) {
      fs.mkdirSync(BASELINES, { recursive: true });
      const out = {
        name: entry.name, repo: entry.repo, sha: entry.sha, kind: entry.kind,
        capturedAt: new Date().toISOString().slice(0, 10),
        engine: require(path.join(ROOT, 'package.json')).version,
        modulesRan: measured.modulesRan,
        blockingCount: measured.blockingCount,
        blocking: measured.blocking,
        warnings: measured.warnings,
      };
      fs.writeFileSync(baselinePath(entry.name), JSON.stringify(out, null, 2) + '\n');
    } else {
      const baseline = fs.existsSync(baselinePath(entry.name)) ? JSON.parse(fs.readFileSync(baselinePath(entry.name), 'utf8')) : null;
      failures = compare(entry, measured, baseline);
    }
    if (failures.length) failed = true;
    const totalWarnings = Object.values(measured.warnings).reduce((a, b) => a + b, 0);
    rows.push({ name: entry.name, kind: entry.kind, modules: measured.modulesRan, blocking: measured.blockingCount, warnings: totalWarnings, seconds: Math.round((Date.now() - started) / 1000), failures });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: !failed, captured: args.capture, rows }, null, 2) + '\n');
  } else {
    console.log('\nrepo        kind        modules  blocking  warnings  secs');
    for (const r of rows) {
      console.log(`${r.name.padEnd(11)} ${r.kind.padEnd(11)} ${String(r.modules).padStart(7)}  ${String(r.blocking).padStart(8)}  ${String(r.warnings).padStart(8)}  ${String(r.seconds).padStart(4)}`);
      for (const f of r.failures) console.log(`    ✗ ${f}`);
    }
    console.log(args.capture ? '\nbaselines captured' : failed ? '\nCORPUS GATE: FAILED' : '\nCORPUS GATE: PASSED');
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { signature, classOf, measure, compare };

if (require.main === module) {
  try { main(); } catch (err) {
    console.error(`corpus-gate: ${err.message}`);
    process.exit(2);
  }
}
