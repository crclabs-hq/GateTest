// =============================================================================
// src/core/entrypoints.js — the one definition of "run, not imported" (KI #96)
// =============================================================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isEntryPoint, manifestEntrypoints } = require('../src/core/entrypoints');

let root;
const abs = (rel) => path.join(root, rel);
const write = (rel, body) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body); };

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-entrypoints-'));
  write('package.json', JSON.stringify({ name: 'x', main: 'lib/entry.js', bin: { x: './cli/run.js' }, scripts: { gen: 'node tools/generate.js --out y', build: 'tsc -p .' } }));
  write('ext/package.json', JSON.stringify({ name: 'ext', main: './out/extension.js' }));
  write('ext/src/extension.ts', '');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('isEntryPoint — directories are matched by segment, not by prefix', () => {
  it('a nested Next.js pages dir and a nested bin dir count', () => {
    assert.equal(isEntryPoint(abs('website/pages/about.tsx'), root), true);
    assert.equal(isEntryPoint(abs('packages/cli/bin/run.js'), root), true);
    assert.equal(isEntryPoint(abs('tools/scripts/x.js'), root), true);
  });
  it('a component or lib inside a Next.js app dir is NOT an entrypoint — only its route files are', () => {
    assert.equal(isEntryPoint(abs('website/app/components/Lonely.tsx'), root), false);
    assert.equal(isEntryPoint(abs('website/app/lib/cn.ts'), root), false);
    assert.equal(isEntryPoint(abs('website/app/compare/x/page.tsx'), root), true);
    assert.equal(isEntryPoint(abs('website/app/api/scan/route.ts'), root), true);
  });
  it('a substring is not a segment', () => {
    assert.equal(isEntryPoint(abs('src/binary-search.js'), root), false);
    assert.equal(isEntryPoint(abs('src/testing-utils.js'), root), false);
  });
});

describe('isEntryPoint — files loaded by their tooling, hooks, assets, fixtures', () => {
  it('tool configs, Next instrumentation and middleware, type declarations', () => {
    for (const f of ['eslint.config.mjs', 'website/next.config.ts', 'playwright.config.ts', 'website/instrumentation-client.ts', 'website/middleware.ts', 'website/next-env.d.ts']) {
      assert.equal(isEntryPoint(abs(f), root), true, f);
    }
  });
  it('git hooks and browser-served assets', () => {
    assert.equal(isEntryPoint(abs('src/hooks/pre-push.js'), root), true);
    assert.equal(isEntryPoint(abs('plugin/assets/js/admin.js'), root), true);
  });
  it('fixture corpora are inputs, not modules', () => {
    assert.equal(isEntryPoint(abs('reliability-corpus/cases/a.js'), root), true);
    assert.equal(isEntryPoint(abs('benchmarks/target/x.js'), root), true);
    assert.equal(isEntryPoint(abs('src/fixtures/sample.js'), root), true);
    assert.equal(isEntryPoint(abs('src/corpus-reader.js'), root), false);
  });
});

describe('isEntryPoint — Python files a framework loads by name or by settings string (KI #96)', () => {
  it('Django app modules the registry imports, and the files a server or the CLI loads', () => {
    for (const f of ['shop/apps.py', 'shop/models.py', 'shop/admin.py', 'shop/urls.py', 'shop/middleware.py', 'proj/settings.py',
      'proj/wsgi.py', 'proj/asgi.py', 'app.py', 'shop/tasks.py', 'manage.py', 'conftest.py', 'src/pkg/__main__.py']) {
      assert.equal(isEntryPoint(abs(f), root), true, f);
    }
  });
  it('directories Django loads from: templatetags/, backends/, middleware/, management/commands/', () => {
    for (const f of ['shop/templatetags/shop_tags.py', 'django/core/cache/backends/redis.py', 'django/middleware/locale.py',
      'shop/management/commands/rebuild.py']) {
      assert.equal(isEntryPoint(abs(f), root), true, f);
    }
  });
  it('negative: an ordinary module beside them is not, and the Python-only segments do not exempt JS', () => {
    for (const f of ['shop/services.py', 'shop/signals.py', 'shop/views.py', 'shop/management/base.py',
      'src/middleware/auth.js', 'src/backends/redis.ts']) {
      assert.equal(isEntryPoint(abs(f), root), false, f);
    }
  });
});

