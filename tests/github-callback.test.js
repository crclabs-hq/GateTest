// =============================================================================
// GITHUB-CALLBACK TEST — website/app/lib/github-callback.js
// =============================================================================
// Covers: token resolution, commit-state mapping, description building,
// markdown formatting, postCommitStatus/postPrComment HTTP calls, and the
// full sendGithubCallback orchestration — all without real HTTP calls.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  resolveGitHubToken,
  toCommitState,
  buildDescription,
  buildMarkdownComment,
  linkifyFinding,
  fetchRepoMode,
  sendGithubCallback,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'github-callback.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScanResult(overrides = {}) {
  return {
    status: 'complete',
    totalIssues: 0,
    duration: 3200,
    modules: [
      { name: 'lint', status: 'passed', issues: 0, checks: [{ severity: 'info' }], details: [] },
      { name: 'secrets', status: 'passed', issues: 0, checks: [], details: [] },
    ],
    ...overrides,
  };
}

function makeFetch(statusCode = 201, body = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { status: statusCode, ok: statusCode >= 200 && statusCode < 300, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

// Returns the parsed JSON body of the commit-status POST call, skipping
// the contents/.gatetest.json mode-fetch that fires first.
function statusBody(doFetch) {
  const statusCall = doFetch.calls.find((c) => c.url.includes('/statuses/'));
  if (!statusCall) throw new Error('no /statuses/ call found in fetch log');
  return JSON.parse(statusCall.init.body);
}

// ---------------------------------------------------------------------------
// resolveGitHubToken
// ---------------------------------------------------------------------------

describe('resolveGitHubToken', () => {
  it('prefers GATETEST_GITHUB_TOKEN over GITHUB_TOKEN', () => {
    const token = resolveGitHubToken({
      GATETEST_GITHUB_TOKEN: 'gat_primary',
      GITHUB_TOKEN: 'gh_fallback',
    });
    assert.strictEqual(token, 'gat_primary');
  });

  it('falls back to GITHUB_TOKEN when primary absent', () => {
    const token = resolveGitHubToken({ GITHUB_TOKEN: 'gh_fallback' });
    assert.strictEqual(token, 'gh_fallback');
  });

  it('returns null when neither token is set', () => {
    assert.strictEqual(resolveGitHubToken({}), null);
  });
});

// ---------------------------------------------------------------------------
// toCommitState
// ---------------------------------------------------------------------------

describe('toCommitState', () => {
  it('returns success for a clean scan in default (advisory) mode', () => {
    assert.strictEqual(toCommitState(makeScanResult()), 'success');
  });

  it('returns success in advisory mode even when errors are present', () => {
    // Advisory mode never blocks the PR — the soft-landing default
    // for fresh installs. Findings still surface in the comment body.
    const result = makeScanResult({
      totalIssues: 2,
      modules: [
        { name: 'lint', status: 'failed', issues: 2, checks: [{ severity: 'error' }], details: [] },
      ],
    });
    assert.strictEqual(toCommitState(result), 'success');
    assert.strictEqual(toCommitState(result, 'advisory'), 'success');
  });

  it('returns failure in STRICT mode when a module has error-severity checks', () => {
    const result = makeScanResult({
      totalIssues: 2,
      modules: [
        { name: 'lint', status: 'failed', issues: 2, checks: [{ severity: 'error' }], details: [] },
      ],
    });
    assert.strictEqual(toCommitState(result, 'strict'), 'failure');
  });

  it('returns success in strict mode when issues are warnings only', () => {
    const result = makeScanResult({
      totalIssues: 1,
      modules: [
        { name: 'lint', status: 'passed', issues: 1, checks: [{ severity: 'warning' }], details: [] },
      ],
    });
    assert.strictEqual(toCommitState(result, 'strict'), 'success');
  });

  it('returns error for a crashed scan regardless of mode', () => {
    assert.strictEqual(toCommitState({ status: 'failed', error: 'timeout' }), 'error');
    assert.strictEqual(toCommitState({ status: 'failed', error: 'timeout' }, 'strict'), 'error');
    assert.strictEqual(toCommitState({ status: 'failed', error: 'timeout' }, 'advisory'), 'error');
  });

  it('returns error for null', () => {
    assert.strictEqual(toCommitState(null), 'error');
  });
});

// ---------------------------------------------------------------------------
// buildDescription
// ---------------------------------------------------------------------------

describe('buildDescription', () => {
  it('produces a passing description for zero issues', () => {
    const desc = buildDescription(makeScanResult());
    assert.ok(desc.includes('passed'), `expected "passed" in: ${desc}`);
    assert.ok(desc.includes('0 issues'), `expected "0 issues" in: ${desc}`);
  });

  it('produces an issue-count description for failing scans', () => {
    const desc = buildDescription(makeScanResult({ totalIssues: 5, modules: Array(3).fill({ name: 'x', issues: 1, checks: [], details: [], status: 'failed' }) }));
    assert.ok(desc.includes('5 issues'), `expected "5 issues" in: ${desc}`);
    assert.ok(desc.includes('3 modules'), `expected "3 modules" in: ${desc}`);
  });

  it('appends "advisory mode" suffix in default mode', () => {
    const desc = buildDescription(makeScanResult({ totalIssues: 5, modules: [{ name: 'x', issues: 5, checks: [], details: [], status: 'failed' }] }));
    assert.ok(desc.includes('advisory'), `expected "advisory" in: ${desc}`);
  });

  it('does NOT append advisory suffix in strict mode', () => {
    const desc = buildDescription(makeScanResult({ totalIssues: 5, modules: [{ name: 'x', issues: 5, checks: [], details: [], status: 'failed' }] }), 'strict');
    assert.ok(!desc.includes('advisory'), `did not expect "advisory" in: ${desc}`);
  });

  it('never exceeds 140 chars', () => {
    const longError = 'E'.repeat(500);
    const desc = buildDescription({ status: 'failed', error: longError });
    assert.ok(desc.length <= 140, `description too long: ${desc.length}`);
  });
});

// ---------------------------------------------------------------------------
// buildMarkdownComment
// ---------------------------------------------------------------------------

describe('buildMarkdownComment', () => {
  it('contains the short SHA and repo', () => {
    const md = buildMarkdownComment('owner/repo', 'abc1234def56789', makeScanResult(), null);
    assert.ok(md.includes('abc1234'), `expected short SHA in: ${md.slice(0, 200)}`);
    assert.ok(md.includes('owner/repo'), `expected repo in: ${md.slice(0, 200)}`);
  });

  it('shows passed modules in a collapsible section', () => {
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), makeScanResult(), null);
    assert.ok(md.includes('<details>'), `expected details tag in markdown`);
    assert.ok(md.includes('passed'), `expected "passed" in markdown`);
  });

  it('shows failing module details', () => {
    const result = makeScanResult({
      totalIssues: 1,
      modules: [{
        name: 'secrets',
        status: 'failed',
        issues: 1,
        checks: [{ severity: 'error' }],
        details: ['Found hardcoded API key at line 42'],
      }],
    });
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), result, null);
    assert.ok(md.includes('secrets'), `expected module name`);
    assert.ok(md.includes('line 42'), `expected detail text`);
  });

  it('includes a full-report link when targetUrl is provided', () => {
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), makeScanResult(), 'https://gatetest.ai/scan/status');
    assert.ok(md.includes('https://gatetest.ai/scan/status'), `expected targetUrl`);
  });

  it('shows error message for crashed scan', () => {
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), { status: 'failed', error: 'scan timeout' }, null);
    assert.ok(md.includes('scan timeout'), `expected error message`);
  });

  it('shows auto-fix CTA on gate failure in STRICT mode', () => {
    const result = makeScanResult({
      totalIssues: 1,
      modules: [{
        name: 'security',
        status: 'failed',
        issues: 1,
        checks: [{ severity: 'error' }],
        details: ['issue'],
      }],
    });
    // CTA appears only when toCommitState === 'failure'; in advisory the
    // state stays 'success' so we ask explicitly for strict mode here.
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), result, null, 'strict');
    assert.ok(md.includes('Want these fixed automatically?'), 'CTA appears on failure');
    assert.ok(md.includes('ANTHROPIC_API_KEY'), 'CTA names the secret');
    assert.ok(md.includes('console.anthropic.com'), 'CTA links to Anthropic');
  });

  it('omits auto-fix CTA when scan passed', () => {
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), makeScanResult(), null);
    assert.ok(!md.includes('Want these fixed automatically?'), 'no CTA on pass');
  });

  it('shows auto-fix PR link when scanResult.autoFixPrUrl present (and skips CTA)', () => {
    const result = makeScanResult({
      totalIssues: 1,
      autoFixPrUrl: 'https://github.com/o/r/pull/123',
      modules: [{
        name: 'security',
        status: 'failed',
        issues: 1,
        checks: [{ severity: 'error' }],
        details: ['issue'],
      }],
    });
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), result, null);
    assert.ok(md.includes('https://github.com/o/r/pull/123'), 'links to fix PR');
    assert.ok(md.includes('Auto-fix PR opened'), 'labels the link');
    assert.ok(!md.includes('Want these fixed automatically?'), 'no CTA when PR already opened');
  });

  it('linkifies file:line in failing-module details to the GitHub blob URL', () => {
    const result = makeScanResult({
      totalIssues: 1,
      modules: [{
        name: 'security',
        status: 'failed',
        issues: 1,
        checks: [{ severity: 'error' }],
        details: ['src/foo.js:42 hardcoded AWS key'],
      }],
    });
    const sha = 'abc1234def56789';
    const md = buildMarkdownComment('owner/repo', sha, result, null);
    // The detail string should become a markdown link to the file at the right line.
    const expectedUrl = `https://github.com/owner/repo/blob/${sha}/src/foo.js#L42`;
    assert.ok(md.includes(expectedUrl), `expected blob URL in markdown, got:\n${md}`);
    assert.ok(md.includes('[`src/foo.js:42`]'), `expected markdown link label`);
  });
});

