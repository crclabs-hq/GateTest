/**
 * pull-deploy-status — reads the one-line JSON status file
 * `scripts/deploy/pull-deploy.sh` writes on the production box after every
 * tick (issue #706).
 *
 * Why this exists: the box already writes the failure reason to
 * `PULL_DEPLOY_STATUS_FILE` (default `/var/lib/gatetest/pull-deploy-status.json`)
 * on every tick — deployed, up-to-date, or failed with a reason — but nothing
 * read it. Production sat on one commit for 16 hours while the poll job in
 * `.github/workflows/deploy-box.yml` failed nine times unseen, because the
 * one artifact that actually knew why (the box's own status file) was never
 * surfaced anywhere a human or a workflow could see it.
 *
 * Same DI shape as tallrig-push-event-store.js: an injectable `_fs` so tests
 * run against an in-memory fake instead of touching disk. Reading is
 * best-effort — a missing or corrupt file is reported as `unknown`, never
 * thrown, so a platform-status responder that imports this can never turn a
 * healthy response into a 500 over a file it doesn't own.
 */

'use strict';

const fs = require('fs');

const DEFAULT_STATUS_FILE = '/var/lib/gatetest/pull-deploy-status.json';

/** One definition of the status file path — env wins, else the box default. */
function statusFilePath() {
  return process.env.PULL_DEPLOY_STATUS_FILE || DEFAULT_STATUS_FILE;
}

/**
 * Read and shape the last pull-deploy attempt for `/api/platform-status`.
 *
 * The file on disk is `{"at","before","after","result","reason"}` (plus,
 * since #706 part 3, `consecutiveFailures` / `firstFailedAt`). This maps it
 * to the API shape (`from`/`to` instead of `before`/`after`) and returns
 * `{ result: "unknown", reason: "status file not readable" }` — never a
 * thrown error — when the file is missing, unreadable, or not valid JSON.
 *
 * @param {object} [opts]
 * @param {object} [opts._fs] injectable fs for tests
 * @param {string} [opts.filePath] override for tests
 */
function readLastPullDeploy(opts = {}) {
  const { _fs = fs, filePath } = opts;
  const file = filePath || statusFilePath();

  let raw;
  try {
    raw = _fs.readFileSync(file, 'utf8');
  } catch {
    return { result: 'unknown', reason: 'status file not readable' };
  }

  // The file is written as one JSON object per line (a fresh write each
  // tick, never appended) — but read the last non-empty line defensively in
  // case something ever appends instead of replacing.
  const lastLine = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();

  let data;
  try {
    data = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    return { result: 'unknown', reason: 'status file not readable' };
  }
  if (!data || typeof data !== 'object') {
    return { result: 'unknown', reason: 'status file not readable' };
  }

  return {
    at: typeof data.at === 'string' ? data.at : null,
    result: typeof data.result === 'string' && data.result ? data.result : 'unknown',
    reason: typeof data.reason === 'string' ? data.reason : '',
    from: typeof data.before === 'string' ? data.before : null,
    to: typeof data.after === 'string' ? data.after : null,
    // #706 part 3 — absent on a status file written before that change;
    // null (not 0/'') distinguishes "not recorded" from "zero failures".
    consecutiveFailures: Number.isInteger(data.consecutiveFailures) ? data.consecutiveFailures : null,
    firstFailedAt: typeof data.firstFailedAt === 'string' && data.firstFailedAt ? data.firstFailedAt : null,
  };
}

module.exports = {
  DEFAULT_STATUS_FILE,
  statusFilePath,
  readLastPullDeploy,
};
