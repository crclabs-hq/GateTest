// =============================================================================
// src/core/python-imports.js — the one definition of what a Python specifier
// resolves to (KI #96, Python). Every shape carries a control pair (Doctrine
// §3): the line from the corpus that fired it, and the idiom beside it that
// must stay quiet. Shapes are named after the file they came from.
// =============================================================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolvePythonImport, pythonEdges, pythonImporters } = require('../src/core/python-imports');
const { repoRelative } = require('../src/core/repo-path');

let root;
const abs = (rel) => path.join(root, rel);
const write = (rel, body = '') => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body); };
let fileSet;
const edges = (rel, content) => pythonEdges(abs(rel), content, root, fileSet).map((e) => [repoRelative(root, e.to), e.kind]);

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pyimports-'));
  // flask's src layout: src/flask/{__init__,app,config,helpers}.py, src/flask/sansio/app.py
  for (const f of ['src/flask/__init__.py', 'src/flask/app.py', 'src/flask/config.py', 'src/flask/helpers.py',
    'src/flask/sansio/__init__.py', 'src/flask/sansio/app.py', 'src/flask/json/__init__.py', 'src/flask/json/provider.py']) write(f);
  // django's package-at-root layout with a dotted-string-loaded app config
  for (const f of ['django/__init__.py', 'django/contrib/__init__.py', 'django/contrib/admin/__init__.py',
    'django/contrib/admin/apps.py', 'django/contrib/admin/sites.py', 'django/conf/__init__.py', 'django/conf/settings.py']) write(f);
  // a PEP 420 script directory (no __init__.py) beside a sibling module
  write('tools/run.py'); write('tools/helpers.py');
  fileSet = new Set(fs.readdirSync(root, { recursive: true }).map((r) => abs(String(r))).filter((f) => f.endsWith('.py')));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('relative imports — src/flask/app.py: `from .config import Config`', () => {
  it('positive: one dot is the importer\'s own package; the NAME that is a sibling module is the edge', () => {
    assert.equal(resolvePythonImport(abs('src/flask/app.py'), '.config', root, fileSet), abs('src/flask/config.py'));
    // `.config` IS the module: the statement names config.py, not the package.
    assert.deepEqual(edges('src/flask/app.py', 'from .config import Config\n'), [['src/flask/config.py', 'static']]);
  });
  it('positive: two dots climb one package — sansio/app.py: `from ..config import Config`', () => {
    assert.equal(resolvePythonImport(abs('src/flask/sansio/app.py'), '..config', root, fileSet), abs('src/flask/config.py'));
  });
  it('positive: `from . import helpers` (flask/__init__.py) is an edge to helpers.py, not only the package', () => {
    assert.deepEqual(edges('src/flask/__init__.py', 'from . import helpers\n'), [['src/flask/helpers.py', 'static']]);
  });
  it('positive: `from .sansio.app import App` — a dotted relative path', () => {
    assert.deepEqual(edges('src/flask/app.py', 'from .sansio.app import App\n'), [['src/flask/sansio/app.py', 'static']]);
  });
  it('negative: a relative import of a module that does not exist is not an edge', () => {
    assert.equal(resolvePythonImport(abs('src/flask/app.py'), '.nonesuch', root, fileSet), null);
    assert.deepEqual(edges('src/flask/app.py', 'from .nonesuch import x\n'), []);
  });
  it('negative: `from . import Flask` where Flask is a symbol, not a sibling file, yields only the package', () => {
    assert.deepEqual(edges('src/flask/app.py', 'from . import Flask\n'), [['src/flask/__init__.py', 'static']]);
  });
});

