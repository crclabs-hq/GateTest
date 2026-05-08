'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const LockfileValidityModule = require('../src/modules/lockfile-validity');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-lv-'));
}

function write(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function mkdir(dir, relPath) {
  fs.mkdirSync(path.join(dir, relPath), { recursive: true });
}

function makeResult() {
  const checks = [];
  return {
    addCheck(id, passed, meta) {
      checks.push({ id, passed, meta: meta || {} });
    },
    checks,
    passed(id) { return checks.find(c => c.id === id)?.passed; },
    ids() { return checks.map(c => c.id); },
    hasFailing(prefix) { return checks.some(c => c.id.startsWith(prefix) && !c.passed); },
    hasPassing(prefix) { return checks.some(c => c.id.startsWith(prefix) && c.passed); },
  };
}

async function run(root) {
  const mod = new LockfileValidityModule();
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

describe('LockfileValidityModule — shape', () => {
  test('has name and description', () => {
    const mod = new LockfileValidityModule();
    assert.equal(mod.name, 'lockfileValidity');
    assert.ok(mod.description.length > 10);
  });

  test('run is a function', () => {
    assert.equal(typeof new LockfileValidityModule().run, 'function');
  });
});

// ---------------------------------------------------------------------------
// npm checks
// ---------------------------------------------------------------------------

describe('LockfileValidityModule — npm', () => {
  let tmp;
  before(() => { tmp = makeTmp(); });
  after(() => cleanup(tmp));

  test('no-op when no package-lock.json', async () => {
    const result = await run(tmp);
    assert.ok(!result.hasFailing('lockfile:npm'));
  });

  test('flags missing package.json when lock exists', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:npm-no-manifest'));
    } finally { cleanup(dir); }
  });

  test('flags lockfileVersion 1 as warning', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package.json', { name: 'test', dependencies: {} });
      write(dir, 'package-lock.json', { lockfileVersion: 1, dependencies: {} });
      const result = await run(dir);
      const check = result.checks.find(c => c.id === 'lockfile:npm-v1');
      assert.ok(check);
      assert.equal(check.passed, false);
      assert.equal(check.meta.severity, 'warning');
    } finally { cleanup(dir); }
  });

  test('passes valid npm v3 lock', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package.json', { name: 'test', dependencies: { lodash: '^4.0.0' } });
      write(dir, 'package-lock.json', { lockfileVersion: 3, packages: {} });
      const result = await run(dir);
      assert.ok(result.hasPassing('lockfile:npm-valid'));
    } finally { cleanup(dir); }
  });

  test('flags missing workspace directory', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package.json', {
        name: 'root',
        workspaces: ['packages/missing-pkg'],
      });
      write(dir, 'package-lock.json', { lockfileVersion: 3, packages: {} });
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:npm-missing-workspace:packages/missing-pkg'));
    } finally { cleanup(dir); }
  });

  test('passes when workspace directory exists', async () => {
    const dir = makeTmp();
    try {
      mkdir(dir, 'packages/my-pkg');
      write(dir, 'package.json', {
        name: 'root',
        workspaces: ['packages/my-pkg'],
      });
      write(dir, 'package-lock.json', { lockfileVersion: 3, packages: {} });
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:npm-missing-workspace'));
    } finally { cleanup(dir); }
  });

  test('skips glob workspace entries', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package.json', {
        name: 'root',
        workspaces: ['packages/*'],
      });
      write(dir, 'package-lock.json', { lockfileVersion: 3, packages: {} });
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:npm-missing-workspace'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// pnpm checks
// ---------------------------------------------------------------------------

