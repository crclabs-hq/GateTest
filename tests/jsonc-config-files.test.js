// =============================================================================
// SYNTAX — JSONC config files are not JSON syntax errors
// =============================================================================
// Measured 2026-09-01 scanning axios @81df7a5: the syntax module emitted a
// BLOCKING "JSON syntax error" on `.devcontainer/devcontainer.json`, whose
// only irregularity was a trailing comma — which is legal in that format.
// devcontainer.json, tsconfig.json, jsconfig.json and everything under
// .vscode/ are JSONC by specification; the tools that own them parse comments
// and trailing commas without complaint.
//
// Any repo with a devcontainer or a commented tsconfig hit this, which is a
// large share of modern TypeScript projects, and it failed their build on a
// file that was correct.
//
// The knowledge already existed 200 lines away in the same module ("tsconfig
// is JSONC") and had not been applied to the check that needed it.
//
// The load-bearing half of these tests is the second and third groups: an
// ordinary data JSON with a trailing comma must STILL fail, and a tsconfig
// that is broken beyond legal JSONC must STILL fail. Otherwise this is not a
// fix, it is a way of never reporting bad JSON again.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { stripJsonc, isJsoncPath } = require('../src/core/jsonc');

describe('jsonc — recognising the formats that permit it', () => {
  const JSONC = [
    'tsconfig.json',
    'tsconfig.build.json',
    'jsconfig.json',
    '.devcontainer/devcontainer.json',
    'devcontainer.json',
    '.vscode/settings.json',
    '.vscode/launch.json',
    'packages/api/tsconfig.json',
  ];
  for (const p of JSONC) {
    it(`treats ${p} as JSONC`, () => assert.strictEqual(isJsoncPath(p), true));
  }

  const STRICT = [
    'package.json',
    'data/config.json',
    'src/fixtures/users.json',
    'composer.json',
    // Not a tsconfig — a file that merely mentions one.
    'docs/tsconfig-guide.json',
  ];
  for (const p of STRICT) {
    it(`treats ${p} as strict JSON`, () => assert.strictEqual(isJsoncPath(p), false));
  }
});

describe('jsonc — stripping is string-aware', () => {
  const parse = (t) => JSON.parse(stripJsonc(t));

  it('accepts a trailing comma in an object', () => {
    assert.deepStrictEqual(parse('{"a": 1,}'), { a: 1 });
  });

  it('accepts a trailing comma in an array', () => {
    assert.deepStrictEqual(parse('{"a": [1, 2,]}'), { a: [1, 2] });
  });

  it('accepts line and block comments', () => {
    assert.deepStrictEqual(
      parse('{\n // one\n "a": 1, /* two */\n "b": 2\n}'),
      { a: 1, b: 2 },
    );
  });

  it('does NOT eat // inside a string value', () => {
    // The regex version of this fix corrupts the URL and the file stops
    // parsing — turning a false positive into a different false positive.
    assert.deepStrictEqual(
      parse('{"url": "https://example.com/x"}'),
      { url: 'https://example.com/x' },
    );
  });

  it('does NOT strip a comma that only looks trailing inside a string', () => {
    assert.deepStrictEqual(parse('{"a": "x,}", "b": 1}'), { a: 'x,}', b: 1 });
  });

  it('does not corrupt an escaped quote before a comma', () => {
    assert.deepStrictEqual(parse('{"a": "he said \\"hi\\",", "b": 1}'), { a: 'he said "hi",', b: 1 });
  });

  it('reproduces the axios devcontainer shape exactly', () => {
    const src = [
      '{',
      '  "name": "axios",',
      '  "features": {',
      '    "ghcr.io/devcontainers/features/github-cli:1": {},',
      '  },',
      '  "postCreateCommand": "npm ci --ignore-scripts"',
      '}',
    ].join('\n');
    const parsed = parse(src);
    assert.strictEqual(parsed.name, 'axios');
    assert.deepStrictEqual(parsed.features['ghcr.io/devcontainers/features/github-cli:1'], {});
  });
});

describe('jsonc — genuinely broken input is still broken', () => {
  // Not a JSON5 parser. These must not start passing.
  const BROKEN = [
    ['unquoted key', '{a: 1}'],
    ['single-quoted string', "{'a': 1}"],
    ['missing closing brace', '{"a": 1'],
    ['missing comma between members', '{"a": 1 "b": 2}'],
    ['bare word value', '{"a": oops}'],
  ];

  for (const [why, src] of BROKEN) {
    it(`still rejects: ${why}`, () => {
      assert.throws(() => JSON.parse(stripJsonc(src)));
    });
  }
});

// =============================================================================
// END TO END — through the syntax MODULE, not the helper.
// =============================================================================
// The helper tests above all passed on 2026-09-01 while the module's JSONC
// retry was dead code: `content` was declared inside the `try`, the retry in
// the `catch` threw ReferenceError, and its own bare `catch {}` swallowed that.
// A commented tsconfig blocked the gate for every customer until 2026-09-02.
// A test of the helper cannot see that; only a test of the module can.
// =============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const SyntaxModule = require('../src/modules/syntax');

function jsonCheck(rel, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-jsonc-e2e-'));
  try {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    const r = { checks: [], addCheck(name, passed, meta) { this.checks.push({ name, passed, ...(meta || {}) }); }, addInfo() {} };
    new SyntaxModule()._checkJsonSyntax(full, r, root);
    return r.checks[0];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('jsonc — the syntax module itself accepts JSONC config files', () => {
  it('a tsconfig with comments and a trailing comma PASSES through the module', () => {
    const c = jsonCheck('tsconfig.json', '{\n  // strict on purpose\n  "compilerOptions": { "strict": true, },\n}\n');
    assert.strictEqual(c.passed, true, `module reported: ${c.message}`);
  });

  it('a .devcontainer/devcontainer.json with a trailing comma PASSES (the axios case)', () => {
    const c = jsonCheck('.devcontainer/devcontainer.json', '{\n  "name": "dev",\n  "features": {},\n}\n');
    assert.strictEqual(c.passed, true, `module reported: ${c.message}`);
  });

  it('NEGATIVE CONTROL: a tsconfig that is malformed even as JSONC still FAILS', () => {
    const c = jsonCheck('tsconfig.json', '{ "compilerOptions": { strict: true } }\n');
    assert.strictEqual(c.passed, false, 'unquoted keys are not JSONC');
  });

  it('NEGATIVE CONTROL: a trailing comma in an ordinary data file still FAILS', () => {
    const c = jsonCheck('data/config.json', '{ "a": 1, }\n');
    assert.strictEqual(c.passed, false, 'plain JSON is not JSONC');
  });
});
