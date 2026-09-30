'use strict';
/**
 * Flaky-test ledger — what the engine learns about a customer's tests by
 * running them more than once (launch board move 6).
 *
 * The static `flakyTests` module reads test SOURCE and flags shapes that tend
 * to flake. It cannot know whether a test actually did. This ledger can: every
 * time the engine runs the customer's suite (src/modules/unit-tests.js) it
 * records each test's pass/fail, and a test that both passed and failed on the
 * same commit — or flips 2+ times in the last 10 runs — is a measured flake.
 *
 * What a flake gets:
 *   - its FAILURE is reported as a warning ("quarantined flaky test (flipped 3
 *     of last 10 runs)") instead of blocking the gate, listed in the console,
 *     the JSON report (`flaky[]`) and the PR comment;
 *   - the quarantine EXPIRES (default 14 days from the first time it was
 *     flagged). After that the failure blocks again unless the flake is fixed
 *     — a quarantine is a loan, not a waiver;
 *   - `--no-quarantine` (or `flaky.quarantine: false`) turns it off.
 *
 * What a flake never gets (Doctrine 1 — reports success while doing nothing):
 *   - a test that fails on EVERY run in the window is not a flake, it is a
 *     failure, and it blocks whatever the ledger says;
 *   - a failure the parser could not fully account for (a hook that broke, a
 *     cancelled child, a runner whose output is not per-test parseable) is
 *     never downgraded — see src/core/test-outcomes.js `complete`;
 *   - a name that appears twice in one run with different outcomes is
 *     ambiguous, so it is neither recorded nor quarantined.
 *
 * Storage and privacy: `.gatetest/memory.json` (src/core/persistent-memory.js),
 * behind the SAME consent gate as telemetry (`telemetryEnabled` — GATETEST_NO_TELEMETRY,
 * `.gatetest.json` `telemetry:false`, --offline) and `--no-artifacts`. Test
 * names are never stored: a test is a 64-bit hash of its name path, so the
 * committed memory file carries no test names and nothing here can leak one
 * upstream. Only tests that have FAILED are tracked (their history is what a
 * flake verdict needs), so the ledger stays small on a healthy suite; the
 * denominator of the flake rate is a plain count.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const persistentMemory = require('./persistent-memory');
const { artifactsDisabled } = require('./report-paths');

const DEFAULTS = Object.freeze({ flips: 2, window: 10, quarantineDays: 14, quarantine: true });
const MAX_WINDOW = 50;
const LEDGER_VERSION = 1;
const DAY_MS = 86400_000;
/** A tracked test not seen for this long has left the suite — forget it. */
const FORGET_AFTER_MS = 90 * DAY_MS;
/** Hard cap on tracked tests: a suite failing wholesale must not bloat memory.json. */
const MAX_TRACKED = 500;

function _int(v, fallback, min, max) {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

/**
 * Effective settings: `.gatetest.json` `flaky` block, then the CLI/env off
 * switch. `config` is a GateTestConfig (or any object with `get(path)`).
 *
 * @returns {{ flips: number, window: number, quarantineDays: number, quarantine: boolean }}
 */
function resolveFlakyConfig(config, env = process.env) {
  const read = (key) => (config && typeof config.get === 'function' ? config.get(`flaky.${key}`) : undefined);
  const window = _int(read('window'), DEFAULTS.window, 2, MAX_WINDOW);
  const flips = _int(read('flips'), DEFAULTS.flips, 1, window);
  const quarantineDays = _int(read('quarantineDays'), DEFAULTS.quarantineDays, 1, 365);
  const off = read('quarantine') === false
    || (typeof env.GATETEST_NO_QUARANTINE === 'string' && env.GATETEST_NO_QUARANTINE !== '' && env.GATETEST_NO_QUARANTINE !== '0');
  return { flips, window, quarantineDays, quarantine: !off };
}

/**
 * May the ledger read and write at all? Same consent as telemetry, and nothing
 * is written under --no-artifacts. Says why not, so the report can (Doctrine 6).
 *
 * @returns {{ enabled: boolean, reason: string|null }}
 */
function ledgerGate(projectRoot, env = process.env) {
  let resolved = null;
  try { resolved = require('./scan-telemetry').resolveTelemetry(projectRoot, env); } catch { /* fall through */ } // error-ok
  if (!resolved || resolved.enabled !== true) {
    const why = resolved ? `${resolved.detail}` : 'consent could not be read';
    return { enabled: false, reason: `telemetry consent is off (${why})` };
  }
  if (artifactsDisabled()) return { enabled: false, reason: 'artifacts are off (--no-artifacts), so nothing can be recorded' };
  return { enabled: true, reason: null };
}

/** Hash of a test's name path. Never the name. */
function testKey(pathSegments) {
  return crypto.createHash('sha1').update(pathSegments.join('\u0001')).digest('hex').slice(0, 16);
}

/**
 * The commit a run belongs to — HEAD's short sha, or null when the working
 * tree has uncommitted source changes (then "the same commit" is not a claim
 * we can make) or git is unavailable. `.gatetest/` is ignored: the engine's own
 * memory file being modified is not a change to the code under test.
 */
function currentCommit(projectRoot) {
  try {
    const opts = { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 };
    const head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], opts).trim();
    if (!/^[0-9a-f]{7,}$/.test(head)) return null;
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.', ':(exclude).gatetest'], opts).trim();
    return dirty ? null : head;
  } catch {
    return null; // error-ok — no git, no claim about "the same commit"
  }
}

