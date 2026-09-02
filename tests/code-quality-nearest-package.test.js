// =============================================================================
// CODE-QUALITY — console.log severity is judged by the package that OWNS the
// file, and by what that package actually publishes.
// =============================================================================
// Self-scan 2026-09-02 (the quick suite CI runs on every PR): 31 blocking
// findings, 30 of them console.log in `website/capture-baseline.mjs`. That file
// is a Playwright capture script inside a PRIVATE Next.js app, in a repo whose
// ROOT package.json publishes `bin/`, `src/` and `lib/`. The module read the
// root package.json, saw a published package, and graded a script nobody can
// import as library code polluting a consumer's console.
//
// Two rules, each with its still-fires half:
//   1. the nearest package.json owns the file (monorepos, nested apps);
//   2. a published package's library code is what its `files` list ships.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodeQualityModule = require('../src/modules/code-quality');

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cq-pkg-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

const PUBLISHING_ROOT = { name: 'pkg', version: '1.0.0', main: 'src/index.js', files: ['bin/', 'src/', 'lib/'] };
const LOGGING = "export function run() {\n  console.log('hello');\n}\n";

function severityOf(root, rel) {
  const mod = new CodeQualityModule();
  const relFwd = rel.replace(/\\/g, '/');
  return mod._severityForForbidden('console\\.', relFwd, "console.log('hello');", root);
}

describe('code-quality — the nearest package.json owns the file', () => {
  it('a script inside a nested private app is a warning (application code), never a blocking error', () => {
    const root = makeRepo({
      'package.json': PUBLISHING_ROOT,
      'src/index.js': 'module.exports = 1;\n',
      'website/package.json': { name: 'site', private: true },
      'website/capture-baseline.mjs': LOGGING,
    });
    try {
      // The pinned rule for application code is `warning` (an app's own src/
      // logging is its business, but worth a look). What must never happen is
      // the root package's publish status turning it into a blocking error.
      assert.strictEqual(severityOf(root, 'website/capture-baseline.mjs'), 'warning');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('a file OUTSIDE the published `files` list of the root package is info', () => {
    const root = makeRepo({
      'package.json': PUBLISHING_ROOT,
      'src/index.js': 'module.exports = 1;\n',
      'website/capture-baseline.mjs': LOGGING, // no nested package.json this time
    });
    try {
      assert.strictEqual(severityOf(root, 'website/capture-baseline.mjs'), 'info');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('NEGATIVE CONTROL: library code the root package ships is still an error', () => {
    const root = makeRepo({
      'package.json': PUBLISHING_ROOT,
      'src/index.js': LOGGING,
      'lib/util.js': LOGGING,
      'website/package.json': { name: 'site', private: true },
    });
    try {
      assert.strictEqual(severityOf(root, 'src/index.js'), undefined, 'module default (error) must stand for shipped src/');
      assert.strictEqual(severityOf(root, 'lib/util.js'), undefined, 'module default (error) must stand for shipped lib/');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('NEGATIVE CONTROL: a nested PUBLISHED workspace package is judged by its own package.json', () => {
    const root = makeRepo({
      'package.json': { name: 'monorepo', private: true, workspaces: ['packages/*'] },
      'packages/core/package.json': { name: '@x/core', version: '1.0.0', main: 'index.js', files: ['index.js', 'dist/'] },
      'packages/core/index.js': LOGGING,
      'packages/core/scripts-like.js': LOGGING,
    });
    try {
      assert.strictEqual(severityOf(root, 'packages/core/index.js'), undefined, 'the published entry point of a workspace package is library code');
      assert.strictEqual(severityOf(root, 'packages/core/scripts-like.js'), 'info', 'a file the workspace package does not ship is not library code');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('an application repo (no publishable package) stays a warning', () => {
    const root = makeRepo({
      'package.json': { name: 'app', private: true },
      'src/server.js': LOGGING,
    });
    try {
      assert.strictEqual(severityOf(root, 'src/server.js'), 'warning');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('`files` globs are honoured by prefix (`dist/**` publishes dist/)', () => {
    const root = makeRepo({
      'package.json': { name: 'pkg', version: '1.0.0', main: 'dist/index.js', files: ['dist/**', '*.d.ts'] },
      'dist/index.js': LOGGING,
      'src/index.js': LOGGING,
    });
    try {
      assert.strictEqual(severityOf(root, 'dist/index.js'), undefined, 'shipped build output is library code');
      assert.strictEqual(severityOf(root, 'src/index.js'), 'info', 'unshipped source is not what a consumer imports');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
