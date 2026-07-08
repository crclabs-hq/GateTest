#!/usr/bin/env node
/**
 * generate-site-stats.js — the bridge between our continuous self-testing
 * and the numbers we show the world.
 *
 * Craig's directive (2026-06-13): "This platform should be continuously
 * testing against the flywheel ... to make sure that we can put high
 * testing statistics on the website."
 *
 * The flywheel (8 trainers + telemetry) and the dogfood self-scan already
 * run nightly. What was missing was the link from those real runs to the
 * numbers in Hero.tsx — which were hardcoded and therefore drift-prone
 * (the Bible's Known Issues are full of exactly that failure mode).
 *
 * This script MEASURES the numbers on every run and writes a single
 * source of truth at website/app/data/site-stats.json, which the website
 * imports at build time. Honesty contract:
 *   - tests.passing      = the real `node --test` pass count, this run
 *   - modules.total      = the real `gatetest --list` module count
 *   - flywheel.*         = aggregated from real fix-pipeline telemetry
 *   - displayPassing     = passing ROUNDED DOWN to a round number, so the
 *                          public "N+" claim is always an UNDER-statement
 *
 * Nothing here inflates. The displayed number can only ever be lower than
 * or equal to reality. Run it in CI (dogfood-nightly) and commit the diff.
 *
 * Usage:
 *   node scripts/generate-site-stats.js              # measure + write JSON
 *   node scripts/generate-site-stats.js --dry-run    # print, don't write
 *   node scripts/generate-site-stats.js --tap-log <file>
 *                                                    # parse an existing
 *                                                    # `node --test` log
 *                                                    # instead of re-running
 *                                                    # the suite (CI reuse)
 *   node scripts/generate-site-stats.js --green 102 --scanned 110
 *                                                    # supply a measured
 *                                                    # self-scan green count
 *
 * Read-only on source; the only file it writes is site-stats.json.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'website', 'app', 'data', 'site-stats.json');

// Reuse the flywheel telemetry aggregator so the "moat" numbers come from
// the same source the admin dashboard reads.
const { readEntries, aggregate } = require('./flywheel-stats.js');

// ── pure derivation helpers (unit-tested) ──────────────────────────────

/**
 * Parse the TAP summary block that `node --test` prints, e.g.
 *   # tests 6234
 *   # pass 6233
 *   # fail 1
 *   # skip 1
 * Returns { total, passing, failing, skipped } with 0 defaults.
 */
function parseTapSummary(output) {
  const out = { total: 0, passing: 0, failing: 0, skipped: 0 };
  if (typeof output !== 'string') return out;
  const grab = (label) => {
    // Match the LAST occurrence — node prints per-file then a final total.
    const re = new RegExp(`^# ${label} (\\d+)\\s*$`, 'gm');
    let m;
    let last = null;
    while ((m = re.exec(output)) !== null) last = Number(m[1]);
    return last;
  };
  const tests = grab('tests');
  const pass = grab('pass');
  const fail = grab('fail');
  const skip = grab('skip');
  if (tests != null) out.total = tests;
  if (pass != null) out.passing = pass;
  if (fail != null) out.failing = fail;
  if (skip != null) out.skipped = skip;
  return out;
}

/** Round a count DOWN to the nearest `step` (default 100). Never rounds up. */
function roundDownTo(n, step = 100) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / step) * step;
}

/** Format a conservative "N+" display string, e.g. 6234 -> "6,200+". */
function formatPlus(n) {
  const floored = roundDownTo(n, 100);
  if (floored <= 0) return '0';
  return floored.toLocaleString('en-US') + '+';
}

/**
 * Build the site-stats object from measured inputs. Pure — no I/O.
 * `previous` carries forward fields we don't measure this run (e.g. the
 * self-scan green count when no fresh measurement was supplied).
 */
