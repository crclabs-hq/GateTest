// =============================================================================
// POST-INLINE-SUGGESTIONS TEST — scripts/post-inline-suggestions.js
// =============================================================================
// Covers diff/hunk computation, suggestion-comment body rendering, and the
// end-to-end posting flow with a mocked fetch (no real HTTP).
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  computeSingleHunk,
  renderSuggestionCommentBody,
  postOneInlineSuggestion,
  postInlineSuggestionsForPatches,
} = require('../scripts/post-inline-suggestions');

// ─── computeSingleHunk ─────────────────────────────────────────────────────
describe('computeSingleHunk', () => {
  it('returns null for identical content', () => {
    const a = "line one\nline two\nline three\n";
    assert.strictEqual(computeSingleHunk(a, a), null);
  });

  it('finds a single-line replacement in the middle of a file', () => {
    const orig = "line one\nline two\nline three\n";
    const fixed = "line one\nline TWO\nline three\n";
    const h = computeSingleHunk(orig, fixed);
    assert.strictEqual(h.startLine, 2);
    assert.strictEqual(h.endLine, 2);
    assert.strictEqual(h.replacement, 'line TWO');
  });

  it('finds a multi-line replacement', () => {
    const orig = "a\nb\nc\nd\ne\n";
    const fixed = "a\nB\nC\nD\ne\n";
    const h = computeSingleHunk(orig, fixed);
    assert.strictEqual(h.startLine, 2);
    assert.strictEqual(h.endLine, 4);
    assert.strictEqual(h.replacement, 'B\nC\nD');
  });

  it('handles an insertion (file grew)', () => {
    const orig = "a\nb\nc\n";
    const fixed = "a\nb\nINSERTED\nc\n";
    const h = computeSingleHunk(orig, fixed);
    assert.ok(h, 'must produce a hunk for an insertion');
    assert.ok(h.replacement.includes('INSERTED'));
  });

  it('handles a deletion (file shrank)', () => {
    const orig = "a\nb\nDELETED\nc\n";
    const fixed = "a\nb\nc\n";
    const h = computeSingleHunk(orig, fixed);
    assert.ok(h);
    // The deletion is reflected as a smaller replacement region; the
    // exact bounds are caller-controlled but the result must not contain
    // the deleted line.
    assert.ok(!h.replacement.includes('DELETED'));
  });

  it('handles the Crontech bug shape (add an import at top)', () => {
    const orig = [
      "const config = {",
      "  tenantCapResolver: resolveTenantCapForHotPath,",
      "};",
      "",
    ].join('\n');
    const fixed = [
      'import { resolveTenantCapForHotPath } from "./quotas";',
      "",
      "const config = {",
      "  tenantCapResolver: resolveTenantCapForHotPath,",
      "};",
      "",
    ].join('\n');
    const h = computeSingleHunk(orig, fixed);
    assert.ok(h);
    assert.ok(h.replacement.includes('import {'),
      `expected import in replacement, got: ${h.replacement}`);
  });

  it('handles CRLF / LF mixed line endings without spurious diff', () => {
    const orig = "a\r\nb\r\nc\r\n";
    const fixed = "a\nb\nc\n";
    // Same content, different line endings — must not report a diff.
    assert.strictEqual(computeSingleHunk(orig, fixed), null);
  });
});

// ─── renderSuggestionCommentBody ───────────────────────────────────────────
describe('renderSuggestionCommentBody', () => {
  it('emits the ```suggestion``` block GitHub recognises', () => {
    const body = renderSuggestionCommentBody({
      reason: 'undefined reference fix',
      replacement: 'import { foo } from "./bar";',
    });
    assert.ok(body.includes('```suggestion'),
      'body must contain a ```suggestion fence');
    assert.ok(body.includes('import { foo } from "./bar";'));
    assert.ok(body.includes('GateTest auto-fix'));
    assert.ok(body.includes('Commit suggestion'),
      'body should hint at the GitHub button name');
  });

  it('omits the reason cleanly when not supplied', () => {
    const body = renderSuggestionCommentBody({ replacement: 'x' });
    assert.ok(body.startsWith('**GateTest auto-fix**'));
    assert.ok(!body.includes('— undefined'));
  });
});

// ─── Fetch-mocked posting ──────────────────────────────────────────────────
function makeFetchMock(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init || {} });
      const r = responses[i++] || { status: 201 };
      return { status: r.status };
    },
  };
}

describe('postOneInlineSuggestion', () => {
  it('POSTs to the pulls/comments endpoint with the correct shape', async () => {
    const { calls, fetchImpl } = makeFetchMock([{ status: 201 }]);
    const r = await postOneInlineSuggestion({
      owner: 'o', repo: 'r', prNumber: 1, headSha: 'a'.repeat(40),
      filePath: 'x.ts', startLine: 1, endLine: 1, body: 'hi',
      token: 't', fetchImpl,
    });
    assert.deepStrictEqual(r, { ok: true, status: 201 });
    assert.match(calls[0].url, /\/repos\/o\/r\/pulls\/1\/comments$/);
    assert.strictEqual(calls[0].init.method, 'POST');
    const sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(sent.path, 'x.ts');
    assert.strictEqual(sent.line, 1);
    assert.strictEqual(sent.side, 'RIGHT');
    assert.strictEqual(sent.start_line, undefined,
      'single-line suggestions must NOT set start_line (GitHub rejects start_line === line)');
  });

  it('sets start_line for multi-line suggestions', async () => {
    const { calls, fetchImpl } = makeFetchMock([{ status: 201 }]);
    await postOneInlineSuggestion({
      owner: 'o', repo: 'r', prNumber: 1, headSha: 'a'.repeat(40),
      filePath: 'x.ts', startLine: 5, endLine: 8, body: 'hi',
      token: 't', fetchImpl,
    });
    const sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(sent.start_line, 5);
    assert.strictEqual(sent.line, 8);
    assert.strictEqual(sent.start_side, 'RIGHT');
  });

  it('returns ok:false on non-201 (e.g. 422 line-not-in-diff)', async () => {
    const { fetchImpl } = makeFetchMock([{ status: 422 }]);
    const r = await postOneInlineSuggestion({
      owner: 'o', repo: 'r', prNumber: 1, headSha: 'a'.repeat(40),
      filePath: 'x.ts', startLine: 1, endLine: 1, body: 'hi',
      token: 't', fetchImpl,
    });
    assert.deepStrictEqual(r, { ok: false, status: 422 });
  });
});