// ---------------------------------------------------------------------------
// buildMarkdownComment — advisory-mode signals
// ---------------------------------------------------------------------------

describe('buildMarkdownComment — advisory mode', () => {
  function makeResultWithIssues() {
    return {
      status: 'complete',
      totalIssues: 3,
      duration: 1200,
      modules: [
        { name: 'lint', status: 'failed', issues: 3, checks: [{ severity: 'error' }], details: ['oops'] },
      ],
    };
  }

  it('uses neutral 🟡 icon and advisory headline when findings exist in advisory mode', () => {
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), makeResultWithIssues(), null, 'advisory');
    assert.ok(md.includes('🟡'), `expected 🟡 icon in advisory-with-findings`);
    assert.ok(md.includes('advisory'), `expected "advisory" in headline`);
  });

  it('renders an upgrade-to-strict note in advisory mode with findings', () => {
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), makeResultWithIssues(), null, 'advisory');
    assert.ok(md.includes('.gatetest.json'), `expected pointer to .gatetest.json`);
    assert.ok(md.includes('"mode": "strict"'), `expected strict-mode upgrade snippet`);
  });

  it('uses ❌ icon and "Issues found" headline in STRICT mode with errors', () => {
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), makeResultWithIssues(), null, 'strict');
    assert.ok(md.includes('❌'), `expected ❌ icon in strict-with-errors`);
    assert.ok(md.includes('Issues found'), `expected "Issues found" headline`);
  });

  it('does NOT render the advisory note in strict mode', () => {
    const md = buildMarkdownComment('o/r', 'a'.repeat(40), makeResultWithIssues(), null, 'strict');
    assert.ok(!md.includes('Why is this not red?'), `did not expect advisory upgrade note in strict mode`);
  });
});

