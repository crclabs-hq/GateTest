'use strict';

// DEPENDENCY REACHABILITY — only a critical/high advisory in a production
// dependency that source code actually imports should block. Fixture audit
// JSON in the npm v7+ shape, hand-built repos with known answers.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyAdvisories, gateSeverity, analyseProject, extractImports } = require('../src/core/dependency-reachability');

const AUDIT = {
  vulnerabilities: {
    // reachable: prod dep, imported
    'express-session': { severity: 'high', isDirect: true, via: [{ title: 'x' }], effects: [], range: '<1.18.0', fixAvailable: true },
    // dev-only: pulled in by mocha
    minimatch: { severity: 'high', isDirect: false, via: [{ title: 'ReDoS' }], effects: ['mocha'], range: '<3.0.5', fixAvailable: true },
    mocha: { severity: 'high', isDirect: true, via: ['minimatch'], effects: [], range: '<10', fixAvailable: true },
    // installed-unused: prod dep nobody imports
    lodash: { severity: 'critical', isDirect: true, via: [{ title: 'proto pollution' }], effects: [], range: '<4.17.21', fixAvailable: true },
    // transitive under a prod dep that IS imported → reachable
    qs: { severity: 'high', isDirect: false, via: [{ title: 'y' }], effects: ['express-session'], range: '<6.5', fixAvailable: false },
    // low severity dev-only → summary only
    debug: { severity: 'low', isDirect: false, via: [{ title: 'z' }], effects: ['mocha'], range: '<4', fixAvailable: true },
  },
  metadata: { vulnerabilities: { critical: 1, high: 4, moderate: 0, low: 1 } },
};

describe('dependency-reachability — classification', () => {
  const manifest = { prod: new Set(['express-session', 'lodash']), dev: new Set(['mocha']) };
  const imported = new Set(['express-session', 'express']);
  const byName = Object.fromEntries(classifyAdvisories(AUDIT, { manifest, imported }).map((i) => [i.name, i]));

  it('a prod dependency that source imports is reachable → high blocks', () => {
    assert.equal(byName['express-session'].class, 'reachable');
    assert.equal(gateSeverity(byName['express-session']), 'error');
  });
  it('a transitive advisory under an imported prod dependency is reachable', () => {
    assert.equal(byName.qs.class, 'reachable');
    assert.match(byName.qs.reason, /via express-session/);
  });
  it('an advisory pulled in only by devDependencies is dev-only → info, never blocks', () => {
    assert.equal(byName.minimatch.class, 'dev-only');
    assert.match(byName.minimatch.reason, /devDependencies \(mocha\)/);
    assert.equal(gateSeverity(byName.minimatch), 'info');
    assert.equal(byName.mocha.class, 'dev-only');
  });
  it('a critical advisory in a prod dependency nobody imports is installed-unused → warning, not error', () => {
    assert.equal(byName.lodash.class, 'installed-unused');
    assert.equal(gateSeverity(byName.lodash), 'warning');
  });
});

