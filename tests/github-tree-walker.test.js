'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { walkGithubTree } = require('../website/app/lib/github-tree-walker');

function jsonRes(status, body) {
  return { status, json: async () => body };
}

function dirEntry(path) {
  return { type: 'dir', path, name: path.split('/').pop() };
}
function fileEntry(path) {
  return { type: 'file', path, name: path.split('/').pop() };
}

describe('walkGithubTree — basic traversal', () => {
  it('enumerates a flat directory of files', async () => {
    const fetchImpl = async () =>
      jsonRes(200, [fileEntry('a.js'), fileEntry('b.js'), fileEntry('c.js')]);

    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.warning, null);
    assert.deepStrictEqual(r.paths.sort(), ['a.js', 'b.js', 'c.js']);
    assert.strictEqual(r.callsUsed, 1);
  });

  it('recurses into subdirectories', async () => {
    const fetchImpl = async (url) => {
      const dirPath = new URL(url).pathname.split('/contents/')[1] || '';
      if (dirPath === '') {
        return jsonRes(200, [fileEntry('root.js'), dirEntry('src')]);
      }
      if (dirPath === 'src') {
        return jsonRes(200, [fileEntry('src/index.js'), dirEntry('src/lib')]);
      }
      if (dirPath === 'src/lib') {
        return jsonRes(200, [fileEntry('src/lib/util.js')]);
      }
      return jsonRes(404, {});
    };

    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl, concurrency: 2 });
    assert.strictEqual(r.truncated, false);
    assert.deepStrictEqual(
      r.paths.sort(),
      ['root.js', 'src/index.js', 'src/lib/util.js'].sort(),
    );
    assert.strictEqual(r.callsUsed, 3);
  });

  it('skips symlink/submodule entries — neither collected nor recursed', async () => {
    const fetchImpl = async () =>
      jsonRes(200, [
        fileEntry('real.js'),
        { type: 'symlink', path: 'link-to-elsewhere', name: 'link-to-elsewhere' },
        { type: 'submodule', path: 'vendor/thing', name: 'thing' },
      ]);

    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.deepStrictEqual(r.paths, ['real.js']);
    assert.strictEqual(r.callsUsed, 1); // no recursion into the symlink/submodule
  });

  it('treats a non-array response (path resolved to a file) as an empty directory', async () => {
    const fetchImpl = async () => jsonRes(200, { type: 'file', path: 'a.js' });
    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.deepStrictEqual(r.paths, []);
    assert.strictEqual(r.truncated, false);
  });

  it('treats a 404 for a directory as empty rather than aborting the whole walk', async () => {
    const fetchImpl = async () => jsonRes(404, { message: 'Not Found' });
    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.deepStrictEqual(r.paths, []);
    assert.strictEqual(r.truncated, false);
  });
});

describe('walkGithubTree — budget enforcement (never silently claims completeness)', () => {
  it('stops and reports truncated when the call budget is exceeded', async () => {
    // Every directory has one more subdirectory — an effectively unbounded tree.
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonRes(200, [dirEntry(`d${calls}`)]);
    };

    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl, maxCalls: 5, concurrency: 1 });
    assert.strictEqual(r.truncated, true);
    assert.match(r.warning, /call budget exceeded/);
    assert.ok(r.callsUsed <= 5, `expected callsUsed <= 5, got ${r.callsUsed}`);
  });

  it('stops and reports truncated when the time budget is exceeded', async () => {
    const fetchImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonRes(200, [dirEntry('next')]);
    };

    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl, maxMs: 30, concurrency: 1 });
    assert.strictEqual(r.truncated, true);
    assert.match(r.warning, /time budget exceeded/);
  });

  it('aborts with truncated:true (not a crash) when GitHub rate-limits the walk', async () => {
    const fetchImpl = async () => jsonRes(403, { message: 'API rate limit exceeded' });
    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.strictEqual(r.truncated, true);
    assert.match(r.warning, /rate-limited/);
    assert.deepStrictEqual(r.paths, []);
  });

  it('never claims completeness (warning is null) when nothing was cut short', async () => {
    const fetchImpl = async () => jsonRes(200, [fileEntry('a.js')]);
    const r = await walkGithubTree({ owner: 'o', repo: 'r', token: 't', fetchImpl });
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.warning, null);
  });
});