// ---------------------------------------------------------------------------
// fetchRepoMode — .gatetest.json reader (fail-open to advisory)
// ---------------------------------------------------------------------------

describe('fetchRepoMode', () => {
  function makeContentsResponse(json) {
    const content = Buffer.from(JSON.stringify(json), 'utf-8').toString('base64');
    return {
      ok: true,
      async json() {
        return { content, encoding: 'base64' };
      },
    };
  }

  it('returns "strict" when .gatetest.json declares strict', async () => {
    const fake = async () => makeContentsResponse({ mode: 'strict' });
    const mode = await fetchRepoMode('o', 'r', 't', fake);
    assert.strictEqual(mode, 'strict');
  });

  it('returns "advisory" when .gatetest.json declares advisory', async () => {
    const fake = async () => makeContentsResponse({ mode: 'advisory' });
    const mode = await fetchRepoMode('o', 'r', 't', fake);
    assert.strictEqual(mode, 'advisory');
  });

  it('returns "advisory" when .gatetest.json omits mode (default)', async () => {
    const fake = async () => makeContentsResponse({ protected: true });
    const mode = await fetchRepoMode('o', 'r', 't', fake);
    assert.strictEqual(mode, 'advisory');
  });

  it('returns "advisory" when .gatetest.json is absent (404)', async () => {
    const fake = async () => ({ ok: false, status: 404 });
    const mode = await fetchRepoMode('o', 'r', 't', fake);
    assert.strictEqual(mode, 'advisory');
  });

  it('returns "advisory" when fetch throws', async () => {
    const fake = async () => { throw new Error('network fail'); };
    const mode = await fetchRepoMode('o', 'r', 't', fake);
    assert.strictEqual(mode, 'advisory');
  });

  it('returns "advisory" when content is malformed JSON', async () => {
    const fake = async () => ({
      ok: true,
      async json() {
        return { content: Buffer.from('{not json', 'utf-8').toString('base64'), encoding: 'base64' };
      },
    });
    const mode = await fetchRepoMode('o', 'r', 't', fake);
    assert.strictEqual(mode, 'advisory');
  });
});

