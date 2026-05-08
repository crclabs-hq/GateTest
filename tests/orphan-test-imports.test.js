'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const OrphanTestImportsModule = require('../src/modules/orphan-test-imports');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-oti-'));
}

function write(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeResult() {
  const checks = [];
  return {
    addCheck(id, passed, meta) {
      checks.push({ id, passed, meta: meta || {} });
    },
    checks,
    hasFailing(pfx) { return checks.some(c => c.id.startsWith(pfx) && !c.passed); },
    hasPassing(pfx) { return checks.some(c => c.id.startsWith(pfx) && c.passed); },
    failingIds()    { return checks.filter(c => !c.passed).map(c => c.id); },
  };
}

async function run(root) {
  const mod = new OrphanTestImportsModule();
  const result = makeResult();
  await mod.run(result, { projectRoot: root });
  return result;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('OrphanTestImportsModule — shape', () => {
  test('has correct name', () => {
    const mod = new OrphanTestImportsModule();
    assert.equal(mod.name, 'orphanTestImports');
  });

  test('has description', () => {
    assert.ok(new OrphanTestImportsModule().description.length > 10);
  });

  test('run is async', () => {
    const result = new OrphanTestImportsModule().run(makeResult(), { projectRoot: os.tmpdir() });
    assert.ok(result instanceof Promise);
    return result;
  });
});

// ---------------------------------------------------------------------------
// No test files — clean exit
// ---------------------------------------------------------------------------

describe('OrphanTestImportsModule — no test files', () => {
  test('no checks emitted when no test files', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/index.js', 'module.exports = { hello: () => "hi" };\n');
      const result = await run(dir);
      assert.equal(result.checks.length, 0);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Missing path (orphan import)
// ---------------------------------------------------------------------------

describe('OrphanTestImportsModule — missing path', () => {
  test('flags ES import from non-existent file', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'tests/foo.test.js',
        "import { foo } from '../src/foo';\n" +
        "test('x', () => {});\n"
      );
      // src/foo.js does NOT exist
      const result = await run(dir);
      assert.ok(result.hasFailing('orphanTest:missing-path'));
    } finally { cleanup(dir); }
  });

  test('flags CJS require from non-existent file', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'tests/bar.test.js',
        "const { bar } = require('../src/bar');\n"
      );
      const result = await run(dir);
      assert.ok(result.hasFailing('orphanTest:missing-path'));
    } finally { cleanup(dir); }
  });

  test('does not flag when import resolves with extension', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/utils.js', 'module.exports = { greet: () => "hi" };\n');
      write(dir, 'tests/utils.test.js',
        "const { greet } = require('../src/utils');\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-path'));
    } finally { cleanup(dir); }
  });

  test('resolves index file in directory', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/helpers/index.js', 'exports.helper = () => 42;\n');
      write(dir, 'tests/helpers.test.js',
        "const { helper } = require('../src/helpers');\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-path'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Missing named export
// ---------------------------------------------------------------------------

describe('OrphanTestImportsModule — missing named export', () => {
  test('flags import of removed named export', async () => {
    const dir = makeTmp();
    try {
      // Source file exports only `hello`, not `world`
      write(dir, 'src/greet.js',
        'exports.hello = () => "hello";\n'
      );
      write(dir, 'tests/greet.test.js',
        "const { hello, world } = require('../src/greet');\n"
      );
      const result = await run(dir);
      assert.ok(result.hasFailing('orphanTest:missing-export'));
    } finally { cleanup(dir); }
  });

  test('does not flag valid named export', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/math.js',
        'exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n'
      );
      write(dir, 'tests/math.test.js',
        "const { add, sub } = require('../src/math');\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-export'));
    } finally { cleanup(dir); }
  });

  test('does not flag ES module named export', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/calc.js',
        'export function multiply(a, b) { return a * b; }\n'
      );
      write(dir, 'tests/calc.test.js',
        "import { multiply } from '../src/calc';\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-export'));
    } finally { cleanup(dir); }
  });

  test('flags import of renamed export', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/service.js',
        'export function processRequest(r) { return r; }\n'
      );
      write(dir, 'tests/service.test.js',
        // Old name before refactor
        "import { handleRequest } from '../src/service';\n"
      );
      const result = await run(dir);
      assert.ok(result.hasFailing('orphanTest:missing-export'));
    } finally { cleanup(dir); }
  });

  test('does not flag wildcard import', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/stuff.js', 'export const a = 1;\n');
      write(dir, 'tests/stuff.test.js',
        "import * as stuff from '../src/stuff';\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-export'));
    } finally { cleanup(dir); }
  });

  test('does not flag default import', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/thing.js', 'module.exports = { run: () => {} };\n');
      write(dir, 'tests/thing.test.js',
        "import thing from '../src/thing';\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-export'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// All-valid pass
// ---------------------------------------------------------------------------

describe('OrphanTestImportsModule — all valid', () => {
  test('emits all-imports-valid when everything resolves', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/api.js', 'exports.fetch = () => Promise.resolve();\n');
      write(dir, 'tests/api.test.js',
        "const { fetch } = require('../src/api');\n"
      );
      const result = await run(dir);
      assert.ok(result.hasPassing('orphanTest:all-imports-valid'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Module.exports = {} shape
// ---------------------------------------------------------------------------

describe('OrphanTestImportsModule — module.exports object', () => {
  test('recognises exports from module.exports = { ... }', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/config.js',
        'module.exports = { port: 3000, host: "localhost" };\n'
      );
      write(dir, 'tests/config.test.js',
        "const { port, host } = require('../src/config');\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-export'));
    } finally { cleanup(dir); }
  });

  test('flags missing key from module.exports = {}', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'src/config2.js',
        'module.exports = { port: 3000 };\n'
      );
      write(dir, 'tests/config2.test.js',
        "const { port, timeout } = require('../src/config2');\n"
      );
      const result = await run(dir);
      assert.ok(result.hasFailing('orphanTest:missing-export'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Excluded directories
// ---------------------------------------------------------------------------

describe('OrphanTestImportsModule — excluded dirs', () => {
  test('ignores files in node_modules', async () => {
    const dir = makeTmp();
    try {
      // This would normally fire, but node_modules is excluded
      write(dir, 'node_modules/some-pkg/tests/foo.test.js',
        "import { missing } from '../src/missing';\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-path'));
    } finally { cleanup(dir); }
  });

  test('ignores files in dist', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'dist/tests/foo.test.js',
        "import { missing } from '../src/missing';\n"
      );
      const result = await run(dir);
      assert.ok(!result.hasFailing('orphanTest:missing-path'));
    } finally { cleanup(dir); }
  });
});
