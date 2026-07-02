const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ClaudeComplianceModule = require('../src/modules/claude-compliance');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new ClaudeComplianceModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function fail(r, rule) {
  return r.checks.filter((c) => c.passed === false && c.rule === rule);
}

describe('ClaudeComplianceModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when there is nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'claude-compliance:no-files'));
  });

  it('emits summary when files exist', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'claude-compliance:summary'));
  });
});

describe('ClaudeComplianceModule — mock data', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-mock-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags John Doe placeholder in prod source', async () => {
    write(tmp, 'src/users.ts', 'export const u = { name: "John Doe" };\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 1);
  });

  it('flags jane@example email', async () => {
    write(tmp, 'src/users.ts', 'const e = "jane@example.com";\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 1);
  });

  it('flags Lorem ipsum filler', async () => {
    write(tmp, 'src/page.tsx', '<p>Lorem ipsum dolor sit amet</p>\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 1);
  });

  it('flags 555 placeholder phone', async () => {
    write(tmp, 'src/contact.ts', 'const p = "555-0123";\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 1);
  });

  it('flags 123 Main St placeholder', async () => {
    write(tmp, 'src/address.ts', 'const a = "123 Main Street";\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 1);
  });

  it('flags password123 placeholder secret', async () => {
    write(tmp, 'src/auth.ts', 'const p = "password123";\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 1);
  });

  it('flags Stripe test-card 4242 in prod path', async () => {
    write(tmp, 'src/checkout.ts', 'const c = "4242 4242 4242 4242";\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 1);
  });

  it('does NOT flag mock data in test paths', async () => {
    write(tmp, 'tests/users.test.ts', 'const u = "John Doe";\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 0);
  });

  it('does NOT flag mock data in mock-named files', async () => {
    write(tmp, 'src/mockUsers.ts', 'const u = "John Doe";\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 0);
  });

  it('respects // claude-ok suppression', async () => {
    write(tmp, 'src/users.ts', 'const u = "John Doe"; // claude-ok\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'mock-data').length, 0);
  });
});

describe('ClaudeComplianceModule — not-implemented stubs', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-stub-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags throw new Error("not implemented")', async () => {
    write(tmp, 'src/api.ts', 'function f() { throw new Error("not implemented"); }\n');
    const r = await run(tmp);
    const hits = fail(r, 'stub');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
  });

  it('flags throw new Error("TODO")', async () => {
    write(tmp, 'src/api.ts', 'function f() { throw new Error("TODO"); }\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'stub').length, 1);
  });

  it('flags Python NotImplementedError', async () => {
    write(tmp, 'src/api.py', 'def f():\n    raise NotImplementedError\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'stub').length, 1);
  });

  it('flags // TODO: implement', async () => {
    write(tmp, 'src/api.ts', 'function f() {\n  // TODO: implement\n}\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'stub').length, 1);
  });

  it('downgrades stub severity to info in test paths', async () => {
    write(tmp, 'tests/foo.test.ts', 'it.skip("x", () => { throw new Error("not implemented"); });\n');
    const r = await run(tmp);
    const hits = fail(r, 'stub');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'info');
  });
});

describe('ClaudeComplianceModule — WHAT-not-WHY comment noise', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-noise-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags a file with dense AI-shaped comments', async () => {
    const body = [
      '// Loop through items',
      'for (const i of items) {',
      '  // Check if user exists',
      '  if (i.user) {',
      '    // Initialize the counter',
      '    let c = 0;',
      '    // Create a new array',
      '    const arr = [];',
      '  }',
      '}',
    ].join('\n');
    write(tmp, 'src/a.ts', body);
    const r = await run(tmp);
    assert.equal(fail(r, 'comment-noise').length, 1);
  });

  it('does NOT flag a single benign comment', async () => {
    write(tmp, 'src/a.ts', '// Loop through items\nconst x = 1;\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'comment-noise').length, 0);
  });
});

describe('ClaudeComplianceModule — TS any density', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-any-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags > 5 any per 100 lines', async () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`const v${i}: any = ${i} as any;`);
    }
    write(tmp, 'src/a.ts', lines.join('\n'));
    const r = await run(tmp);
    assert.equal(fail(r, 'any-density').length, 1);
  });

  it('does NOT flag low any density', async () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`const v${i} = ${i};`);
    }
    lines.push('const x: any = 1;');
    write(tmp, 'src/a.ts', lines.join('\n'));
    const r = await run(tmp);
    assert.equal(fail(r, 'any-density').length, 0);
  });

  it('does NOT scan plain JS for any density', async () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`const v${i} = ${i};`);
    }
    write(tmp, 'src/a.js', lines.join('\n'));
    const r = await run(tmp);
    assert.equal(fail(r, 'any-density').length, 0);
  });
});

describe('ClaudeComplianceModule — @ts-ignore density', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-ign-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags >= 3 @ts-ignore in one file', async () => {
    const body = [
      '// @ts-ignore',
      'const a = 1;',
      '// @ts-ignore',
      'const b = 2;',
      '// @ts-expect-error',
      'const c = 3;',
    ].join('\n');
    write(tmp, 'src/a.ts', body);
    const r = await run(tmp);
    assert.equal(fail(r, 'ts-ignore-density').length, 1);
  });

  it('does NOT flag a single @ts-ignore', async () => {
    write(tmp, 'src/a.ts', '// @ts-ignore\nconst a = 1;\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'ts-ignore-density').length, 0);
  });
});
