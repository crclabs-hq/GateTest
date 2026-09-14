// ============================================================================
// CROSS-FIX SYNTAX GATE TEST — Phase 1.2 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/cross-fix-syntax-gate.js — the gate that sits
// between the per-file iterative fix loop and PR creation. Catches the
// failure mode where Claude returns plausible-looking but syntactically
// invalid content. Without this gate, a broken-brackets fix could ship
// to a customer's PR and break their build.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateFixesSyntax,
  summariseSyntaxGate,
  checkJsSyntax,
  checkJsonSyntax,
  pickChecker,
} = require('../website/app/lib/cross-fix-syntax-gate.js');

// ---------- Single-file checkers ----------

test('checkJsSyntax — accepts valid JavaScript', () => {
  assert.equal(checkJsSyntax('const x = 1; function f() { return x + 2; }').ok, true);
  assert.equal(checkJsSyntax('class Foo { constructor() { this.x = 1; } }').ok, true);
  assert.equal(checkJsSyntax('async function f() { return await Promise.resolve(1); }').ok, true);
});

test('checkJsSyntax — rejects unbalanced braces', () => {
  const result = checkJsSyntax('function f() { return 1;');
  assert.equal(result.ok, false);
  assert.match(result.reason, /syntax error/);
});

test('checkJsSyntax — rejects stray tokens', () => {
  const result = checkJsSyntax('const x = ;;;');
  assert.equal(result.ok, false);
  assert.match(result.reason, /syntax error/);
});

test('checkJsSyntax — rejects empty source', () => {
  assert.equal(checkJsSyntax('').ok, false);
  assert.equal(checkJsSyntax('').reason, 'empty source');
  assert.equal(checkJsSyntax(null).ok, false);
});

test('checkJsSyntax — handles ESM imports/exports without false-rejecting', () => {
  // import / export aren't valid in a function body, so we strip them
  // before validating. The body still has to parse.
  const esm = `import foo from './foo.js';\nimport { bar } from './bar.js';\nexport function f() { return foo + bar; }\nexport default f;`;
  assert.equal(checkJsSyntax(esm).ok, true);
});

test('checkJsSyntax — catches broken syntax even with imports present', () => {
  const broken = `import foo from './foo.js';\nfunction f() { return foo +`;
  assert.equal(checkJsSyntax(broken).ok, false);
});

test('checkJsonSyntax — accepts valid JSON', () => {
  assert.equal(checkJsonSyntax('{"a":1,"b":[2,3]}').ok, true);
  assert.equal(checkJsonSyntax('[1,2,3]').ok, true);
  assert.equal(checkJsonSyntax('"string"').ok, true);
  assert.equal(checkJsonSyntax('null').ok, true);
});

test('checkJsonSyntax — rejects trailing commas', () => {
  const result = checkJsonSyntax('{"a":1,}');
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid JSON/);
});

test('checkJsonSyntax — rejects single quotes', () => {
  const result = checkJsonSyntax("{'a':1}");
  assert.equal(result.ok, false);
});

test('checkJsonSyntax — rejects empty source', () => {
  assert.equal(checkJsonSyntax('').ok, false);
  assert.equal(checkJsonSyntax(null).ok, false);
});

// ---------- Extension dispatch ----------

test('pickChecker — JSON extension routes to JSON checker', () => {
  assert.equal(pickChecker('package.json'), checkJsonSyntax);
  assert.equal(pickChecker('config/foo.json'), checkJsonSyntax);
  assert.equal(pickChecker('PACKAGE.JSON'), checkJsonSyntax);
});

test('pickChecker — JS family routes to JS checker', () => {
  assert.equal(pickChecker('foo.js'), checkJsSyntax);
  assert.equal(pickChecker('bar.mjs'), checkJsSyntax);
  assert.equal(pickChecker('baz.cjs'), checkJsSyntax);
});

// DELIBERATE CONTRACT FLIP (2026-08-25, audit #7): TS-family files used to
// pass through unchecked; the gate now validates them with the typescript
// compiler already shipped in website/package.json.
test('pickChecker — TS family gets a real checker', () => {
  assert.equal(typeof pickChecker('foo.ts'), 'function');
  assert.equal(typeof pickChecker('foo.tsx'), 'function');
  assert.equal(typeof pickChecker('foo.mts'), 'function');
  assert.equal(typeof pickChecker('foo.cts'), 'function');
  assert.equal(typeof pickChecker('foo.jsx'), 'function');
});

test('pickChecker — unknown extensions return null', () => {
  assert.equal(pickChecker('README.md'), null);
  assert.equal(pickChecker('Dockerfile'), null);
  assert.equal(pickChecker('foo.yaml'), null);
});

// ---------- Gate orchestrator ----------

