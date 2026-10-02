// =============================================================================
// SYNTAX — a workspace monorepo is type-checked per package, never from root
// =============================================================================
// Audit 2026-10-02: on Tallrig (bun workspaces, 73 packages) typescript-strict
// reported 1,699 blocking errors — "Cannot find module '~/lib/structured-data'"
// and the like — while the repo's own per-package `tsc --noEmit` (95 tasks)
// was green. The root tsconfig is the shared base every package extends;
// compiled from the root, each package lost its own `paths`. Packages were
// also skipped unless they had their OWN node_modules, which hoisted
// workspaces never do — so the one compile that ran was the wrong one.
// And `npx tsc` with no compiler installed downloads one.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SyntaxModule = require('../src/modules/syntax');

const write = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const tsconfig = (extra) => JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', ...extra } });

function run(root) {
  const mod = new SyntaxModule();
  const calls = [];
  mod._exec = (cmd, opts) => { calls.push({ cmd, cwd: path.relative(root, opts.cwd) || '.' }); return { exitCode: 0, stdout: '', stderr: '' }; };
  const checks = [];
  mod._checkTypeScript(root, { addCheck: (name, passed, d = {}) => checks.push({ name, passed, ...d }) }, { getModuleConfig: () => ({}) });
  return { calls, checks };
}

describe('typescript-strict on workspace monorepos', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tsws-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('Tallrig shape: root base is skipped, each hoisted package is checked with its own tsconfig', () => {
    write(root, 'package.json', JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*', 'packages/*'] }));
    write(root, 'tsconfig.json', tsconfig({ strict: true }));
    write(root, 'node_modules/.keep', '');
    write(root, 'apps/web/tsconfig.json', tsconfig({ jsx: 'preserve', paths: { '~/*': ['./src/*'] } }));
    write(root, 'packages/db/tsconfig.json', tsconfig({}));

    const { calls, checks } = run(root);
    assert.deepStrictEqual(calls.map((c) => c.cwd).sort(), [path.join('apps', 'web'), path.join('packages', 'db')]);
    const note = checks.find((c) => c.name === 'typescript-strict:workspace-root');
    assert.ok(note && note.passed && note.severity === 'info', JSON.stringify(checks));
    assert.deepStrictEqual(checks.find((c) => c.name === 'typescript-strict'), { name: 'typescript-strict', passed: true });
  });

  it('pnpm-workspace.yaml and the {packages:[…]} form count as workspaces too', () => {
    write(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    write(root, 'tsconfig.json', tsconfig({}));
    write(root, 'node_modules/.keep', '');
    write(root, 'packages/a/tsconfig.json', tsconfig({}));
    assert.deepStrictEqual(run(root).calls.map((c) => c.cwd), [path.join('packages', 'a')]);

    fs.rmSync(path.join(root, 'pnpm-workspace.yaml'));
    write(root, 'package.json', JSON.stringify({ workspaces: { packages: ['packages/*'] } }));
    assert.deepStrictEqual(run(root).calls.map((c) => c.cwd), [path.join('packages', 'a')]);
  });

  it('control: a workspace root with NO member tsconfig is still compiled from the root', () => {
    write(root, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    write(root, 'tsconfig.json', tsconfig({}));
    write(root, 'node_modules/.keep', '');
    const { calls, checks } = run(root);
    assert.deepStrictEqual(calls.map((c) => c.cwd), ['.']);
    assert.ok(!checks.some((c) => c.name === 'typescript-strict:workspace-root'));
  });

  it('control: a plain (non-workspace) repo keeps today\'s behaviour — root compiles, uninstalled subpackages are skipped', () => {
    write(root, 'package.json', JSON.stringify({ name: 'plain' }));
    write(root, 'tsconfig.json', tsconfig({}));
    write(root, 'node_modules/.keep', '');
    write(root, 'tools/gen/tsconfig.json', tsconfig({}));
    assert.deepStrictEqual(run(root).calls.map((c) => c.cwd), ['.']);
  });

  it('control: real type errors in a member package still fail the check', () => {
    write(root, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    write(root, 'tsconfig.json', tsconfig({}));
    write(root, 'node_modules/.keep', '');
    write(root, 'packages/a/tsconfig.json', tsconfig({}));
    const mod = new SyntaxModule();
    mod._exec = () => ({ exitCode: 2, stdout: "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n", stderr: '' });
    const checks = [];
    mod._checkTypeScript(root, { addCheck: (name, passed, d = {}) => checks.push({ name, passed, ...d }) }, { getModuleConfig: () => ({}) });
    const c = checks.find((x) => x.name === 'typescript-strict');
    assert.strictEqual(c.passed, false);
    assert.match(c.message, /1 TypeScript error/);
  });

  it('uses the project\'s own compiler (nearest node_modules/.bin/tsc) and never downloads one', () => {
    write(root, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    write(root, 'tsconfig.json', tsconfig({}));
    write(root, 'packages/a/tsconfig.json', tsconfig({}));
    write(root, 'node_modules/.keep', '');
    let { calls } = run(root);
    assert.match(calls[0].cmd, /^npx --no-install tsc --noEmit/);

    const bin = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
    write(root, `node_modules/.bin/${bin}`, '');
    ({ calls } = run(root));
    assert.ok(calls[0].cmd.startsWith(JSON.stringify(path.join(root, 'node_modules', '.bin', bin))), calls[0].cmd);
  });
});