// ── History tokens: "p" / "f" then an optional 7-hex commit ───────────────────

function _tokens(h) { return typeof h === 'string' && h ? h.split(' ') : []; }
function _outcome(tok) { return tok[0] === 'f' ? 'f' : 'p'; }
function _commit(tok) { return tok.length > 1 ? tok.slice(1) : null; }

/**
 * Pure verdict for one test's history.
 *
 * @param {{ h?: string, since?: number|null }} entry
 * @param {{ flips: number, window: number, quarantineDays: number, quarantine: boolean }} cfg
 * @param {number} now epoch ms
 * @returns {{ flaky: boolean, flips: number, runs: number, sameCommit: boolean,
 *             allFailed: boolean, since: number|null, expiresAt: number|null,
 *             expired: boolean, quarantined: boolean }}
 */
function classify(entry, cfg, now) {
  const toks = _tokens(entry && entry.h).slice(-cfg.window);
  let flips = 0;
  for (let i = 1; i < toks.length; i++) if (_outcome(toks[i]) !== _outcome(toks[i - 1])) flips++;
  const seen = new Map();
  let sameCommit = false;
  for (const t of toks) {
    const c = _commit(t);
    if (!c) continue;
    const prev = seen.get(c);
    if (prev && prev !== _outcome(t)) sameCommit = true;
    seen.set(c, prev && prev !== _outcome(t) ? 'both' : _outcome(t));
  }
  const allFailed = toks.length > 0 && toks.every((t) => _outcome(t) === 'f');
  // A test that failed every run in the window has no flip and no same-commit
  // pair, so it is not flaky by the rules above; the explicit guard is the
  // doctrine line — whatever a future rule says, "fails every time" blocks.
  const flaky = !allFailed && (flips >= cfg.flips || sameCommit);
  const since = flaky ? ((entry && entry.since) || now) : null;
  const expiresAt = since === null ? null : since + cfg.quarantineDays * DAY_MS;
  const expired = flaky && now >= expiresAt;
  return {
    flaky, flips, runs: toks.length, sameCommit, allFailed, since, expiresAt, expired,
    quarantined: flaky && cfg.quarantine && !expired,
  };
}

function _emptyLedger() {
  return { version: LEDGER_VERSION, runs: 0, lastRun: null, tests: {} };
}

/**
 * Record one run's per-test outcomes and return a verdict for every test that
 * failed in it.
 *
 * @param {string} projectRoot
 * @param {ReturnType<import('./test-outcomes').parseTestOutcomes>} parsed
 * @param {{ cfg: object, now?: number, commit?: string|null }} opts
 * @returns {{ verdicts: Map<string, object>, ambiguous: Set<string>, flake: object }}
 */