test('validateFixesSyntax — accepts valid fixes, rejects invalid ones', () => {
  const fixes = [
    { file: 'app/server.js',     fixed: 'const x = 1;',          original: '', issues: ['i'] },
    { file: 'config/data.json',  fixed: '{"ok": true}',          original: '', issues: ['i'] },
    { file: 'app/broken.js',     fixed: 'function f() {',        original: '', issues: ['i'] },
    { file: 'config/bad.json',   fixed: '{"a":1,}',              original: '', issues: ['i'] },
    { file: 'app/component.tsx', fixed: 'definitely <not> JSX;', original: '', issues: ['i'] },
  ];
  const result = validateFixesSyntax({ fixes });

  // 2026-08-25 (audit #7): component.tsx is now accepted because it was
  // CHECKED and is genuinely valid syntax — `definitely <not> JSX;` parses
  // as chained less-than comparisons `(definitely < not) > JSX` — not
  // because TS files pass through unchecked (they no longer do; see the
  // checkTsSyntax tests below for a truly broken TSX rejection).
  assert.equal(result.accepted.length, 3, 'js + json + tsx (checked, valid)');
  assert.equal(result.rejected.length, 2, 'broken.js + bad.json');

  const acceptedFiles = result.accepted.map((a) => a.file).sort();
  assert.deepEqual(acceptedFiles, ['app/component.tsx', 'app/server.js', 'config/data.json']);

  const rejectedFiles = result.rejected.map((r) => r.file).sort();
  assert.deepEqual(rejectedFiles, ['app/broken.js', 'config/bad.json']);

  const brokenJs = result.rejected.find((r) => r.file === 'app/broken.js');
  assert.equal(brokenJs.language, 'js');
  assert.match(brokenJs.reason, /syntax error/);

  const badJson = result.rejected.find((r) => r.file === 'config/bad.json');
  assert.equal(badJson.language, 'json');
  assert.match(badJson.reason, /invalid JSON/);

  const tsx = result.accepted.find((a) => a.file === 'app/component.tsx');
  assert.equal(tsx.language, 'tsx'); // was 'unchecked' before the 2026-08-25 TS gate
});

test('validateFixesSyntax — empty fixes array returns empty result', () => {
  const result = validateFixesSyntax({ fixes: [] });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 0);
});

test('validateFixesSyntax — malformed fix entries are rejected, not crashed', () => {
  const result = validateFixesSyntax({
    fixes: [
      null,
      { file: 'good.js', fixed: 'const x = 1;', original: '', issues: ['i'] },
      { file: 'no-fixed.js', original: '', issues: ['i'] },
      { fixed: 'no-file', original: '', issues: ['i'] },
    ],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 3);
  result.rejected.forEach((r) => assert.match(r.reason || '', /malformed fix entry/));
});

test('validateFixesSyntax — checkers can be injected for tests', () => {
  let jsCalls = 0;
  let jsonCalls = 0;
  const result = validateFixesSyntax({
    fixes: [
      { file: 'a.js',   fixed: 'irrelevant', original: '', issues: ['i'] },
      { file: 'b.json', fixed: 'irrelevant', original: '', issues: ['i'] },
    ],
    checkers: {
      js: () => { jsCalls++; return { ok: false, reason: 'forced fail' }; },
      json: () => { jsonCalls++; return { ok: true }; },
    },
  });
  assert.equal(jsCalls, 1);
  assert.equal(jsonCalls, 1);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'forced fail');
});

test('validateFixesSyntax — input validation', () => {
  assert.throws(() => validateFixesSyntax({ fixes: 'not an array' }), /fixes must be an array/);
  assert.throws(() => validateFixesSyntax({}), /fixes must be an array/);
});

// ---------- Summary helper ----------

test('summariseSyntaxGate — empty', () => {
  assert.equal(summariseSyntaxGate(null), 'syntax gate: not run');
  assert.equal(summariseSyntaxGate({ accepted: [], rejected: [] }), 'syntax gate: 0 fixes');
});

test('summariseSyntaxGate — all clean', () => {
  const result = {
    accepted: [
      { file: 'a.js',   language: 'js' },
      { file: 'b.json', language: 'json' },
    ],
    rejected: [],
  };
  assert.equal(summariseSyntaxGate(result), 'syntax gate: 2 fixes validated, all clean');
});

test('summariseSyntaxGate — partial reject', () => {
  const result = {
    accepted: [{ file: 'a.js', language: 'js' }],
    rejected: [{ file: 'b.json', language: 'json', reason: 'invalid JSON' }],
  };
  const summary = summariseSyntaxGate(result);
  assert.match(summary, /1\/2 clean/);
  assert.match(summary, /1 rejected/);
  assert.match(summary, /b\.json/);
});

// ── TS-family syntax checking (2026-08-18 audit #7 — was pass-through) ─────
const { checkTsSyntax } = require('../website/app/lib/cross-fix-syntax-gate');

// The three verdict tests need the real parser, which the gate resolves from
// website/ (`typescript` is a website devDependency; CI runs `cd website &&
// npm ci` before the suite). Without it they cannot check anything and say
// so as a skip with the install command, never as a pass. With it, a verdict
// that comes back `unverified` is failed on the gate's own reason string —
// 2026-09-13 this failed once in CI as a bare `true !== false`.
const TS_PATH = (() => {
  try { return require.resolve('typescript', { paths: [require('path').join(__dirname, '..', 'website', 'app', 'lib')] }); } catch { return null; }
})();
const withCompiler = TS_PATH ? {} : { skip: 'typescript is not installed under website/ — run `cd website && npm ci`; the parser verdicts cannot be checked without it' };
const verified = (r) => assert.equal(r.unverified, undefined, `the compiler resolves at ${TS_PATH} but the gate did not use it: ${r.reason}`);

