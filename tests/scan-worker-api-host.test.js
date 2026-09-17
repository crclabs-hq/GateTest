// ============================================================================
// scan-worker.js — isGitRepoUrl (KI #113 Phase 2)
// ============================================================================
// Pure-function coverage for the one decision runApiHostJob makes about an
// `api`-host row's metadata.url: is this a git URL (execute via the SAME
// path as a repo-host job) or a bare website URL (check the browser-runtime
// gate)? Full end-to-end behaviour for both shapes is covered by
// tests/scan-worker-tick.test.js; this file is the control pair for the
// classifier itself so a future edit to the regex can't silently widen or
// narrow what counts as "a repository" without a test noticing.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { isGitRepoUrl } = require(path.resolve(
  __dirname,
  '..',
  'website',
  'app',
  'lib',
  'scan-worker.js'
));

describe('isGitRepoUrl', () => {
  it('recognises github.com and gitlab.com repo URLs (the positive control)', () => {
    assert.strictEqual(isGitRepoUrl('https://github.com/alice/webapp'), true);
    assert.strictEqual(isGitRepoUrl('http://github.com/alice/webapp'), true);
    assert.strictEqual(isGitRepoUrl('https://www.github.com/alice/webapp'), true);
    assert.strictEqual(isGitRepoUrl('https://gitlab.com/bob/service'), true);
    assert.strictEqual(isGitRepoUrl('https://GITHUB.COM/alice/webapp'), true, 'host match is case-insensitive');
  });

  it('does not treat a bare website URL as a repository (the negative control)', () => {
    assert.strictEqual(isGitRepoUrl('https://example.com'), false);
    assert.strictEqual(isGitRepoUrl('https://example.com/github.com/alice/webapp'), false, 'segment, not substring — a path is not a host');
    assert.strictEqual(isGitRepoUrl('https://not-github.com/alice/webapp'), false, 'must be the real host, not a suffix match');
    assert.strictEqual(isGitRepoUrl('https://github.com.evil.example/alice/webapp'), false, 'lookalike domain must not pass');
  });

  it('does not treat a gluecron.com URL as a git URL — that host already has its own repo-host path', () => {
    assert.strictEqual(isGitRepoUrl('https://gluecron.com/alice/webapp'), false);
  });

  it('rejects non-string / malformed input without throwing', () => {
    assert.strictEqual(isGitRepoUrl(undefined), false);
    assert.strictEqual(isGitRepoUrl(null), false);
    assert.strictEqual(isGitRepoUrl(''), false);
    assert.strictEqual(isGitRepoUrl(42), false);
    assert.strictEqual(isGitRepoUrl('not a url at all'), false);
  });
});