// ---------------------------------------------------------------------------
// linkifyFinding
// ---------------------------------------------------------------------------

describe('linkifyFinding', () => {
  it('turns "path:line" into a markdown link to the blob URL', () => {
    const out = linkifyFinding(
      'src/foo.js:42 - hardcoded secret',
      'owner', 'repo', 'abc123',
    );
    assert.strictEqual(
      out,
      '[`src/foo.js:42`](https://github.com/owner/repo/blob/abc123/src/foo.js#L42) - hardcoded secret',
    );
  });

  it('handles "path:line:col" by stripping the column', () => {
    const out = linkifyFinding(
      'src/bar.ts:10:5 - missing return',
      'o', 'r', 'sha',
    );
    assert.ok(out.includes('src/bar.ts#L10'));
    assert.ok(out.includes('`src/bar.ts:10`'));
  });

  it('preserves leading whitespace / paren before the path', () => {
    const out = linkifyFinding(
      '  (src/baz.js:1) issue',
      'o', 'r', 'sha',
    );
    assert.ok(out.startsWith('  ('));
    assert.ok(out.includes('[`src/baz.js:1`]'));
  });

  it('returns input unchanged when no path:line found', () => {
    const out = linkifyFinding('a generic finding with no path', 'o', 'r', 'sha');
    assert.strictEqual(out, 'a generic finding with no path');
  });

  it('returns input unchanged when owner/repo/sha missing', () => {
    const out = linkifyFinding('src/foo.js:1 issue', '', '', '');
    assert.strictEqual(out, 'src/foo.js:1 issue');
  });

  it('does not mangle text in the middle that looks like a path', () => {
    // Only linkifies the FIRST match — extra path-shaped tokens later
    // in the string are left as plain text to keep formatting predictable.
    const out = linkifyFinding(
      'src/a.js:1 see also src/b.js:2',
      'o', 'r', 'sha',
    );
    assert.ok(out.includes('[`src/a.js:1`]'));
    assert.ok(out.includes('see also src/b.js:2'));
    assert.ok(!out.includes('[`src/b.js:2`]'), 'second match left unlinkified');
  });
});

