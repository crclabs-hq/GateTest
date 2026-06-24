/**
 * Session telemetry — capture every dev/Claude-Code bug-fix into the corpus.
 *
 * fix-telemetry.js records what the PRODUCT flywheel does (scan/fix route,
 * AI CI fixer). That misses ~80% of the real engineering work, which lands
 * via Claude Code sessions, ad-hoc commits, and hand-pushed fixes. This
 * module closes that gap so the marketing claim "gets sharper with every
 * scan" becomes "gets sharper with every fix, full stop."
 *
 * Two entry points:
 *
 *   recordSessionFix({...})
 *     Explicit call from inside a session or hook. Appends a structured
 *     record to ~/.gatetest/session-fixes.jsonl.
 *
 *   ingestGitHistory({ since, repoRoot })
 *     Walks `git log` for commits matching the structured fix vocabulary
 *     (fix(<module>):, feat+fix:, etc.), extracts which files/modules were
 *     touched and how many tests changed, and writes one record per commit.
 *     Idempotent — skips commits already in the JSONL by SHA.
 *
 * RESILIENCE CONTRACT (Bible Forbidden #15):
 *   This module MUST NEVER throw. File writes / git failures / parse
 *   errors all degrade silently to a single warnOnce + return.
 *
 * PRIVACY CONTRACT (Bible Forbidden #6 / #14):
 *   We record commit SHA, commit subject, files-changed list (paths only,
 *   no contents), modules detected, tests-added count. No diffs, no
 *   identifying user data, no email addresses. The JSONL is a flywheel
 *   corpus, not a forensic log.
 *
 * Storage: ~/.gatetest/session-fixes.jsonl (one line per fix)
 * Override via opts.path for tests.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SUBJECT_LEN = 200;
const MAX_MODULE_LEN = 100;
const MAX_BUG_PATTERN_LEN = 300;
const MAX_FILE_PATH_LEN = 300;
const MAX_FILES_PER_COMMIT = 50;
const MAX_GIT_SUBJECTS_SCANNED = 500;

// Commit subjects that count as bug-fixes worth recording.
// Conventional commits + a couple of GateTest-internal styles.
const FIX_COMMIT_RE = /^(?:fix|feat\+fix|hotfix|patch|chore\(fix\)|refactor\(fix\))(?:\([^)]+\))?:/i;

// Extract module name from "fix(<module>): ..." subject.
const SUBJECT_MODULE_RE = /^(?:fix|feat\+fix|hotfix|patch|chore\(fix\)|refactor\(fix\))\(([^)]+)\):/i;

// Test file shapes used to count tests added/changed per commit.
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|\.(?:test|spec)\.[a-z0-9]+$/i;

// Source module shapes — used to attribute a commit to a module.
const MODULE_PATH_RE = /^(?:src\/modules|website\/app\/lib)\/([a-z0-9_.-]+)\.[a-z]+$/i;

let _warnedOnce = false;
function warnOnce(msg) {
  if (_warnedOnce) return;
  _warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[session-telemetry] ${msg}`);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function defaultSessionFixPath() {
  return path.join(os.homedir(), '.gatetest', 'session-fixes.jsonl');
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// ---------------------------------------------------------------------------
// Sanitisation — guarantee no secrets / no PII reach the JSONL
// ---------------------------------------------------------------------------

function clampStr(s, max) {
  if (typeof s !== 'string') return null;
  return s.length > max ? s.slice(0, max) : s;
}

function clampStrArray(arr, max, perItemMax) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max).map((s) => clampStr(s, perItemMax)).filter(Boolean);
}

function sanitiseRecord(entry) {
  return {
    ts: new Date().toISOString(),
    commitSha: clampStr(entry.commitSha, 40),
    subject: clampStr(entry.subject, MAX_SUBJECT_LEN),
    module: clampStr(entry.module, MAX_MODULE_LEN),
    bugPattern: clampStr(entry.bugPattern, MAX_BUG_PATTERN_LEN),
    filesChanged: clampStrArray(entry.filesChanged, MAX_FILES_PER_COMMIT, MAX_FILE_PATH_LEN),
    testsAdded: Number.isFinite(entry.testsAdded) ? Math.max(0, Math.round(entry.testsAdded)) : 0,
    sourceFilesChanged: Number.isFinite(entry.sourceFilesChanged) ? Math.max(0, Math.round(entry.sourceFilesChanged)) : 0,
    author: clampStr(entry.author, 50), // 'session' | 'production-fixer' | 'human'
  };
}

// ---------------------------------------------------------------------------
// recordSessionFix — explicit append
// ---------------------------------------------------------------------------

function recordSessionFix(entry, opts = {}) {
  try {
    const filePath = opts.path || defaultSessionFixPath();
    const record = sanitiseRecord(entry || {});
    const line = JSON.stringify(record) + '\n';
    try {
      ensureDir(filePath);
    } catch (err) {
      warnOnce(`could not create session-fix dir: ${err.message}`);
      return;
    }
    try {
      fs.appendFileSync(filePath, line, { encoding: 'utf8' });
    } catch (err) {
      warnOnce(`could not append session-fix: ${err.message}`);
    }
  } catch (err) {
    warnOnce(`unexpected error: ${err && err.message ? err.message : 'unknown'}`);
  }
}

// ---------------------------------------------------------------------------
// Git ingestion — auto-capture fix commits the session may have forgotten
// to record explicitly.
// ---------------------------------------------------------------------------

function gitLogSubjects(repoRoot, sinceArg, maxCount) {
  try {
    const args = ['-C', repoRoot, 'log', `--max-count=${maxCount}`, '--no-merges', '--format=%H%x09%an%x09%s'];
    if (sinceArg) args.push(`--since=${sinceArg}`);
    const out = execFileSync('git', args, { encoding: 'utf8', timeout: 10_000 });
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, author, ...subjParts] = line.split('\t');
      return { sha, author, subject: subjParts.join('\t') };
    });
  } catch (err) {
    warnOnce(`git log failed: ${err.message}`);
    return [];
  }
}

function gitFilesChanged(repoRoot, sha) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'show', '--name-only', '--format=', sha], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out.split('\n').filter(Boolean).slice(0, MAX_FILES_PER_COMMIT);
  } catch {
    return [];
  }
}

function gitTestsAdded(repoRoot, sha) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'show', '--numstat', '--format=', sha], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    let testsAdded = 0;
    for (const line of out.split('\n')) {
      const parts = line.split('\t');
      if (parts.length !== 3) continue;
      const added = parseInt(parts[0], 10);
      const filePath = parts[2];
      if (!Number.isFinite(added) || !filePath) continue;
      if (TEST_PATH_RE.test(filePath)) testsAdded += added;
    }
    return testsAdded;
  } catch {
    return 0;
  }
}

function attributeModule(subject, filesChanged) {
  // Prefer the explicit "fix(<module>):" form.
  const m = SUBJECT_MODULE_RE.exec(subject);
  if (m) return m[1];
  // Fall back: first file under src/modules/ or website/app/lib/
  for (const f of filesChanged) {
    const mm = MODULE_PATH_RE.exec(f);
    if (mm) return mm[1];
  }
  return null;
}

function loadSeenShas(filePath) {
  const seen = new Set();
  let exists = false;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    exists = true;
  } catch { /* fall through */ }
  if (!exists) return seen;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.commitSha === 'string') seen.add(rec.commitSha);
      } catch { /* skip malformed line */ }
    }
  } catch (err) {
    warnOnce(`could not read existing session-fix log: ${err.message}`);
  }
  return seen;
}

