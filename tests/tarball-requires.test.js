'use strict';

// =============================================================================
// THE PUBLISHED TARBALL MUST BE SELF-CONTAINED.
// =============================================================================
// @gatetest/cli 1.61.0 on npm: lib/pr-composer.js does `require('./site-url')`
// and lib/site-url.js is not in the tarball — `npx -p @gatetest/cli
// gatetest-mcp` died on "Cannot find module './site-url'" before it read a
// byte of stdin. Nothing in the suite could have caught it: the repo's lib/
// copy did not have the require, prepublishOnly's sync-lib copied the
// website copy (which did) over it at publish time, and site-url.js was not
// in the copy list.
//
// Three pins, in the order the failure would surface:
//   1. lib/ is exactly what scripts/sync-lib.js would produce — so the
//      committed tree IS the shipped tree, and a review sees every byte.
//   2. Every relative require / import in every JS file `npm pack` would
//      ship resolves to a file `npm pack` would also ship.
//   3. Every bin package.json declares is in the tarball, and one is named
//      after the package so bare `npx @gatetest/cli` resolves.
// =============================================================================

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** `npm pack --dry-run --json` — the file list npm would put in the tarball. */
function packedFiles() {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `npm pack --dry-run failed:\n${r.stderr}`);
  // npm prints the JSON on stdout; notices (the dry-run banner) go to stderr.
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  return new Set(json[0].files.map((f) => f.path.replace(/\\/g, '/')));
}

// Static, string-literal, relative specifiers only, read from the AST — a
// regex over the source flags the `require('./x')` EXAMPLES in the comments
// of the import-graph and dead-code analysers. Dynamic requires are the
// caller's problem; bare specifiers are dependencies and out of scope.
const acorn = require('acorn');

function parse(src, file) {
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true };
  if (file.endsWith('.mjs')) return acorn.parse(src, { ...opts, sourceType: 'module' });
  try { return acorn.parse(src, { ...opts, sourceType: 'script' }); }
  catch { return acorn.parse(src, { ...opts, sourceType: 'module' }); }
}

function isRelative(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string' && /^\.{1,2}\//.test(node.value);
}

/** Every relative specifier a file loads: require(), import, import(), export … from. */
function relativeSpecifiers(src, file) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && isRelative(node.source)) {
      out.push(node.source.value);
    } else if (node.type === 'ImportExpression' && isRelative(node.source)) {
      out.push(node.source.value);
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && isRelative(node.arguments[0])) {
      out.push(node.arguments[0].value);
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(parse(src, file));
  return out;
}

/** Resolve `spec` from `fromFile` (both tarball-relative) inside `files`. */
function resolvesInTarball(files, fromFile, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
    `${base}/index.js`, `${base}/index.mjs`, `${base}/index.cjs`];
  return candidates.some((c) => files.has(c));
}

describe('the npm tarball is self-contained', () => {
  let files;
  before(() => { files = packedFiles(); });

  it('lib/ is byte-for-byte what scripts/sync-lib.js produces (the shipped tree is the committed tree)', () => {
    const { drift, plan } = require('../scripts/sync-lib');
    const entries = plan();
    assert.ok(entries.some((e) => e.name === 'site-url.js'), 'sync-lib must follow pr-composer.js to site-url.js');
    assert.deepEqual(drift(entries), [], 'lib/ is stale — run `npm run sync-lib` and commit the result');
  });

  it('every relative require/import in every packed JS file resolves to a packed file', () => {
    const missing = [];
    for (const file of [...files].sort()) {
      if (!/\.(js|mjs|cjs)$/.test(file)) continue;
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const spec of relativeSpecifiers(src, file)) {
        if (!resolvesInTarball(files, file, spec)) missing.push(`${file} -> ${spec}`);
      }
    }
    assert.deepEqual(missing, [], `these requires point outside the tarball (the 1.61.0 bug class):\n  ${missing.join('\n  ')}`);
  });

  it('every declared bin is packed, and one is named after the package so bare `npx @gatetest/cli` resolves', () => {
    for (const [name, rel] of Object.entries(pkg.bin)) {
      assert.ok(files.has(rel), `bin "${name}" points at ${rel}, which npm pack does not ship`);
    }
    // npx picks the bin whose name matches the unscoped package name; with
    // three differently-named bins it gave "could not determine executable
    // to run" (verified 2026-07-19 and again 2026-09-14).
    const unscoped = pkg.name.replace(/^@[^/]+\//, '');
    assert.ok(pkg.bin[unscoped], `package.json bin must include "${unscoped}" — npx @gatetest/cli cannot pick between ${Object.keys(pkg.bin).join(', ')}`);
    assert.equal(pkg.bin[unscoped], pkg.bin.gatetest, `bin "${unscoped}" must be the gatetest CLI, not a different entry point`);
  });

  it('lib/pr-composer.js and lib/nuclear-diagnoser.js load from the packed lib/ alone', () => {
    // The two lib entry points bin/gatetest-mcp.mjs requires at startup.
    for (const rel of ['lib/pr-composer.js', 'lib/nuclear-diagnoser.js']) {
      assert.ok(files.has(rel), `${rel} must be packed`);
      assert.doesNotThrow(() => require(path.join(ROOT, rel)), `${rel} must load`);
    }
  });
});