function recordRun(projectRoot, parsed, opts) {
  const { cfg } = opts;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const commit = opts.commit === undefined ? currentCommit(projectRoot) : opts.commit;
  const data = persistentMemory.load(projectRoot);
  const ledger = (data.flakyLedger && data.flakyLedger.version === LEDGER_VERSION && data.flakyLedger.tests)
    ? data.flakyLedger
    : _emptyLedger();

  // Leaves only, and only outcomes that say something about the TEST: a hook
  // failure or a cancelled child is the harness.
  const byKey = new Map();
  for (const o of parsed.outcomes) {
    if (o.container) continue;
    if (!o.ok && !o.testFailure) continue;
    const key = testKey(o.path);
    const list = byKey.get(key) || [];
    list.push(o);
    byKey.set(key, list);
  }
  const ambiguous = new Set();
  const current = new Map(); // key -> { ok, outcome }
  for (const [key, list] of byKey) {
    if (new Set(list.map((o) => o.ok)).size > 1) { ambiguous.add(key); continue; }
    current.set(key, { ok: list[0].ok, outcome: list[0] });
  }

  const tag = commit || '';
  for (const [key, cur] of current) {
    const tracked = ledger.tests[key];
    if (!tracked && cur.ok) continue; // never failed: nothing to track (and nothing to store)
    const entry = tracked || { h: '', since: null };
    entry.h = [..._tokens(entry.h), `${cur.ok ? 'p' : 'f'}${tag}`].slice(-MAX_WINDOW).join(' ');
    entry.lastSeen = now;
    ledger.tests[key] = entry;
  }

  // Re-judge every tracked test: stamp / clear `since`, forget the ones that
  // are healthy again or gone from the suite.
  const verdicts = new Map();
  let flakyTests = 0;
  for (const key of Object.keys(ledger.tests)) {
    const entry = ledger.tests[key];
    const v = classify(entry, cfg, now);
    entry.since = v.flaky ? v.since : null;
    const healthy = !v.flaky && _tokens(entry.h).slice(-cfg.window).every((t) => _outcome(t) === 'p');
    const gone = now - (entry.lastSeen || now) > FORGET_AFTER_MS;
    if ((healthy && _tokens(entry.h).length >= cfg.window) || gone) { delete ledger.tests[key]; continue; }
    if (v.flaky) flakyTests++;
    const cur = current.get(key);
    if (cur && !cur.ok) verdicts.set(key, { ...v, outcome: cur.outcome });
  }
  // Bound the file: keep the most recently seen tracked tests.
  const keys = Object.keys(ledger.tests);
  if (keys.length > MAX_TRACKED) {
    keys.sort((a, b) => (ledger.tests[b].lastSeen || 0) - (ledger.tests[a].lastSeen || 0));
    for (const k of keys.slice(MAX_TRACKED)) delete ledger.tests[k];
  }

  const testsSeen = [...byKey.keys()].filter((k) => !ambiguous.has(k)).length;
  ledger.runs += 1;
  ledger.lastRun = { at: new Date(now).toISOString(), tests: testsSeen, commit: commit || null, flaky: flakyTests };
  data.flakyLedger = ledger;
  persistentMemory.save(projectRoot, data);

  return { verdicts, ambiguous, flake: flakeSummary(ledger, cfg, now) };
}

/**
 * The flake rate a badge or report can print: measured flaky tests over the
 * tests the last run saw. `measured: false` until a run was recorded — the
 * caller must say "not measured", never "0%".
 */
function flakeSummary(ledger, cfg, now) {
  if (!ledger || !ledger.lastRun || !(ledger.runs > 0)) {
    return { measured: false, rate: null, flakyTests: 0, quarantined: 0, expired: 0, tests: 0, runs: 0 };
  }
  let flaky = 0; let quarantined = 0; let expired = 0;
  for (const entry of Object.values(ledger.tests || {})) {
    const v = classify(entry, cfg, now);
    if (v.flaky) flaky++;
    if (v.quarantined) quarantined++;
    if (v.expired) expired++;
  }
  const tests = ledger.lastRun.tests || 0;
  const rate = tests > 0 ? Math.round((flaky / tests) * 1000) / 10 : null;
  return { measured: tests > 0, rate, flakyTests: flaky, quarantined, expired, tests, runs: ledger.runs };
}

/** Read-only view of the repo's ledger, for reports that run without a scan. */
function readFlakeSummary(projectRoot, cfg, now = Date.now()) {
  const data = persistentMemory.load(projectRoot);
  return flakeSummary(data.flakyLedger, cfg || resolveFlakyConfig(null), now);
}

module.exports = {
  DEFAULTS, MAX_WINDOW, LEDGER_VERSION,
  resolveFlakyConfig, ledgerGate, testKey, currentCommit,
  classify, recordRun, flakeSummary, readFlakeSummary,
};
