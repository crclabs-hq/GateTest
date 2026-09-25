// ============================================================================
// PULL-DEPLOY-STATUS TEST — website/app/lib/pull-deploy-status.js (issue #706)
// ============================================================================
// The box's deploy script (scripts/deploy/pull-deploy.sh) writes a one-line
// JSON status file after every tick; /api/platform-status reads it through
// this module. Covered:
//   - a "deployed" fixture maps before/after -> from/to
//   - a "failed" fixture carries the reason, plus consecutiveFailures /
//     firstFailedAt (#706 part 3)
//   - an older fixture without consecutiveFailures/firstFailedAt still reads
//     (those come back null, not a crash)
//   - the file absent -> { result: "unknown", reason: "status file not
//     readable" }, never a thrown error
//   - a corrupt (non-JSON) file -> the same honest "unknown"
//   - PULL_DEPLOY_STATUS_FILE env var overrides the default path
// ============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  DEFAULT_STATUS_FILE,
  statusFilePath,
  readLastPullDeploy,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'pull-deploy-status.js'));

/** In-memory fake fs — same shape used by tests/tallrig-push-route.test.js. */
function makeFakeFs(files = new Map()) {
  return {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
  };
}

describe('pull-deploy-status', () => {
  const ORIGINAL_ENV = process.env.PULL_DEPLOY_STATUS_FILE;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.PULL_DEPLOY_STATUS_FILE;
    else process.env.PULL_DEPLOY_STATUS_FILE = ORIGINAL_ENV;
  });

  it('statusFilePath() defaults to the box path, overridden by env', () => {
    delete process.env.PULL_DEPLOY_STATUS_FILE;
    assert.equal(statusFilePath(), DEFAULT_STATUS_FILE);
    process.env.PULL_DEPLOY_STATUS_FILE = '/tmp/custom-status.json';
    assert.equal(statusFilePath(), '/tmp/custom-status.json');
  });

  it('a "deployed" fixture maps before/after to from/to', () => {
    const file = '/var/lib/gatetest/pull-deploy-status.json';
    const fixture = JSON.stringify({
      at: '2026-09-23T02:13:00Z',
      before: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      after: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      result: 'deployed',
      reason: '',
    });
    const _fs = makeFakeFs(new Map([[file, fixture]]));
    const out = readLastPullDeploy({ _fs, filePath: file });
    assert.deepEqual(out, {
      at: '2026-09-23T02:13:00Z',
      result: 'deployed',
      reason: '',
      from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      to: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      consecutiveFailures: null,
      firstFailedAt: null,
    });
  });

  it('a "failed" fixture carries the reason, consecutiveFailures and firstFailedAt', () => {
    const file = '/var/lib/gatetest/pull-deploy-status.json';
    const fixture = JSON.stringify({
      at: '2026-09-23T02:28:00Z',
      before: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      after: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      result: 'failed',
      reason: 'git fetch failed: fatal: unable to access repo',
      consecutiveFailures: 3,
      firstFailedAt: '2026-09-23T02:13:00Z',
    });
    const _fs = makeFakeFs(new Map([[file, fixture]]));
    const out = readLastPullDeploy({ _fs, filePath: file });
    assert.equal(out.result, 'failed');
    assert.equal(out.reason, 'git fetch failed: fatal: unable to access repo');
    assert.equal(out.consecutiveFailures, 3);
    assert.equal(out.firstFailedAt, '2026-09-23T02:13:00Z');
  });

  it('an older fixture without consecutiveFailures/firstFailedAt reads with those fields null', () => {
    const file = '/var/lib/gatetest/pull-deploy-status.json';
    const fixture = JSON.stringify({
      at: '2026-08-01T00:00:00Z',
      before: 'a', after: 'a', result: 'up-to-date', reason: '',
    });
    const _fs = makeFakeFs(new Map([[file, fixture]]));
    const out = readLastPullDeploy({ _fs, filePath: file });
    assert.equal(out.result, 'up-to-date');
    assert.equal(out.consecutiveFailures, null);
    assert.equal(out.firstFailedAt, null);
  });

  it('an appended (multi-line) status file — as an OnFailure append leaves it — reads the LAST line only', () => {
    const file = '/var/lib/gatetest/pull-deploy-status.json';
    const oldLine = JSON.stringify({
      at: '2020-01-01T00:00:00Z', before: 'x', after: 'x', result: 'up-to-date', reason: '',
      consecutiveFailures: 0, firstFailedAt: '',
    });
    const appendedFailure = JSON.stringify({
      at: '2026-09-23T02:00:00Z', before: '', after: '', result: 'failed', reason: 'killed',
      consecutiveFailures: 2, firstFailedAt: '2026-09-23T02:00:00Z',
    });
    const _fs = makeFakeFs(new Map([[file, `${oldLine}\n${appendedFailure}\n`]]));
    const out = readLastPullDeploy({ _fs, filePath: file });
    // Must reflect the LAST line's state (the appended failure), not the
    // FIRST line's "up-to-date" that parsing the whole file or a `head -n1`
    // read would have produced.
    assert.equal(out.result, 'failed');
    assert.equal(out.reason, 'killed');
    assert.equal(out.consecutiveFailures, 2);
    assert.equal(out.firstFailedAt, '2026-09-23T02:00:00Z');
  });

  it('file absent -> honest "unknown", never throws', () => {
    const _fs = makeFakeFs(new Map());
    const out = readLastPullDeploy({ _fs, filePath: '/var/lib/gatetest/pull-deploy-status.json' });
    assert.deepEqual(out, { result: 'unknown', reason: 'status file not readable' });
  });

  it('corrupt (non-JSON) file -> the same honest "unknown"', () => {
    const file = '/var/lib/gatetest/pull-deploy-status.json';
    const _fs = makeFakeFs(new Map([[file, '{not json']]));
    const out = readLastPullDeploy({ _fs, filePath: file });
    assert.deepEqual(out, { result: 'unknown', reason: 'status file not readable' });
  });
});