describe('LockfileValidityModule — pnpm', () => {
  test('no-op when no pnpm-lock.yaml', async () => {
    const dir = makeTmp();
    try {
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:pnpm'));
    } finally { cleanup(dir); }
  });

  test('passes when pnpm-lock.yaml exists without workspace file', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: \'6.0\'\n');
      const result = await run(dir);
      assert.ok(result.hasPassing('lockfile:pnpm-valid'));
    } finally { cleanup(dir); }
  });

  test('flags missing pnpm workspace directory', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: \'6.0\'\n');
      write(dir, 'pnpm-workspace.yaml', 'packages:\n  - packages/missing\n');
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:pnpm-missing-workspace:packages/missing'));
    } finally { cleanup(dir); }
  });

  test('passes when pnpm workspace dir exists', async () => {
    const dir = makeTmp();
    try {
      mkdir(dir, 'packages/app');
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: \'6.0\'\n');
      write(dir, 'pnpm-workspace.yaml', 'packages:\n  - packages/app\n');
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:pnpm-missing-workspace'));
    } finally { cleanup(dir); }
  });

  test('skips glob pnpm workspace entries', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: \'6.0\'\n');
      write(dir, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:pnpm-missing-workspace'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Bun checks
// ---------------------------------------------------------------------------

describe('LockfileValidityModule — bun', () => {
  test('no-op when no bun lock', async () => {
    const dir = makeTmp();
    try {
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:bun'));
    } finally { cleanup(dir); }
  });

  test('flags missing manifest when bun.lock exists', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'bun.lock', '{ "lockfileVersion": 0 }');
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:bun-no-manifest'));
    } finally { cleanup(dir); }
  });

  test('flags empty bun.lock', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package.json', { name: 'test' });
      write(dir, 'bun.lock', '   ');
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:bun-empty'));
    } finally { cleanup(dir); }
  });

  test('passes valid bun.lock', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package.json', { name: 'test' });
      write(dir, 'bun.lock', '{ "lockfileVersion": 0, "packages": {} }');
      const result = await run(dir);
      assert.ok(result.hasPassing('lockfile:bun-valid'));
    } finally { cleanup(dir); }
  });

  test('flags missing bun workspace directory', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package.json', {
        name: 'root',
        workspaces: ['apps/missing'],
      });
      write(dir, 'bun.lock', '{ "lockfileVersion": 0, "packages": {} }');
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:bun-missing-workspace:apps/missing'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Multiple lockfiles
// ---------------------------------------------------------------------------

describe('LockfileValidityModule — multiple lockfiles', () => {
  test('flags coexisting npm + yarn lockfiles', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package-lock.json', '{}');
      write(dir, 'yarn.lock', '');
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:multiple'));
    } finally { cleanup(dir); }
  });

  test('no flag for single lockfile', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package-lock.json', '{}');
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:multiple'));
    } finally { cleanup(dir); }
  });

  test('flags 3 coexisting lockfiles', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'package-lock.json', '{}');
      write(dir, 'yarn.lock', '');
      write(dir, 'pnpm-lock.yaml', '');
      const result = await run(dir);
      const check = result.checks.find(c => c.id === 'lockfile:multiple');
      assert.ok(check && !check.passed);
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Go checks
// ---------------------------------------------------------------------------

describe('LockfileValidityModule — Go', () => {
  test('no-op when no go.mod', async () => {
    const dir = makeTmp();
    try {
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:go'));
    } finally { cleanup(dir); }
  });

  test('flags missing go.sum when go.mod exists', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n');
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:go-missing-sum'));
    } finally { cleanup(dir); }
  });

  test('flags empty go.sum with required modules', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n\nrequire github.com/pkg/errors v0.9.1\n');
      write(dir, 'go.sum', '');
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:go-empty-sum'));
    } finally { cleanup(dir); }
  });

  test('passes with go.mod and go.sum both present and non-empty', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n\nrequire github.com/pkg/errors v0.9.1\n');
      write(dir, 'go.sum', 'github.com/pkg/errors v0.9.1 h1:abc\ngithub.com/pkg/errors v0.9.1/go.mod h1:def\n');
      const result = await run(dir);
      assert.ok(result.hasPassing('lockfile:go-valid'));
    } finally { cleanup(dir); }
  });
});

// ---------------------------------------------------------------------------
// Cargo checks
// ---------------------------------------------------------------------------

describe('LockfileValidityModule — Cargo', () => {
  test('no-op when no Cargo.toml', async () => {
    const dir = makeTmp();
    try {
      const result = await run(dir);
      assert.ok(!result.hasFailing('lockfile:cargo'));
    } finally { cleanup(dir); }
  });

  test('flags missing Cargo.lock for binary crate', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'Cargo.toml', '[package]\nname = "my-app"\n\n[[bin]]\nname = "my-app"\n');
      const result = await run(dir);
      assert.ok(result.hasFailing('lockfile:cargo-missing-lock'));
    } finally { cleanup(dir); }
  });

  test('passes library crate without Cargo.lock', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'Cargo.toml', '[package]\nname = "my-lib"\n\n[lib]\nname = "my_lib"\n');
      const result = await run(dir);
      assert.ok(result.hasPassing('lockfile:cargo-library'));
    } finally { cleanup(dir); }
  });

  test('passes when Cargo.toml + Cargo.lock both exist', async () => {
    const dir = makeTmp();
    try {
      write(dir, 'Cargo.toml', '[package]\nname = "my-app"\n');
      write(dir, 'Cargo.lock', '# generated\nversion = 3\n');
      const result = await run(dir);
      assert.ok(result.hasPassing('lockfile:cargo-valid'));
    } finally { cleanup(dir); }
  });
});
