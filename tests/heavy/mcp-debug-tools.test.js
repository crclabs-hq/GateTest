'use strict';

// =============================================================================
// MCP ROOT-CAUSE TOOLS TEST — resolve_stack_trace + blame_regression handlers
// =============================================================================
// Calls the REAL handlers via dynamic import (the .mjs guards its stdio
// connect behind an entrypoint check), same pattern as
// tests/mcp-eyes-tools.test.js and tests/mcp-verify-fix.test.js. Both
// handlers wrap the exact same core engines already unit-tested in
// tests/source-map-resolver.test.js and tests/regression-bisector.test.js —
// this file proves the MCP plumbing (arg validation, formatting) on top.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let mcp;

before(async () => {
  mcp = await import('../bin/gatetest-mcp.mjs');
});

function textOf(res) {
  return (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('handleResolveStackTrace', () => {
  let dir;
  let bundlePath;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-mcp-trace-'));
    bundlePath = path.join(dir, 'bundle.js');
    // eslint-disable-next-line global-require
    const { encodeVLQSegment } = require('../../src/core/source-map-resolver.js');
    const mapJson = JSON.stringify({
      version: 3,
      sources: ['original.js'],
      sourcesContent: ['function add(a, b) {\n  return a + b;\n}\n'],
      names: [],
      mappings: [9, 0, 1, 2].map(encodeVLQSegment).join(''),
    });
    fs.writeFileSync(bundlePath, 'function add(a,b){return a+b}\n//# sourceMappingURL=bundle.js.map\n');
    fs.writeFileSync(path.join(dir, 'bundle.js.map'), mapJson);
  });

  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('requires stackTrace', async () => {
    const res = await mcp.handleResolveStackTrace({});
    assert.strictEqual(res.isError, true);
  });

  it('resolves a real frame back to original source', async () => {
    const res = await mcp.handleResolveStackTrace({
      stackTrace: `Error: boom\n    at add (${bundlePath}:1:10)\n`,
    });
    assert.strictEqual(res.isError, undefined);
    const text = textOf(res);
    assert.match(text, /original\.js/);
    assert.match(text, /return a \+ b/);
  });

  it('reports zero recognised frames without erroring', async () => {
    const res = await mcp.handleResolveStackTrace({ stackTrace: 'nothing to see here' });
    assert.match(textOf(res), /No stack frames recognised/);
  });
});

describe('handleBlameRegression', () => {
  let repo;
  let commit2;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-mcp-blame-'));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 'test@gatetest.local'], repo);
    git(['config', 'user.name', 'GateTest Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nline2\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'initial commit'], repo);

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nBUGGY_LINE\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'introduce the bug'], repo);
    commit2 = git(['rev-parse', 'HEAD'], repo).trim();
  });

  after(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('requires path', async () => {
    const res = await mcp.handleBlameRegression({ file: 'app.js', line: 2 });
    assert.strictEqual(res.isError, true);
  });

  it('blames a single line', async () => {
    const res = await mcp.handleBlameRegression({ path: repo, file: 'app.js', line: 2 });
    assert.strictEqual(res.isError, undefined);
    assert.match(textOf(res), /introduce the bug/);
  });

  it('shows a commit directly by hash', async () => {
    const res = await mcp.handleBlameRegression({ path: repo, commit: commit2 });
    assert.strictEqual(res.isError, undefined);
    assert.match(textOf(res), /BUGGY_LINE/);
  });

  it('ranks candidates across multiple hits', async () => {
    const res = await mcp.handleBlameRegression({
      path: repo,
      hits: [{ file: 'app.js', line: 2 }, { file: 'app.js', line: 2 }],
    });
    assert.strictEqual(res.isError, undefined);
    assert.match(textOf(res), /Likely regression commit/);
    assert.match(textOf(res), /2\/2 hit/);
  });

  it('returns an error when no mode is specified', async () => {
    const res = await mcp.handleBlameRegression({ path: repo });
    assert.strictEqual(res.isError, true);
  });
});