// ---------------------------------------------------------------------------
// sendGithubCallback
// ---------------------------------------------------------------------------

describe('sendGithubCallback — no token', () => {
  it('returns no-token reason when env has no GitHub token', async () => {
    const result = await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'a'.repeat(40),
      scanResult: makeScanResult(),
      env: {},
    });
    assert.strictEqual(result.statusSent, false);
    assert.strictEqual(result.reason, 'no-token');
  });
});

describe('sendGithubCallback — happy path (no PR)', () => {
  it('posts commit status and skips PR comment when no pullRequestNumber', async () => {
    const doFetch = makeFetch(201);
    const result = await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'a'.repeat(40),
      pullRequestNumber: null,
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    assert.strictEqual(result.statusSent, true);
    assert.strictEqual(result.commentSent, false);
    // Two calls: fetchRepoMode (.gatetest.json) + postCommitStatus.
    assert.strictEqual(doFetch.calls.length, 2, 'expected two fetch calls (mode-fetch + status)');
    assert.ok(doFetch.calls.some((c) => c.url.includes('/contents/.gatetest.json')), 'expected mode-fetch call');
    assert.ok(doFetch.calls.some((c) => c.url.includes('/statuses/')), 'expected status call');
  });
});

describe('sendGithubCallback — happy path with PR', () => {
  it('posts commit status AND PR comment when pullRequestNumber is set', async () => {
    const doFetch = makeFetch(201);
    const result = await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'b'.repeat(40),
      pullRequestNumber: 42,
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    assert.strictEqual(result.statusSent, true);
    assert.strictEqual(result.commentSent, true);
    // Four fetch calls now: mode-fetch (.gatetest.json) + status + idempotency-lookup
    // (GET on existing PR comments) + comment POST. The mode-fetch was added by the
    // advisory-mode change (Craig 2026-05-27 Option A) so the App reads .gatetest.json
    // before deciding whether the check should hard-fail on errors. The lookup-GET
    // was added in the Manifest #20 hardening — the route finds and PATCHes an
    // existing bot comment instead of stacking duplicates on every push.
    assert.strictEqual(doFetch.calls.length, 4, 'expected four fetch calls (mode-fetch + status + comment-lookup GET + comment POST)');
    assert.ok(doFetch.calls.some((c) => c.url.includes('/contents/.gatetest.json')), 'expected mode-fetch call');
    assert.ok(doFetch.calls.some((c) => c.url.includes('/statuses/')), 'expected status call');
    assert.ok(doFetch.calls.some((c) => c.url.includes('/issues/42/comments') && c.init && c.init.method === 'GET'), 'expected idempotency GET');
    assert.ok(doFetch.calls.some((c) => c.url.includes('/issues/42/comments') && c.init && c.init.method === 'POST'), 'expected comment POST');
  });

  it('uses Authorization Bearer header with the resolved token', async () => {
    const doFetch = makeFetch(201);
    await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'c'.repeat(40),
      pullRequestNumber: 7,
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_mytoken' },
      fetchImpl: doFetch,
    });
    for (const call of doFetch.calls) {
      const auth = call.init && call.init.headers && call.init.headers['Authorization'];
      assert.strictEqual(auth, 'Bearer ghp_mytoken', `expected Bearer token in ${call.url}`);
    }
  });
});