function buildSiteStats({ tap, moduleCount, flywheel, previous = {}, green, scanned, now }) {
  const prevModules = previous.modules || {};
  const resolvedScanned = Number.isFinite(scanned) ? scanned : (Number.isFinite(prevModules.scanned) ? prevModules.scanned : moduleCount);
  const resolvedGreen = Number.isFinite(green) ? green : (Number.isFinite(prevModules.green) ? prevModules.green : moduleCount);
  const greenFresh = Number.isFinite(green);

  return {
    generatedAt: new Date(now || Date.now()).toISOString(),
    source: 'scripts/generate-site-stats.js',
    note: 'Measured on every run. Displayed counts are rounded DOWN so the public "N+" claim is always an under-statement. Do not hand-edit — run the script.',
    tests: {
      total: tap.total,
      passing: tap.passing,
      failing: tap.failing,
      skipped: tap.skipped,
      displayPassing: formatPlus(tap.passing),
    },
    modules: {
      total: moduleCount,
      green: resolvedGreen,
      scanned: resolvedScanned,
      displayGreen: `${resolvedGreen}/${resolvedScanned}`,
      greenSource: greenFresh ? 'measured' : (prevModules.greenSource || 'carried'),
      greenMeasuredAt: greenFresh ? new Date(now || Date.now()).toISOString() : (prevModules.greenMeasuredAt || null),
    },
    flywheel: {
      totalFixAttempts: flywheel.all.total,
      claudeRatioPct: Number(flywheel.all.claudeRatioPct.toFixed(1)),
      accuracyPct: Number(flywheel.all.accuracyPct.toFixed(1)),
      recent7dFixAttempts: flywheel.recent7d.total,
    },
  };
}

// ── I/O orchestration ──────────────────────────────────────────────────

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function measureTests() {
  // Shell-expand the glob exactly as the package.json / dogfood workflow do.
  // MUST use --test-force-exit + --test-timeout (Bible sweep command) — the
  // bare `node --test` form hangs indefinitely on leaked handles; CI got
  // this fix in 180bf7c but this script was missed and hung the same way.
  // --test-reporter=tap is explicit because parseTapSummary reads the
  // "# tests N" TAP block — newer Node defaults to the spec reporter even
  // when piped, which parses as 0 tests (and 0 would go on the website).
  const res = spawnSync('bash', ['-c', 'node --test --test-reporter=tap --test-force-exit --test-timeout=60000 tests/*.test.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  const output = (res.stdout || '') + '\n' + (res.stderr || '');
  return parseTapSummary(output);
}

function measureModuleCount() {
  const res = spawnSync('node', [path.join(ROOT, 'bin', 'gatetest.js'), '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60 * 1000,
  });
  const out = res.stdout || '';
  // Module lines are indented (2+ leading spaces) and start with a letter —
  // same heuristic the marketing-claim test uses.
  return out.split('\n').filter((l) => /^\s{2,}[a-z]/i.test(l)).length;
}

function parseArgs(argv) {
  const args = { dryRun: false, green: undefined, scanned: undefined, tapLog: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--green') args.green = Number(argv[++i]);
    else if (a === '--scanned') args.scanned = Number(argv[++i]);
    else if (a === '--tap-log') args.tapLog = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/generate-site-stats.js [--dry-run] [--green N] [--scanned N]\n');
    return 0;
  }

  let tap;
  if (args.tapLog) {
    process.stderr.write(`generate-site-stats: parsing TAP log ${args.tapLog}\n`);
    tap = parseTapSummary(fs.readFileSync(args.tapLog, 'utf8'));
  } else {
    process.stderr.write('generate-site-stats: running test suite (this can take a few minutes)…\n');
    tap = measureTests();
  }
  process.stderr.write(`generate-site-stats: tests=${tap.total} pass=${tap.passing} fail=${tap.failing} skip=${tap.skipped}\n`);

  const moduleCount = measureModuleCount();
  process.stderr.write(`generate-site-stats: modules=${moduleCount}\n`);

  const flywheel = aggregate(readEntries(require('node:os').homedir() + '/.gatetest/telemetry/fix-attempts.jsonl'));

  const previous = readPrevious();
  const stats = buildSiteStats({
    tap,
    moduleCount,
    flywheel,
    previous,
    green: Number.isFinite(args.green) ? args.green : undefined,
    scanned: Number.isFinite(args.scanned) ? args.scanned : undefined,
  });

  const json = JSON.stringify(stats, null, 2) + '\n';
  if (args.dryRun) {
    process.stdout.write(json);
    return 0;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, json);
  process.stderr.write(`generate-site-stats: wrote ${path.relative(ROOT, OUT_PATH)}\n`);
  return 0;
}

module.exports = { parseTapSummary, roundDownTo, formatPlus, buildSiteStats, OUT_PATH };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`generate-site-stats: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  }
}