describe('postInlineSuggestionsForPatches', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-suggest-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips silently when no patch file exists', async () => {
    const { fetchImpl } = makeFetchMock([]);
    const r = await postInlineSuggestionsForPatches({
      workspace: tmp,
      owner: 'o', repo: 'r', prNumber: 1, headSha: 'a',
      token: 't', fetchImpl,
    });
    assert.strictEqual(r.posted, 0);
    assert.strictEqual(r.errors, 0);
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.details[0].reason, 'no-patch-file');
  });

  it('processes patches passed explicitly + posts one suggestion per changed file', async () => {
    // Seed an original file
    const filename = 'src/handler.ts';
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, filename),
      "const x = createSomething({\n  resolver: undefinedFn,\n});\n");
    const patches = [{
      file: filename,
      newContent:
        "import { undefinedFn } from './lib';\n" +
        "\n" +
        "const x = createSomething({\n  resolver: undefinedFn,\n});\n",
      reason: 'add missing import',
    }];
    const { fetchImpl, calls } = makeFetchMock([{ status: 201 }]);
    const r = await postInlineSuggestionsForPatches({
      patches,
      workspace: tmp,
      owner: 'o', repo: 'r', prNumber: 5, headSha: 'b'.repeat(40),
      token: 't', fetchImpl,
    });
    assert.strictEqual(r.posted, 1, JSON.stringify(r));
    assert.strictEqual(r.errors, 0);
    assert.strictEqual(calls.length, 1);
    const sent = JSON.parse(calls[0].init.body);
    assert.match(sent.body, /```suggestion/);
    assert.match(sent.body, /add missing import/);
  });

  it('skips a patch whose file does not exist on disk', async () => {
    const patches = [{ file: 'no-such.ts', newContent: 'x' }];
    const { fetchImpl } = makeFetchMock([]);
    const r = await postInlineSuggestionsForPatches({
      patches, workspace: tmp,
      owner: 'o', repo: 'r', prNumber: 1, headSha: 'a',
      token: 't', fetchImpl,
    });
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.details[0].reason, 'file-not-on-disk');
  });

  it('skips a patch with no actual diff (file already correct)', async () => {
    const filename = 'a.ts';
    fs.writeFileSync(path.join(tmp, filename), 'already correct\n');
    const patches = [{ file: filename, newContent: 'already correct\n' }];
    const { fetchImpl } = makeFetchMock([]);
    const r = await postInlineSuggestionsForPatches({
      patches, workspace: tmp,
      owner: 'o', repo: 'r', prNumber: 1, headSha: 'a',
      token: 't', fetchImpl,
    });
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.details[0].reason, 'no-diff');
  });

  // The applyPatches snapshot includes pre-write originalContent so the
  // helper doesn't have to read from disk after the fix has already
  // overwritten it. This is the real wiring path in production.
  it('uses snapshot originalContent when provided (skips disk read)', async () => {
    // Note: NO file written to disk. The helper must use originalContent
    // from the patch object directly.
    const patches = [{
      file: 'src/handler.ts',
      originalContent: "function broken() {\n  return undefinedRef;\n}\n",
      newContent: "function broken() {\n  return knownRef;\n}\n",
      reason: 'rename to existing symbol',
    }];
    const { fetchImpl, calls } = makeFetchMock([{ status: 201 }]);
    const r = await postInlineSuggestionsForPatches({
      patches, workspace: tmp,
      owner: 'o', repo: 'r', prNumber: 5, headSha: 'b'.repeat(40),
      token: 't', fetchImpl,
    });
    assert.strictEqual(r.posted, 1, JSON.stringify(r));
    const sent = JSON.parse(calls[0].init.body);
    assert.match(sent.body, /```suggestion/);
    assert.match(sent.body, /knownRef/);
    assert.strictEqual(sent.path, 'src/handler.ts');
  });

  it('aggregates outcomes across multiple patches', async () => {
    fs.writeFileSync(path.join(tmp, 'good.ts'), 'old line\n');
    const patches = [
      { file: 'good.ts', newContent: 'new line\n' },           // posts
      { file: 'missing.ts', newContent: 'x' },                  // skip: file-not-on-disk
      { file: 'good.ts', newContent: 'new line\n', reason: 'dup' }, // posts a second
    ];
    fs.writeFileSync(path.join(tmp, 'good.ts'), 'old line\n');
    const { fetchImpl } = makeFetchMock([{ status: 201 }, { status: 201 }]);
    const r = await postInlineSuggestionsForPatches({
      patches, workspace: tmp,
      owner: 'o', repo: 'r', prNumber: 1, headSha: 'a',
      token: 't', fetchImpl,
    });
    assert.strictEqual(r.posted, 2);
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.total, 3);
  });
});