describe('sendGithubCallback — failure cases', () => {
  it('handles non-201 status response gracefully', async () => {
    const doFetch = makeFetch(422);
    const result = await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'd'.repeat(40),
      pullRequestNumber: null,
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    assert.strictEqual(result.statusSent, false);
    assert.strictEqual(result.commentSent, false);
  });

  it('handles fetch throwing without throwing itself', async () => {
    const doFetch = async () => { throw new Error('network error'); };
    const result = await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'e'.repeat(40),
      pullRequestNumber: null,
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    assert.strictEqual(result.statusSent, false);
  });

  it('handles invalid repository format gracefully', async () => {
    const result = await sendGithubCallback({
      repository: 'not-valid-no-slash',
      sha: 'f'.repeat(40),
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
    });
    assert.strictEqual(result.statusSent, false);
    assert.strictEqual(result.reason, 'invalid-repository');
  });

  it('maps scan error to "error" commit state', async () => {
    const doFetch = makeFetch(201);
    await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'g'.repeat(40),
      scanResult: { status: 'failed', error: 'timeout' },
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    const body = statusBody(doFetch);
    assert.strictEqual(body.state, 'error');
  });

  it('maps clean scan to "success" commit state', async () => {
    const doFetch = makeFetch(201);
    await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'h'.repeat(40),
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    const body = statusBody(doFetch);
    assert.strictEqual(body.state, 'success');
  });

  it('maps scan with error-severity issues to "failure" commit state in STRICT mode', async () => {
    // Stub the contents fetch to return mode: "strict" so the callback
    // enters strict-mode behaviour and turns errors into a failure check.
    const strictContents = Buffer.from(JSON.stringify({ mode: 'strict' }), 'utf-8').toString('base64');
    const calls = [];
    const doFetch = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/contents/.gatetest.json')) {
        return { ok: true, status: 200, json: async () => ({ content: strictContents, encoding: 'base64' }) };
      }
      return { ok: true, status: 201, json: async () => ({}) };
    };
    doFetch.calls = calls;
    await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'i'.repeat(40),
      scanResult: makeScanResult({
        totalIssues: 3,
        modules: [{ name: 'lint', status: 'failed', issues: 3, checks: [{ severity: 'error' }], details: [] }],
      }),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    const body = statusBody(doFetch);
    assert.strictEqual(body.state, 'failure');
  });

  it('maps scan with error-severity issues to "success" in ADVISORY mode (default)', async () => {
    const doFetch = makeFetch(201);
    await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'i'.repeat(40),
      scanResult: makeScanResult({
        totalIssues: 3,
        modules: [{ name: 'lint', status: 'failed', issues: 3, checks: [{ severity: 'error' }], details: [] }],
      }),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    const body = statusBody(doFetch);
    assert.strictEqual(body.state, 'success', 'advisory default must NOT block on errors');
  });
});

describe('sendGithubCallback — commit status payload', () => {
  it('uses the correct status context name', async () => {
    const doFetch = makeFetch(201);
    await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'j'.repeat(40),
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test' },
      fetchImpl: doFetch,
    });
    const body = statusBody(doFetch);
    assert.strictEqual(body.context, 'gatetest / scan');
  });

  it('includes target_url in status payload', async () => {
    const doFetch = makeFetch(201);
    await sendGithubCallback({
      repository: 'owner/repo',
      sha: 'k'.repeat(40),
      scanResult: makeScanResult(),
      env: { GATETEST_GITHUB_TOKEN: 'ghp_test', NEXT_PUBLIC_BASE_URL: 'https://gatetest.ai' },
      fetchImpl: doFetch,
    });
    const body = statusBody(doFetch);
    assert.ok(body.target_url, 'expected target_url in payload');
    assert.ok(body.target_url.startsWith('https://gatetest.ai'), `unexpected target_url: ${body.target_url}`);
  });
});