/**
 * Walk git history for fix-shaped commits and append one record per commit
 * to the session-fix JSONL. Idempotent — already-recorded SHAs are skipped.
 *
 * @param {object} opts
 * @param {string} [opts.since='30 days ago']  any string git --since accepts
 * @param {string} [opts.repoRoot=process.cwd()]
 * @param {string} [opts.path]                  override JSONL path (for tests)
 * @param {number} [opts.maxCount=500]          cap commits scanned
 * @returns {{scanned:number,recorded:number,skipped:number}}
 */
function ingestGitHistory(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const since = opts.since || '30 days ago';
  const filePath = opts.path || defaultSessionFixPath();
  const maxCount = Number.isFinite(opts.maxCount) ? opts.maxCount : MAX_GIT_SUBJECTS_SCANNED;

  const stats = { scanned: 0, recorded: 0, skipped: 0 };
  const commits = gitLogSubjects(repoRoot, since, maxCount);
  if (commits.length === 0) return stats;

  let seen;
  try {
    seen = loadSeenShas(filePath);
  } catch {
    seen = new Set();
  }

  for (const c of commits) {
    if (!c.sha || !c.subject) continue;
    stats.scanned += 1;
    if (!FIX_COMMIT_RE.test(c.subject)) continue;
    if (seen.has(c.sha)) {
      stats.skipped += 1;
      continue;
    }

    const filesChanged = gitFilesChanged(repoRoot, c.sha);
    const testsAdded = gitTestsAdded(repoRoot, c.sha);
    const moduleName = attributeModule(c.subject, filesChanged);
    const sourceFilesChanged = filesChanged.filter((f) => MODULE_PATH_RE.test(f)).length;

    recordSessionFix({
      commitSha: c.sha,
      subject: c.subject,
      module: moduleName,
      bugPattern: null, // explicit-call API can fill this in; ingestion can't infer it
      filesChanged,
      testsAdded,
      sourceFilesChanged,
      author: 'session', // commits surfaced by ingestion are all session-authored
    }, { path: filePath });

    stats.recorded += 1;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Summary — for /admin dashboard
// ---------------------------------------------------------------------------

/**
 * Read the JSONL and return aggregated stats: total fixes, fixes per module,
 * tests added, average tests-per-fix, time range. Malformed lines skipped.
 *
 * @param {object} [opts]
 * @param {Date} [opts.since]
 * @param {Date} [opts.until]
 * @param {string} [opts.path]
 * @returns {Promise<object>}
 */
async function summariseSessionFixes(opts = {}) {
  const filePath = opts.path || defaultSessionFixPath();
  const sinceMs = opts.since instanceof Date ? opts.since.getTime() : -Infinity;
  const untilMs = opts.until instanceof Date ? opts.until.getTime() : Infinity;

  const stats = {
    totalFixes: 0,
    totalTestsAdded: 0,
    fixesByModule: {},
    earliestTs: null,
    latestTs: null,
  };

  let exists = false;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    exists = true;
  } catch { /* file missing → empty stats */ }
  if (!exists) return stats;

  return await new Promise((resolve) => {
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    } catch (err) {
      warnOnce(`could not read session-fix log: ${err.message}`);
      resolve(stats);
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line || !line.trim()) return;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      if (!rec || typeof rec !== 'object') return;
      const t = Date.parse(rec.ts);
      if (Number.isFinite(t)) {
        if (t < sinceMs || t > untilMs) return;
        if (stats.earliestTs === null || t < stats.earliestTs) stats.earliestTs = t;
        if (stats.latestTs === null || t > stats.latestTs) stats.latestTs = t;
      }
      stats.totalFixes += 1;
      if (Number.isFinite(rec.testsAdded)) stats.totalTestsAdded += rec.testsAdded;
      const mod = rec.module || '(unattributed)';
      stats.fixesByModule[mod] = (stats.fixesByModule[mod] || 0) + 1;
    });

    rl.on('error', (err) => {
      warnOnce(`session-fix read error: ${err.message}`);
      resolve(stats);
    });
    rl.on('close', () => resolve(stats));
  });
}

// ---------------------------------------------------------------------------

module.exports = {
  recordSessionFix,
  ingestGitHistory,
  summariseSessionFixes,
  defaultSessionFixPath,
  // exposed for tests
  _sanitiseRecord: sanitiseRecord,
  _attributeModule: attributeModule,
  _FIX_COMMIT_RE: FIX_COMMIT_RE,
};