describe('manifestEntrypoints — what a package.json names is run, not imported', () => {
  it('main, bin and a script argument resolve to absolute paths', () => {
    const refs = manifestEntrypoints([root]);
    assert.ok(refs.has(abs('lib/entry.js')));
    assert.ok(refs.has(abs('cli/run.js')));
    assert.ok(refs.has(abs('tools/generate.js')));
    assert.ok(!refs.has(abs('tsc')));
  });
  it('a compiled main names its source under src/', () => {
    const refs = manifestEntrypoints([abs('ext')]);
    assert.ok(refs.has(abs('ext/out/extension.js')));
    assert.ok(refs.has(abs('ext/src/extension.ts')));
    assert.equal(isEntryPoint(abs('ext/src/extension.ts'), root, refs), true);
    assert.equal(isEntryPoint(abs('ext/src/helper.ts'), root, refs), false);
  });
  it('a directory without a manifest, or with an unparseable one, contributes nothing', () => {
    write('bad/package.json', '{ not json');
    assert.equal(manifestEntrypoints([abs('nowhere'), abs('bad')]).size, 0);
  });
});

describe('entrypoints — angular.json names files package.json never does (2026-09-05)', () => {
  const { manifestEntrypoints } = require('../src/core/entrypoints');
  it('a fileReplacements target, the browser entry, polyfills and global scripts are entrypoints; an unnamed sibling is not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-entrypoints-angular-'));
    const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    w('angular.json', JSON.stringify({ projects: { app: { architect: {
      build: {
        options: { browser: 'src/main.ts', polyfills: ['src/polyfills.ts'], scripts: [{ input: 'src/vendor.js' }], styles: ['src/styles.css'], tsConfig: 'tsconfig.app.json', assets: ['src/assets/**/*'] },
        configurations: { production: { fileReplacements: [{ replace: 'src/environments/environment.ts', with: 'src/environments/environment.prod.ts' }] } },
      },
    } } } }));
    for (const f of ['src/main.ts', 'src/polyfills.ts', 'src/vendor.js', 'src/environments/environment.ts', 'src/environments/environment.prod.ts', 'src/environments/environment.staging.ts']) w(f, 'export const x = 1;\n');
    const refs = manifestEntrypoints([root]);
    fs.rmSync(root, { recursive: true, force: true });
    const has = (rel) => refs.has(path.resolve(root, rel));
    assert.ok(has('src/environments/environment.prod.ts'), 'POSITIVE CONTROL — fileReplacements target');
    assert.ok(has('src/main.ts') && has('src/polyfills.ts') && has('src/vendor.js'), 'browser entry, polyfills, scripts');
    assert.ok(!has('src/environments/environment.staging.ts'), 'NEGATIVE CONTROL — an unnamed sibling is not an entrypoint');
    assert.ok(!has('tsconfig.app.json') && !has('src/styles.css'), 'non-source strings are ignored');
  });
});

describe('isFrameworkExport — names a framework reads by name from a file it loads by convention (2026-09-13)', () => {
  const { isFrameworkExport } = require('../src/core/entrypoints');
  it('POSITIVE CONTROL — Next instrumentation hooks in their own files, route handlers and segment config anywhere', () => {
    assert.equal(isFrameworkExport('website/instrumentation.ts', 'register'), true);
    assert.equal(isFrameworkExport('website/instrumentation.ts', 'onRequestError'), true);
    assert.equal(isFrameworkExport('website/instrumentation-client.ts', 'onRouterTransitionStart'), true);
    assert.equal(isFrameworkExport('website/proxy.ts', 'proxy'), true);
    assert.equal(isFrameworkExport('website/middleware.ts', 'config'), true);
    assert.equal(isFrameworkExport('app/api/x/route.ts', 'GET'), true);
    assert.equal(isFrameworkExport('src/anything.js', 'metadata'), true);
  });
  it('NEGATIVE CONTROL — the same names in an ordinary module are ordinary exports', () => {
    assert.equal(isFrameworkExport('src/lib/hooks.ts', 'register'), false);
    assert.equal(isFrameworkExport('src/lib/errors.ts', 'onRequestError'), false);
    assert.equal(isFrameworkExport('website/instrumentation.ts', 'helper'), false);
    assert.equal(isFrameworkExport('src/net/proxy-client.ts', 'proxy'), false);
  });
  it('proxy.ts (Next 16) is loaded by name like middleware.ts', () => {
    assert.equal(isEntryPoint(abs('website/proxy.ts'), root), true);
    assert.equal(isEntryPoint(abs('src/net/proxy.js'), root), true);
    assert.equal(isEntryPoint(abs('src/net/proxy-client.js'), root), false);
  });
});
