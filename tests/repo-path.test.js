'use strict';

// =============================================================================
// src/core/repo-path.js — ONE repo-relative form for every finding (KI #109)
// =============================================================================
// 174 files depend on this helper transitively (the self-scan's spineHealth
// module flagged it as load-bearing with no test of its own, PR #488). Every
// finding id, `file` field, `.gatetestignore` line and baseline fingerprint
// carries its answer, so the contract is pinned here: `/`-joined on every OS,
// whichever separator the input carried.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { repoRelative, toPosix } = require('../src/core/repo-path');

describe('toPosix', () => {
  it('turns every backslash into a forward slash and leaves forward slashes alone', () => {
    assert.equal(toPosix('src\\index.html'), 'src/index.html');
    assert.equal(toPosix('src/index.html'), 'src/index.html');
    assert.equal(toPosix('a\\b/c\\d'), 'a/b/c/d');
  });
  it('is idempotent and coerces non-strings', () => {
    assert.equal(toPosix(toPosix('x\\y')), 'x/y');
    assert.equal(toPosix(42), '42');
  });
});

describe('repoRelative', () => {
  const root = path.resolve('proj');

  it('is the same string on every OS for the same file', () => {
    const abs = path.join(root, 'src', 'components', 'List.tsx');
    assert.equal(repoRelative(root, abs), 'src/components/List.tsx');
  });

  it('accepts a root-relative input and never yields a backslash', () => {
    assert.equal(repoRelative(root, path.join(root, 'lib', 'server.js')), 'lib/server.js');
    assert.doesNotMatch(repoRelative(root, path.join(root, 'a', 'b', 'c.js')), /\\/);
  });

  it('a file at the root has no directory prefix', () => {
    assert.equal(repoRelative(root, path.join(root, '.npmrc')), '.npmrc');
  });

  it('a path outside the root keeps path.relative semantics, still /-joined', () => {
    const outside = path.resolve('elsewhere', 'x.js');
    const rel = repoRelative(root, outside);
    assert.ok(rel.startsWith('../'), `expected a ../ escape, got ${rel}`);
    assert.doesNotMatch(rel, /\\/);
  });

  it('matches the identity finding-registry and .gatetestignore use', () => {
    // The ignore line a user writes is `module:rule@src/x.js`; the finding
    // must present `src/x.js`, not `src\x.js`, or the line never matches.
    const rel = repoRelative(root, path.join(root, 'src', 'x.js'));
    assert.equal(`secrets:tracked@${rel}`, 'secrets:tracked@src/x.js');
  });
});