describe('dependency-reachability — imports from real files', () => {
  it('reads require/import/import()/export-from specifiers, scoped packages, and skips relative + node: + test files', () => {
    assert.deepEqual([...extractImports(`
      const a = require('express-session');
      import b from '@scope/pkg/sub';
      import { c } from "lodash/fp";
      const d = await import('qs');
      export * from './local';
      import e from 'node:fs';
    `)].sort(), ['@scope/pkg', 'express-session', 'lodash', 'qs']);
  });

  it('analyseProject: production source imports count, tests/ do not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-reach-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'express-session': '1', lodash: '4' }, devDependencies: { mocha: '10' } }));
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(path.join(root, 'test'));
      fs.writeFileSync(path.join(root, 'src', 'app.js'), "const s = require('express-session');");
      fs.writeFileSync(path.join(root, 'test', 't.js'), "const _ = require('lodash');"); // test-only import must NOT make lodash reachable
      const r = analyseProject(AUDIT, root);
      const cls = Object.fromEntries(r.items.map((i) => [i.name, i.class]));
      assert.equal(cls['express-session'], 'reachable');
      assert.equal(cls.lodash, 'installed-unused');
      assert.equal(cls.minimatch, 'dev-only');
      assert.deepEqual(r.counts, { reachable: 2, 'installed-unused': 1, 'dev-only': 3, workspace: 0 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// control-pair: security:npm-audit
// nest @ 39fbddae (2026-09-30): advisories published overnight against
// @nestjs/microservices and @nestjs/platform-fastify — nest's OWN packages/*
// at 12.0.1 — blocked its gate as "imported from production source". The
// ws advisory beside them is a real third-party dependency and must keep
// blocking: that is the control.
describe('dependency-reachability — an advisory against the repo\'s own workspace package does not block', () => {
  const MONO_AUDIT = {
    vulnerabilities: {
      '@acme/transport': { severity: 'high', isDirect: true, via: [{ title: 'own release' }], effects: [], range: '12.0.0 - 12.0.2', fixAvailable: false },
      ws: { severity: 'high', isDirect: false, via: [{ title: 'DoS' }], effects: [], range: '8.0.0 - 8.20.1', fixAvailable: true },
    },
    metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 0, low: 0 } },
  };

  it('fires on the third-party dependency, stays quiet (warning) on the workspace member', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-reach-ws-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'], dependencies: { ws: '8' } }));
      for (const [dir, name] of [['transport', '@acme/transport'], ['app', '@acme/app']]) {
        fs.mkdirSync(path.join(root, 'packages', dir), { recursive: true });
        fs.writeFileSync(path.join(root, 'packages', dir, 'package.json'), JSON.stringify({ name, version: '12.0.1' }));
      }
      fs.writeFileSync(path.join(root, 'packages', 'transport', 'index.js'), "const WebSocket = require('ws');\nmodule.exports = WebSocket;\n");
      fs.writeFileSync(path.join(root, 'packages', 'app', 'index.js'), "const t = require('@acme/transport');\nmodule.exports = t;\n");
      const r = analyseProject(MONO_AUDIT, root);
      const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
      assert.equal(byName.ws.class, 'reachable');
      assert.equal(gateSeverity(byName.ws), 'error');
      assert.equal(byName['@acme/transport'].class, 'workspace');
      assert.match(byName['@acme/transport'].reason, /published from this repository/);
      assert.equal(gateSeverity(byName['@acme/transport']), 'warning');
      assert.equal(r.counts.workspace, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('without workspaces the same package name is still classified by reachability', () => {
    const items = classifyAdvisories(MONO_AUDIT, { manifest: { prod: new Set(['@acme/transport']), dev: new Set() }, imported: new Set(['@acme/transport']) });
    assert.equal(items.find((i) => i.name === '@acme/transport').class, 'reachable');
  });
});

describe('security module — npm audit is reachability-gated (source contract)', () => {
  it('only reachable critical/high advisories fail security:npm-audit; the rest are reported with the reason', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'security.js'), 'utf8');
    assert.match(src, /require\('\.\.\/core\/dependency-reachability'\)\.analyseProject\(audit, projectRoot\)/);
    assert.match(src, /reachableHigh = analysis\.items\.filter\(\(i\) => i\.class === 'reachable'/);
    assert.match(src, /security:npm-audit:\$\{item\.name\}/);
    assert.match(src, /reachability: item\.class/);
  });
});

describe('dependency-reachability — production source is "not a test path" (one definition) AND "shipped"', () => {
  const { collectImportedPackages } = require('../src/core/dependency-reachability');
  it('a package imported only from a test tree the canonical predicate knows (runtime-tests/, conftest.py-style basenames) is not reachable; scripts/ and tool configs are not shipped; src/ is', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dep-reach-paths-'));
    const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    // Before 2026-09-05 this file's private regexes did not know a segment
    // ENDING in a test word, so hono's runtime-tests/ counted as production.
    w('runtime-tests/lambda/mock.ts', "import 'only-in-runtime-tests';\n");
    w('scripts/release.js', "require('only-in-scripts');\n");
    w('vite.config.ts', "import 'only-in-config';\n");
    w('src/app.js', "require('really-imported');\n");
    const imported = collectImportedPackages(root);
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(imported.has('really-imported'), 'POSITIVE CONTROL — src/ is production');
    for (const name of ['only-in-runtime-tests', 'only-in-scripts', 'only-in-config']) {
      assert.ok(!imported.has(name), `${name} must not count as production`);
    }
  });
});

describe('dependency-reachability — production imports come from the one import graph (2026-09-05)', () => {
  const { collectImportedPackages } = require('../src/core/dependency-reachability');
  it('a package named inside a block comment, a string or a template is not an import; a real one, a scoped one and a Vue script block are', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dep-reach-graph-'));
    const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    w('src/real.js', "const a = require('really-used');\nimport b from '@scope/pkg/sub';\n");
    w('src/fake.js', "/* const x = require('only-in-comment'); */\nconst s = \"import y from 'only-in-string'\";\nconst t = `require('only-in-template')`;\nmodule.exports = 1;\n");
    w('src/App.vue', "<template><div/></template>\n<script>\nimport dayjs from 'in-vue-script';\nexport default {};\n</script>\n");
    w('vitest.config.coverage.mts', "import { defineConfig } from 'only-in-variant-config';\nexport default defineConfig({});\n");
    const imported = collectImportedPackages(root);
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(imported.has('really-used') && imported.has('@scope/pkg'), 'POSITIVE CONTROL — real imports, scoped package collapsed to its name');
    assert.ok(imported.has('in-vue-script'), 'a Vue script block still counts (SFC fallback)');
    for (const name of ['only-in-comment', 'only-in-string', 'only-in-template', 'only-in-variant-config']) assert.ok(!imported.has(name), `${name} is not an import`);
  });
});