// Regression: Known Issue #23 — every push spawned a new bot comment.
// With the marker-based upsert in place, the second post on the same PR
// must PATCH the prior comment in place (returns {action: 'updated'})
// rather than POST a new one.
describe('postPrComment — idempotent via signature marker', () => {
  const {
    postPrComment,
    GATETEST_PR_COMMENT_MARKER,
  } = require('../website/app/lib/github-callback');

  function makeFetchSequence(responses) {
    const calls = [];
    let i = 0;
    return {
      calls,
      doFetch: async (url, init) => {
        calls.push({ url, init: init || {} });
        const r = responses[i++] || { status: 200, json: async () => [] };
        return {
          status: r.status,
          json: r.json || (async () => r.body || []),
        };
      },
    };
  }

  it('POSTs a new comment when no prior bot comment exists', async () => {
    const { doFetch, calls } = makeFetchSequence([
      // First fetch: list comments (page 1) — empty
      { status: 200, json: async () => [] },
      // Second fetch: POST new comment
      { status: 201, json: async () => ({ id: 999 }) },
    ]);
    const body = `${GATETEST_PR_COMMENT_MARKER}\n## Gate failed`;
    const r = await postPrComment({
      owner: 'a', repo: 'b', prNumber: 42, body, token: 'ghp_x', fetchImpl: doFetch,
    });
    assert.deepStrictEqual(r, { ok: true, status: 201, action: 'created' });
    assert.strictEqual(calls[0].init.method, 'GET', 'first call must list comments');
    assert.strictEqual(calls[1].init.method, 'POST', 'second call must POST');
  });

  it('PATCHes the prior comment in place when one with the marker exists', async () => {
    const priorId = 777;
    const { doFetch, calls } = makeFetchSequence([
      // List page 1: one matching comment
      { status: 200, json: async () => [{ id: priorId, body: `${GATETEST_PR_COMMENT_MARKER}\nold body` }] },
      // PATCH that comment
      { status: 200, json: async () => ({ id: priorId }) },
    ]);
    const body = `${GATETEST_PR_COMMENT_MARKER}\n## Gate passed`;
    const r = await postPrComment({
      owner: 'a', repo: 'b', prNumber: 42, body, token: 'ghp_x', fetchImpl: doFetch,
    });
    assert.deepStrictEqual(r, { ok: true, status: 200, action: 'updated' });
    assert.strictEqual(calls[0].init.method, 'GET');
    assert.strictEqual(calls[1].init.method, 'PATCH');
    assert.match(calls[1].url, new RegExp(`/comments/${priorId}$`));
    // Must NOT have fallen through to POST.
    assert.strictEqual(calls.length, 2, `expected exactly 2 fetches, got ${calls.length}`);
  });

  it('falls back to POST when body has NO marker (legacy callers)', async () => {
    const { doFetch, calls } = makeFetchSequence([
      // No list/patch — first call should be the POST.
      { status: 201, json: async () => ({ id: 1 }) },
    ]);
    const r = await postPrComment({
      owner: 'a', repo: 'b', prNumber: 1, body: 'plain comment no marker', token: 'x', fetchImpl: doFetch,
    });
    assert.deepStrictEqual(r, { ok: true, status: 201, action: 'created' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].init.method, 'POST');
  });

  it('falls back to POST when list call fails (resilient to transient errors)', async () => {
    const { doFetch, calls } = makeFetchSequence([
      { status: 500, json: async () => ({}) }, // list fails
      { status: 201, json: async () => ({ id: 1 }) }, // POST succeeds
    ]);
    const body = `${GATETEST_PR_COMMENT_MARKER}\nbody`;
    const r = await postPrComment({
      owner: 'a', repo: 'b', prNumber: 1, body, token: 'x', fetchImpl: doFetch,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'created');
    assert.strictEqual(calls[1].init.method, 'POST');
  });

  it('paginates through comment list (page 1 full, page 2 has match)', async () => {
    // Page 1 has 100 non-matching comments → must request page 2
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'other-bot comment' }));
    const page2 = [{ id: 9999, body: `${GATETEST_PR_COMMENT_MARKER}\nold` }];
    const { doFetch, calls } = makeFetchSequence([
      { status: 200, json: async () => page1 },
      { status: 200, json: async () => page2 },
      { status: 200, json: async () => ({ id: 9999 }) }, // PATCH
    ]);
    const body = `${GATETEST_PR_COMMENT_MARKER}\nnew`;
    const r = await postPrComment({
      owner: 'a', repo: 'b', prNumber: 1, body, token: 'x', fetchImpl: doFetch,
    });
    assert.strictEqual(r.action, 'updated');
    assert.match(calls[0].url, /page=1/);
    assert.match(calls[1].url, /page=2/);
    assert.strictEqual(calls[2].init.method, 'PATCH');
  });
});