test('checkTsSyntax — valid TypeScript passes', () => {
  const r = checkTsSyntax('interface A { x: number }\nexport const f = (a: A): number => a.x;\n', 'fix-validation.ts');
  assert.equal(r.ok, true);
});

test('checkTsSyntax — broken TypeScript is rejected', withCompiler, () => {
  const r = checkTsSyntax('export const f = (a: { : number) => a.x;\n', 'fix-validation.ts');
  verified(r);
  assert.equal(r.ok, false);
  assert.match(r.reason, /syntax error/);
});

test('checkTsSyntax — valid TSX passes, broken TSX rejected', withCompiler, () => {
  const good = checkTsSyntax('export const C = () => <div className="a">hi</div>;\n', 'fix-validation.tsx');
  verified(good);
  assert.equal(good.ok, true);
  assert.equal(checkTsSyntax('export const C = () => <div<;\n', 'fix-validation.tsx').ok, false);
});

test('validateFixesSyntax — a .ts fix that does not parse is rejected, language=ts', withCompiler, () => {
  const { accepted, rejected } = validateFixesSyntax({
    fixes: [
      { file: 'src/good.ts', fixed: 'export const a: number = 1;\n', original: '', issues: [] },
      { file: 'src/bad.ts', fixed: 'const x: = ;;;(\n', original: '', issues: [] },
    ],
  });
  for (const a of accepted) verified({ unverified: a.unverified, reason: a.unverifiedReason });
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].language, 'ts');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].language, 'ts');
});

// ─────────────────────────────────────────────────────────────────────────────
// "all clean" has to mean something was actually parsed.
//
// checkTsSyntax returns a pass when `require('typescript')` fails, which is
// the right call — failing closed would break every TS fix on a box that
// simply has no compiler. What was wrong is that the pass was
// indistinguishable from a real one, so summariseSyntaxGate reported
// "2 fixes validated, all clean" over fixes nothing had looked at, and that
// string goes into the PR body a paying customer reads.
//
// typescript is a devDependency of website/, and a production install that
// omits dev dependencies lands exactly here — on the paid fix path.
// ─────────────────────────────────────────────────────────────────────────────
test('an unverified TS fix is accepted but marked, not reported as validated', () => {
  // Simulate the compiler being absent by injecting the shape checkTsSyntax
  // returns in that case.
  const tsUnavailable = () => ({
    ok: true,
    unverified: true,
    reason: 'typescript unavailable — fix not syntax-checked',
  });
  const { accepted, rejected } = validateFixesSyntax({
    fixes: [
      { file: 'src/a.ts', fixed: 'export const a: number = 1;\n', original: '', issues: [] },
      { file: 'src/b.js', fixed: 'const b = 1;\n', original: '', issues: [] },
    ],
    checkers: { ts: tsUnavailable },
  });

  assert.equal(rejected.length, 0, 'an unverifiable fix is still accepted');
  const ts = accepted.find((a) => a.file === 'src/a.ts');
  const js = accepted.find((a) => a.file === 'src/b.js');
  assert.equal(ts.unverified, true, 'the TS fix must carry the unverified marker');
  assert.ok(/typescript unavailable/.test(ts.unverifiedReason));
  assert.equal(js.unverified, undefined, 'the JS fix WAS verified and must not be marked');

  const summary = summariseSyntaxGate({ accepted, rejected });
  assert.ok(
    /NOT syntax-checked/.test(summary),
    `summary must disclose the unverified fix, got: ${summary}`,
  );
  assert.ok(
    !/^syntax gate: 2 fixes validated, all clean$/.test(summary),
    'must not claim both fixes were validated when only one was',
  );
  assert.ok(summary.includes('src/a.ts'), 'name the file that was not checked');
});

test('when nothing could be verified the summary says so outright', () => {
  const tsUnavailable = () => ({ ok: true, unverified: true, reason: 'typescript unavailable' });
  const { accepted, rejected } = validateFixesSyntax({
    fixes: [{ file: 'src/a.ts', fixed: 'export const a = 1;\n', original: '', issues: [] }],
    checkers: { ts: tsUnavailable },
  });
  const summary = summariseSyntaxGate({ accepted, rejected });
  assert.ok(/NONE verified/.test(summary), `got: ${summary}`);
});

test('a real checker still produces the plain all-clean wording', () => {
  // The load-bearing negative control: the honest-reporting change must not
  // make an ordinary, fully-verified run look uncertain.
  const { accepted, rejected } = validateFixesSyntax({
    fixes: [
      { file: 'src/a.js', fixed: 'const a = 1;\n', original: '', issues: [] },
      { file: 'src/b.json', fixed: '{"a":1}', original: '', issues: [] },
    ],
  });
  assert.equal(rejected.length, 0);
  assert.equal(summariseSyntaxGate({ accepted, rejected }), 'syntax gate: 2 fixes validated, all clean');
});
