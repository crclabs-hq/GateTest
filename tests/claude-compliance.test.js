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

// =============================================================================
// A detector is not data. Self-scan 2026-09-13: all 18 mock-data findings on
// this repo were the DETECTORS — this module's own pattern table (regex
// literals), comments in secrets / security / cookie-security naming
// "changeme", env-placeholder's Set of recognised placeholders, and website
// copy describing what cookieSecurity flags. Each shape below is paired with
// the real placeholder beside it that must still fire.
// =============================================================================
describe('ClaudeComplianceModule — mock data: detectors, comparands and prose are not data', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-detector-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a regex literal or a comment naming the placeholder is a detector (src/modules/claude-compliance.js:76, secrets.js:17)', async () => {
    write(tmp, 'src/detector.js', [
      "const WEAK = [{ re: /[\"'`]changeme[\"'`]/i, label: 'weak' }, { re: /\\bJohn\\s+Doe\\b/ }];",
      "// The password IS a credential word — `password`, `secret`, `changeme`.",
      "/* John Doe is what assistants scaffold */",
      'module.exports = WEAK;',
    ].join('\n'));
    assert.equal(fail(await run(tmp), 'mock-data').length, 0);
  });

  it('a placeholder that is COMPARED or listed in a lookup Set is a guard, not shipped data (src/core/env-placeholder.js:31)', async () => {
    write(tmp, 'src/guard.js', [
      "const EXACT_PLACEHOLDERS = new Set([",
      "  'changeme', 'change_me', 'placeholder',",
      "  'password123',",
      "]);",
      "if (value === 'changeme') throw new Error('set a real secret');",
      "const weak = WEAK.has('password123');",
      "switch (v) { case 'changeme': break; default: }",
      'module.exports = { EXACT_PLACEHOLDERS, weak };',
    ].join('\n'));
    assert.equal(fail(await run(tmp), 'mock-data').length, 0);
  });

  it('a sentence ABOUT a placeholder is prose; the quoted placeholder nested in it is not a literal (website/app/for/countries.ts:361)', async () => {
    write(tmp, 'src/copy.ts', [
      'export const explanation = "cookieSecurity flags httpOnly: false and weak session secrets (\'changeme\', \'keyboard cat\') the PDPC commonly cites.";',
      'export const example = "John Doe placeholder in src/users.ts:42 — mock data shipped to prod, caught by the claudeCompliance module";',
    ].join('\n'));
    assert.equal(fail(await run(tmp), 'mock-data').length, 0);
  });

  it('POSITIVE CONTROL: the placeholder assigned as a value still fires — a short string, a whole literal', async () => {
    write(tmp, 'src/config.ts', [
      "export const SESSION_SECRET = process.env.SESSION_SECRET || 'changeme';",
      'export const demoUser = { name: "John Doe", phone: "555-0100" };',
    ].join('\n'));
    assert.equal(fail(await run(tmp), 'mock-data').length, 2);
  });
});

describe('ClaudeComplianceModule — a directive in a string is not a directive', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-directive-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('13 @ts-ignore and a dozen `: any` inside a template literal of example code count for nothing (website/app/for/typescript/page.tsx)', async () => {
    const example = Array.from({ length: 13 }, (_, n) => `// @ts-ignore\nconst v${n}: any = load(${n});`).join('\n');
    write(tmp, 'src/page.tsx', 'export const bad = `\n' + example + '\n`;\nexport const P = () => <pre>{bad}</pre>;\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'ts-ignore-density').length, 0);
    assert.equal(fail(r, 'any-density').length, 0);
  });

  it('POSITIVE CONTROL: the same directives as real comments still fire', async () => {
    const real = Array.from({ length: 3 }, (_, n) => `// @ts-ignore\nconst v${n} = load(${n});`).join('\n');
    write(tmp, 'src/real.ts', real + '\n');
    assert.equal(fail(await run(tmp), 'ts-ignore-density').length, 1);
  });

  it('the STUB_PATTERNS table (regex literals) is not a stub; a real stub throw beside it is', async () => {
    write(tmp, 'src/stubs.js', [
      "const STUBS = [/throw\\s+new\\s+Error\\s*\\(\\s*[\"'`]\\s*(?:not\\s*implemented|TODO)/i, /\\/\\/\\s*TODO:?\\s*implement\\b/i];",
      "const msg = 'throw new Error(\"not implemented\") is what we catch';",
      'function real() { throw new Error("not implemented"); }',
      'module.exports = { STUBS, msg, real };',
    ].join('\n'));
    assert.equal(fail(await run(tmp), 'stub').length, 1);
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

  // Control pair (self-scan 2026-09-16, src/modules/claude-compliance.js
  // itself: lines 14-16 of its own JSDoc describe these exact patterns in
  // backtick-quoted examples and were flagged as real stubs). A bare
  // directive comment still fires; the identical text quoted as a doc
  // example inside a block comment does not.
  it('POSITIVE CONTROL: a bare stub throw/comment in real code still fires', async () => {
    write(tmp, 'src/api.ts', 'function f() { throw new Error("not implemented"); }\n// TODO: implement\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'stub').length, 2);
  });

  it('does not flag a JSDoc example quoting the stub patterns in backticks', async () => {
    write(tmp, 'src/doc.ts', [
      '/**',
      ' * Detects stubs like `throw new Error("not implemented")` and a',
      ' * bare `// TODO: implement` comment left behind.',
      ' */',
      'function real() { return 1; }',
    ].join('\n') + '\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'stub').length, 0, JSON.stringify(fail(r, 'stub')));
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

describe('ClaudeComplianceModule — abstract-method NotImplementedError is the idiom, not a stub (2026-08-18 audit)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('is silent on an ABC subclass / @abstractmethod / docstring-contract method (Flask base classes)', async () => {
    write(tmp, 'src/base.py', [
      'from abc import ABC, abstractmethod',
      'class Loader(ABC):',
      '    @abstractmethod',
      '    def get_source(self, environment, template):',
      '        raise NotImplementedError',
    ].join('\n') + '\n');
    write(tmp, 'src/sessions.py', [
      'class SessionInterface:',
      '    def open_session(self, app, request):',
      '        """Subclasses must implement this."""',
      '        raise NotImplementedError',
    ].join('\n') + '\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'stub').length, 0, JSON.stringify(fail(r, 'stub')));
  });

  it('POSITIVE CONTROL: a bare NotImplementedError in a concrete function still fires', async () => {
    write(tmp, 'src/api.py', 'def charge(card):\n    raise NotImplementedError\n');
    const r = await run(tmp);
    assert.equal(fail(r, 'stub').length, 1);
  });
});
