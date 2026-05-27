// =============================================================================
// GitHub launch-hardening tests
// =============================================================================
// Two pieces:
//   1. fetchTreeWithMetadata — surfaces truncation when GitHub's
//      git/trees endpoint says `truncated: true` (Manifest #19 /
//      Known Issue #24)
//   2. postPrComment idempotency — when called with `idempotencyTag`,
//      walks existing comments, PATCHes the matching one instead of
//      POSTing a fresh duplicate (Manifest #20 / Known Issue #23)
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// PART 1: fetchTreeWithMetadata — source-text contract test
// ---------------------------------------------------------------------------
// The TS file is harder to import directly into node-test without a
// transpile step. We validate the contract via source-text matching on
// the documented patterns. End-to-end behaviour is covered by the
// website TypeScript build (`npx tsc --noEmit`).

const fs = require('fs');
const path = require('path');

const CLIENT_PATH = path.join(__dirname, '..', 'website', 'app', 'lib', 'gluecron-client.ts');

describe('fetchTreeWithMetadata — source-text contract', () => {
  const src = fs.readFileSync(CLIENT_PATH, 'utf8');

  it('exports FetchTreeResult interface with paths/truncated/warning fields', () => {
    assert.match(src, /export\s+interface\s+FetchTreeResult/);
    assert.match(src, /paths:\s*string\[\]/);
    assert.match(src, /truncated:\s*boolean/);
    assert.match(src, /warning:\s*string\s*\|\s*null/);
  });

  it('exports fetchTreeWithMetadata returning Promise<FetchTreeResult>', () => {
    assert.match(src, /export\s+async\s+function\s+fetchTreeWithMetadata/);
    assert.match(src, /Promise<FetchTreeResult>/);
  });

  it('reads the truncated flag from the GitHub response', () => {
    assert.match(src, /truncated\?:\s*boolean/);
    assert.match(src, /ghData\.truncated\s*===\s*true/);
  });

  it('logs a console.warn when truncation is detected', () => {
    assert.match(src, /console\.warn\(`\[fetchTree\]/);
  });

  it('warns at the large-repo threshold (TREE_SIZE_WARN_THRESHOLD)', () => {
    assert.match(src, /TREE_SIZE_WARN_THRESHOLD\s*=\s*50_000/);
    assert.match(src, /paths\.length\s*>\s*TREE_SIZE_WARN_THRESHOLD/);
  });

  it('preserves backward-compatible fetchTree() returning string[]', () => {
    assert.match(src, /export\s+async\s+function\s+fetchTree\(/);
    assert.match(src, /Promise<string\[\]>/);
    // Verify it delegates to fetchTreeWithMetadata
    assert.match(src, /return\s+result\.paths/);
  });

  it('falls back to Gluecron when GitHub is not the source', () => {
    assert.match(src, /gluecronApi\(/);
    assert.match(src, /\/api\/v2\/repos\//);
  });

  it('warns on Gluecron truncation in the same way', () => {
    // The Gluecron branch should also check truncated and emit a warning
    assert.match(src, /payload\.truncated\s*===\s*true/);
  });
});

// ---------------------------------------------------------------------------
// PART 2: postPrComment idempotency — end-to-end with mock fetch
// ---------------------------------------------------------------------------

const CB = require('../website/app/lib/github-callback.js');

function mockFetch(handler) {
  return async (url, init) => {
    return handler({ url, init });
  };
}

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

describe('postPrComment — exports', () => {
  it('exports postPrComment and findExistingComment', () => {
    assert.strictEqual(typeof CB.postPrComment, 'function');
    assert.strictEqual(typeof CB.findExistingComment, 'function');
  });
});

describe('postPrComment — backward compat (no idempotencyTag)', () => {
  it('POSTs a fresh comment when no tag supplied', async () => {
    const calls = [];
    const fetchImpl = mockFetch(({ url, init }) => {
      calls.push({ url, method: init.method });
      return jsonResponse(201, { id: 999 });
    });
    const result = await CB.postPrComment({
      owner: 'o', repo: 'r', prNumber: 1, body: 'hello', token: 't',
      fetchImpl,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'created');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'POST');
  });

  it('returns ok:false on non-201', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(403, { message: 'forbidden' }));
    const result = await CB.postPrComment({
      owner: 'o', repo: 'r', prNumber: 1, body: 'hello', token: 't',
      fetchImpl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 403);
  });
});

describe('postPrComment — idempotency (with tag)', () => {
  it('POSTs a new comment when no prior tagged comment exists', async () => {
    const calls = [];
    const fetchImpl = mockFetch(({ url, init }) => {
      calls.push({ url, method: init.method });
      if (init.method === 'GET') {
        // No prior comments
        return jsonResponse(200, []);
      }
      return jsonResponse(201, { id: 5 });
    });
    const result = await CB.postPrComment({
      owner: 'o', repo: 'r', prNumber: 7, body: 'first', token: 't',
      fetchImpl, idempotencyTag: 'gate-result',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'created');
    // Should have done at least one GET (look-up) + one POST
    assert.ok(calls.some((c) => c.method === 'GET'));
    assert.ok(calls.some((c) => c.method === 'POST'));
  });

  it('PATCHes the existing comment when the tag is found', async () => {
    const calls = [];
    const fetchImpl = mockFetch(({ url, init }) => {
      calls.push({ url, method: init.method });
      if (init.method === 'GET') {
        return jsonResponse(200, [
          { id: 100, body: 'unrelated bot comment' },
          { id: 200, body: 'previous gate run\n\n<!-- gatetest-tag:gate-result -->\n' },
        ]);
      }
      // PATCH /repos/o/r/issues/comments/200
      return jsonResponse(200, { id: 200, body: 'updated' });
    });
    const result = await CB.postPrComment({
      owner: 'o', repo: 'r', prNumber: 7, body: 'second run', token: 't',
      fetchImpl, idempotencyTag: 'gate-result',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'updated');
    assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.includes('/issues/comments/200')));
    // Must not have POSTed
    assert.ok(!calls.some((c) => c.method === 'POST'));
  });

  it('falls back to POST if the look-up fails', async () => {
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      if (init.method === 'GET') throw new Error('network down');
      return jsonResponse(201, { id: 1 });
    };
    const result = await CB.postPrComment({
      owner: 'o', repo: 'r', prNumber: 7, body: 'fallback', token: 't',
      fetchImpl, idempotencyTag: 'gate-result',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'created');
    assert.ok(calls >= 2);
  });

  it('appends the marker to the posted body so future runs find it', async () => {
    const captured = { posted: null };
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET') return jsonResponse(200, []);
      captured.posted = JSON.parse(init.body);
      return jsonResponse(201, { id: 1 });
    };
    await CB.postPrComment({
      owner: 'o', repo: 'r', prNumber: 7, body: 'hello world', token: 't',
      fetchImpl, idempotencyTag: 'gate-result',
    });
    assert.match(captured.posted.body, /<!-- gatetest-tag:gate-result -->/);
    assert.match(captured.posted.body, /hello world/);
  });
});

describe('findExistingComment — pagination walk', () => {
  it('returns null when the PR has no comments', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, []));
    const r = await CB.findExistingComment({
      owner: 'o', repo: 'r', prNumber: 1, token: 't', fetchImpl, tag: 'gate-result',
    });
    assert.strictEqual(r, null);
  });

  it('walks multiple pages until the tag is found', async () => {
    let page = 0;
    const fetchImpl = async () => {
      page += 1;
      if (page === 1) {
        // Full page of 100, none matching
        const arr = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'noise' }));
        return jsonResponse(200, arr);
      }
      if (page === 2) {
        return jsonResponse(200, [
          { id: 9999, body: 'gate body\n\n<!-- gatetest-tag:gate-result -->\n' },
        ]);
      }
      return jsonResponse(200, []);
    };
    const r = await CB.findExistingComment({
      owner: 'o', repo: 'r', prNumber: 1, token: 't', fetchImpl, tag: 'gate-result',
    });
    assert.ok(r);
    assert.strictEqual(r.id, 9999);
  });

  it('caps at 10 pages to avoid runaway walking', async () => {
    let pages = 0;
    const fetchImpl = async () => {
      pages += 1;
      // Always return 100 non-matching items so the walker keeps going
      const arr = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'noise' }));
      return jsonResponse(200, arr);
    };
    const r = await CB.findExistingComment({
      owner: 'o', repo: 'r', prNumber: 1, token: 't', fetchImpl, tag: 'gate-result',
    });
    assert.strictEqual(r, null);
    assert.strictEqual(pages, 10);
  });
});