describe('absolute imports — the roots an interpreter sees', () => {
  it('positive: src layout — tests/test_x.py: `from flask.helpers import x` resolves through src/', () => {
    write('tests/test_helpers.py');
    fileSet.add(abs('tests/test_helpers.py'));
    assert.equal(resolvePythonImport(abs('tests/test_helpers.py'), 'flask.helpers', root, fileSet), abs('src/flask/helpers.py'));
  });
  it('positive: `import django.contrib.admin` resolves the package to its __init__.py', () => {
    assert.deepEqual(edges('django/conf/settings.py', 'import django.contrib.admin\n'), [['django/contrib/admin/__init__.py', 'static']]);
  });
  it('positive: `import pkg.sub.mod` — the leaf module file', () => {
    assert.deepEqual(edges('django/conf/settings.py', 'import django.contrib.admin.sites as s, os\n'), [['django/contrib/admin/sites.py', 'static']]);
  });
  it('positive: `from pkg import mod` where mod is pkg/mod.py', () => {
    assert.deepEqual(edges('django/conf/settings.py', 'from django.contrib.admin import sites, apps\n'),
      [['django/contrib/admin/__init__.py', 'static'], ['django/contrib/admin/sites.py', 'static'], ['django/contrib/admin/apps.py', 'static']]);
  });
  it('positive: the parent of the importer\'s top-level package is a root (package sits under src/)', () => {
    assert.equal(resolvePythonImport(abs('src/flask/sansio/app.py'), 'flask.config', root, fileSet), abs('src/flask/config.py'));
  });
  it('positive: a script directory without __init__.py is its own root (tools/run.py: `import helpers`)', () => {
    assert.equal(resolvePythonImport(abs('tools/run.py'), 'helpers', root, fileSet), abs('tools/helpers.py'));
  });
  it('negative: the stdlib is external — `import os.path`, `from os import path`, `import logging`', () => {
    assert.equal(resolvePythonImport(abs('src/flask/app.py'), 'os.path', root, fileSet), null);
    assert.deepEqual(edges('src/flask/app.py', 'import os.path\nfrom os import path\nimport logging, sys\n'), []);
  });
  it('negative: a package that exists but a leaf that does not — `import django.contrib.nonesuch`', () => {
    assert.deepEqual(edges('django/conf/settings.py', 'import django.contrib.nonesuch\n'), []);
  });
  it('an indented import (function-scoped, try-block) is a lazy edge — still a reader', () => {
    assert.deepEqual(edges('src/flask/app.py', 'def f():\n    from .helpers import x\n'), [['src/flask/helpers.py', 'lazy']]);
  });
  it('multi-line parenthesised import lists and backslash continuations are one statement', () => {
    assert.deepEqual(edges('src/flask/app.py', 'from . import (\n    config,  # comment\n    helpers,\n)\nfrom .json import \\\n    provider\n'),
      [['src/flask/__init__.py', 'static'], ['src/flask/config.py', 'static'], ['src/flask/helpers.py', 'static'],
        ['src/flask/json/__init__.py', 'static'], ['src/flask/json/provider.py', 'static']]);
  });
});

describe('dotted string literals — INSTALLED_APPS / AUTH_USER_MODEL / default_app_config', () => {
  it('positive: "django.contrib.admin.apps.AdminConfig" drops the class and lands on apps.py', () => {
    assert.deepEqual(edges('django/conf/settings.py', "INSTALLED_APPS = ['django.contrib.admin.apps.AdminConfig']\n"),
      [['django/contrib/admin/apps.py', 'path-literal']]);
  });
  it('positive: a bare app label string resolves to the package', () => {
    assert.deepEqual(edges('django/conf/settings.py', 'x = "django.contrib.admin"\n'), [['django/contrib/admin/__init__.py', 'path-literal']]);
  });
  it('positive: a format placeholder may close the chain — gis/sitemaps/kml.py: "django.contrib.gis.sitemaps.views.%s"', () => {
    assert.deepEqual(edges('django/conf/settings.py', 'reverse("django.contrib.admin.sites.%s" % fmt)\n'), [['django/contrib/admin/sites.py', 'path-literal']]);
  });
  it('negative: a dotted string that resolves to nothing is NOT an edge (stdlib, prose, versions, attribute chains)', () => {
    const quiet = [
      'x = "os.path"',
      "v = '1.2.3'",
      'msg = "e.g."',
      'msg = "Hello. World"',
      "handler = 'logging.StreamHandler'",
      "attr = 'self.request.user'",
      'url = "example.com"',
    ].join('\n');
    assert.deepEqual(edges('django/conf/settings.py', quiet), []);
  });
  it('negative: mismatched quotes are not a literal', () => {
    assert.deepEqual(edges('django/conf/settings.py', 'x = "django.contrib.admin\'\n'), []);
  });
  it('a file never depends on itself', () => {
    assert.deepEqual(edges('django/contrib/admin/apps.py', 'name = "django.contrib.admin.apps"\n'), []);
  });
});

describe('pythonImporters — the reverse graph over the scan', () => {
  it('lists every file, and the production reader of a module imported via `from .x import y`', () => {
    write('src/flask/app.py', 'from .config import Config\nfrom .helpers import url_for\n');
    write('src/flask/__init__.py', 'from .app import Flask as Flask\n');
    const rev = pythonImporters([...fileSet], root);
    assert.deepEqual(rev.get(abs('src/flask/config.py')), [abs('src/flask/app.py')]);
    assert.deepEqual(rev.get(abs('src/flask/app.py')), [abs('src/flask/__init__.py')]);
    assert.deepEqual(rev.get(abs('src/flask/sansio/app.py')), []);
    assert.equal(rev.size, fileSet.size);
  });
});
