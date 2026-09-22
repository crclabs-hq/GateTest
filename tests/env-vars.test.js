const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EnvVarsModule = require('../src/modules/env-vars');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new EnvVarsModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('EnvVarsModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'env-vars:no-env'));
  });

  it('scans when source or .env.example present', async () => {
    write(tmp, '.env.example', 'API_KEY=\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'env-vars:scanning'));
  });
});

describe('EnvVarsModule — missing-from-example', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-miss-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on process.env.X without .env.example declaration', async () => {
    write(tmp, 'src/a.ts', [
      'export function run() {',
      '  return process.env.STRIPE_SECRET_KEY;',
      '}',
      '',
    ].join('\n'));
    write(tmp, '.env.example', 'PUBLIC_URL=\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name === 'env-vars:missing-from-example:STRIPE_SECRET_KEY');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on process.env["X"] bracket form', async () => {
    write(tmp, 'src/a.ts', 'const k = process.env["SENDGRID_API_KEY"];\n');
    write(tmp, '.env.example', '\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'env-vars:missing-from-example:SENDGRID_API_KEY'));
  });

  it('does NOT flag runtime-allowlist keys (NODE_ENV, PORT, CI)', async () => {
    write(tmp, 'src/a.ts', [
      'const env = process.env.NODE_ENV;',
      'const port = process.env.PORT;',
      'const ci = process.env.CI;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter(
      (c) => c.passed === false && c.name.startsWith('env-vars:missing-from-example:'),
    );
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT flag when declared in .env.example', async () => {
    write(tmp, 'src/a.ts', 'const k = process.env.STRIPE_SECRET_KEY;\n');
    write(tmp, '.env.example', 'STRIPE_SECRET_KEY=\n');
    const r = await run(tmp);
    const leaks = r.checks.filter(
      (c) => c.passed === false && c.name === 'env-vars:missing-from-example:STRIPE_SECRET_KEY',
    );
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT flag when declared in GitHub Actions workflow env block', async () => {
    write(tmp, 'src/a.ts', 'const k = process.env.DEPLOY_TOKEN;\n');
    write(tmp, '.github/workflows/ci.yml', [
      'name: ci',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    env:',
      '      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}',
      '    steps:',
      '      - run: echo ok',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter(
      (c) => c.passed === false && c.name === 'env-vars:missing-from-example:DEPLOY_TOKEN',
    );
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT flag when declared in vercel.json env', async () => {
    write(tmp, 'src/a.ts', 'const k = process.env.DATABASE_URL;\n');
    write(tmp, 'vercel.json', JSON.stringify({ env: { DATABASE_URL: '@database-url' } }));
    const r = await run(tmp);
    const leaks = r.checks.filter(
      (c) => c.passed === false && c.name === 'env-vars:missing-from-example:DATABASE_URL',
    );
    assert.strictEqual(leaks.length, 0);
  });
});

describe('EnvVarsModule — unused-in-code', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-unused-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on .env.example key not referenced in source', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    write(tmp, '.env.example', [
      'USED_KEY=',
      'DEAD_FEATURE_FLAG=',
      '',
    ].join('\n'));
    write(tmp, 'src/b.ts', 'const k = process.env.USED_KEY;\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name === 'env-vars:unused-in-code:DEAD_FEATURE_FLAG');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does NOT warn on runtime-allowlist declared keys', async () => {
    write(tmp, '.env.example', 'NODE_ENV=\nPORT=\n');
    const r = await run(tmp);
    const leaks = r.checks.filter(
      (c) => c.passed === false && c.name.startsWith('env-vars:unused-in-code:'),
    );
    assert.strictEqual(leaks.length, 0);
  });
});

describe('EnvVarsModule — client-exposed info', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-pub-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records info for NEXT_PUBLIC_* keys', async () => {
    write(tmp, 'src/a.ts', 'const k = process.env.NEXT_PUBLIC_STRIPE_KEY;\n');
    write(tmp, '.env.example', 'NEXT_PUBLIC_STRIPE_KEY=\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name === 'env-vars:client-exposed:NEXT_PUBLIC_STRIPE_KEY');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });

  it('records info for VITE_* keys', async () => {
    write(tmp, 'src/a.ts', 'const k = process.env.VITE_API_URL;\n');
    write(tmp, '.env.example', 'VITE_API_URL=\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'env-vars:client-exposed:VITE_API_URL'));
  });
});

describe('EnvVarsModule — multi-language', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-lang-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('finds Python os.environ / os.getenv references', async () => {
    write(tmp, 'app.py', [
      'import os',
      'db = os.environ["DATABASE_URL"]',
      'key = os.getenv("SECRET_TOKEN")',
      '',
    ].join('\n'));
    write(tmp, '.env.example', 'DATABASE_URL=\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'env-vars:missing-from-example:SECRET_TOKEN'));
  });

  it('finds Go os.Getenv references', async () => {
    write(tmp, 'main.go', [
      'package main',
      'import "os"',
      'func main() {',
      '  _ = os.Getenv("REDIS_URL")',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'env-vars:missing-from-example:REDIS_URL'));
  });
});

describe('EnvVarsModule — summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-sum-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records a summary', async () => {
    write(tmp, '.env.example', 'FOO=\n');
    write(tmp, 'src/a.ts', 'const k = process.env.FOO;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'env-vars:summary');
    assert.ok(s);
    assert.match(s.message, /declared=\d+/);
  });
});

// ── the one stripper (2026-09-05, Doctrine §4): the private per-line quote
// counter this module carried could not see a template continuation line or a
// block comment that opened earlier, and read comment text as code ──
describe('EnvVarsModule — reads are matched on the masked line', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-strip-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a process.env read inside a string, a template or a comment is not a read; the real ones beside them are — dot and bracket form (2026-09-05)', async () => {
    write(tmp, 'src/a.ts', [
      'const advice = "set process.env.QUOTED_KEY before boot";', // 1 string
      'const tpl = `',                                             // 2
      '  export DEFAULT=${process.env.HOLE_KEY} # process.env.TEMPLATE_KEY', // 3: the hole is code, the rest is template text
      '`;',                                                        // 4
      '/* migration notes:',                                       // 5
      '   we used to read process.env.COMMENT_KEY here',           // 6 block comment
      ' */',                                                       // 7
      'const real = process.env.REAL_KEY;',                        // 8 real, dot form
      'const bracket = process.env["BRACKET_KEY"];',               // 9 real, bracket form — the key is string content
    ].join('\n'));
    write(tmp, '.env.example', '\n');
    const r = await run(tmp);
    const missing = r.checks
      .filter((c) => c.passed === false && c.name.startsWith('env-vars:missing-from-example:'))
      .map((c) => `${c.name}@${c.line}`)
      .sort();
    assert.deepStrictEqual(missing, [
      'env-vars:missing-from-example:BRACKET_KEY@9',
      'env-vars:missing-from-example:HOLE_KEY@3',
      'env-vars:missing-from-example:REAL_KEY@8',
    ]);
  });
});

describe('EnvVarsModule — a key set in a child process env block is a use of the key (2026-09-05)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-child-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('CHILD_KEY passed to spawn is referenced; PLAIN_KEY in an ordinary object and NEVER_KEY are unused', async () => {
    write(tmp, 'src/a.js', [
      'const labels = { PLAIN_KEY: "x" };',
      'spawn(process.execPath, [worker], {',
      '  env: {',
      '    ...process.env,',
      '    CHILD_KEY: JSON.stringify(task),',
      '    QUOTED_KEY: "not a key: OTHER_KEY: 1",',
      '    NODE_OPTIONS: "",',
      '  },',
      '});',
      'const after = { LATE_KEY: 1 };',
      '',
    ].join('\n'));
    write(tmp, '.env.example', 'CHILD_KEY=\nQUOTED_KEY=\nOTHER_KEY=\nPLAIN_KEY=\nLATE_KEY=\nNEVER_KEY=\n');
    const r = await run(tmp);
    const unused = r.checks
      .filter((c) => c.passed === false && c.name.startsWith('env-vars:unused-in-code:'))
      .map((c) => c.name.replace('env-vars:unused-in-code:', ''))
      .sort();
    assert.deepStrictEqual(unused, ['LATE_KEY', 'NEVER_KEY', 'OTHER_KEY', 'PLAIN_KEY']);
  });

  it('a key only SET for a child is not missing from .env.example; a key READ beside it is (2026-09-05)', async () => {
    write(tmp, 'src/a.js', [
      'const worker = process.env.WORKER_PATH;',
      'spawn(process.execPath, [worker], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });',
      '',
    ].join('\n'));
    write(tmp, '.env.example', 'OTHER=\n');
    const r = await run(tmp);
    const missing = r.checks
      .filter((c) => c.passed === false && c.name.startsWith('env-vars:missing-from-example:'))
      .map((c) => c.name.replace('env-vars:missing-from-example:', ''));
    assert.deepStrictEqual(missing, ['WORKER_PATH']);
  });
});

// 2026-09-13: the self-scan reported 36 `.env.example` keys as dead
// configuration. 11 were read through an injected `env` (platform-config.js
// `platformServicePrefix(env = process.env)`, report-provenance.js `const env
// = opts.env || process.env`, events-push.js `processPushEvent({ env, … })`),
// 7 through a key built at runtime (`env[`${prefix}${name}`]`), 18 were
// declared only by a workflow `env:` block or a compose `${X}` and consumed by
// that workflow's own shell, and one (`VAR`) came from a compose COMMENT.
describe('EnvVarsModule — reads through an injected `env` binding (2026-09-13)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-alias-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const unusedOf = (r) => r.checks.filter((c) => c.passed === false && c.name.startsWith('env-vars:unused-in-code:')).map((c) => c.key).sort();
  const missingOf = (r) => r.checks.filter((c) => c.passed === false && c.name.startsWith('env-vars:missing-from-example:'));

  it('POSITIVE CONTROL — a parameter default, an `opts.env ||` alias and a destructured parameter each make `env.KEY` a read; NEGATIVE — a member of some other object is not', async () => {
    write(tmp, 'src/a.js', 'function cfg(env = process.env) { return { a: env.ALIAS_KEY, b: env["ALIAS_BRACKET"] }; }\nmodule.exports = { cfg };\n');
    write(tmp, 'src/b.js', 'function sign(opts = {}) {\n  const env = opts.env || process.env;\n  return env.ALIAS_OR_KEY;\n}\nmodule.exports = { sign };\n');
    write(tmp, 'src/c.js', 'async function push({ rawBody, env, sql }) {\n  const secret = env.INJECTED_KEY;\n  return secret;\n}\nmodule.exports = { push };\n');
    // NEGATIVE CONTROL — `cfg.PLAIN_KEY` is a property of an ordinary object;
    // `settings.env.NESTED_KEY` is not the `env` binding either.
    write(tmp, 'src/d.js', 'const cfg = { PLAIN_KEY: 1 };\nconst settings = { env: {} };\nconst x = cfg.PLAIN_KEY + settings.env.NESTED_KEY;\nmodule.exports = { x };\n');
    write(tmp, '.env.example', 'ALIAS_KEY=\nALIAS_BRACKET=\nALIAS_OR_KEY=\nINJECTED_KEY=\nPLAIN_KEY=\nNESTED_KEY=\n');
    const r = await run(tmp);
    assert.deepStrictEqual(unusedOf(r), ['NESTED_KEY', 'PLAIN_KEY']);
  });

  it('an undeclared alias read is missing-from-example at WARNING — the binding may carry an injected default', async () => {
    write(tmp, 'src/a.js', 'function cfg(env = process.env) { return env.UNDECLARED_ALIAS; }\nmodule.exports = { cfg };\n');
    write(tmp, '.env.example', 'OTHER=\n');
    const r = await run(tmp);
    const hit = missingOf(r).find((c) => c.key === 'UNDECLARED_ALIAS');
    assert.ok(hit, 'the alias read is a read');
    assert.strictEqual(hit.severity, 'warning');
  });

  it('`const { A, B = "x" } = process.env` reads A and B; B is guarded, A is not', async () => {
    write(tmp, 'src/a.js', 'const { DESTRUCT_A, DESTRUCT_B = "x", DESTRUCT_C: renamed } = process.env;\nmodule.exports = { DESTRUCT_A, DESTRUCT_B, renamed };\n');
    write(tmp, '.env.example', 'DESTRUCT_C=\n');
    const r = await run(tmp);
    assert.deepStrictEqual(unusedOf(r), []);
    const bySev = Object.fromEntries(missingOf(r).map((c) => [c.key, c.severity]));
    assert.deepStrictEqual(bySev, { DESTRUCT_A: 'error', DESTRUCT_B: 'warning' });
  });
});

describe('EnvVarsModule — the `env:` marker names the reads no regex can see (2026-09-13)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-marker-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const unusedOf = (r) => r.checks.filter((c) => c.passed === false && c.name.startsWith('env-vars:unused-in-code:')).map((c) => c.key).sort();

  it('POSITIVE CONTROL — a `PREFIX_*` consumes every declared key under it and an exact key is a read; NEGATIVE — a key the marker does not name is still dead', async () => {
    // website/app/lib/platform-config.js: `env[`${prefix}${name}`]` over TALLRIG_/VAPRON_/CRONTECH_.
    write(tmp, 'src/platform.js', [
      'function platformEnv(name, env = process.env) {',
      "  for (const prefix of ['TALL_', 'VAP_']) {",
      '    // env: TALL_* VAP_* EXACT_ONE',
      '    const v = env[`${prefix}${name}`];',
      '    if (v) return v;',
      '  }',
      '}',
      'module.exports = { platformEnv };',
      '',
    ].join('\n'));
    write(tmp, 'tools/publish.py', 'import os\n# env: PY_MARKED\nurl = os.environ.get(name, "x")\n');
    write(tmp, '.env.example', 'TALL_BASE=\nTALL_TOKEN=\nVAP_BASE=\nEXACT_ONE=\nPY_MARKED=\nNOT_MARKED=\n');
    const r = await run(tmp);
    assert.deepStrictEqual(unusedOf(r), ['NOT_MARKED']);
  });

  it('an exact key in a marker that no env file declares is missing-from-example (a warning: the marker documents a read, not a boot risk)', async () => {
    write(tmp, 'src/a.js', "// env: MARKED_ONLY\nconst v = lookup('MARKED_ONLY');\nmodule.exports = { v };\n");
    write(tmp, '.env.example', 'OTHER=\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name === 'env-vars:missing-from-example:MARKED_ONLY');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });
});

describe('EnvVarsModule — only the .env* files are the contract unused-in-code judges (2026-09-13)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-contract-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('POSITIVE CONTROL — an .env.example key nothing reads is dead, and the finding points at its line; NEGATIVE — a key only a workflow env block or a compose `${X}` declares is not', async () => {
    write(tmp, 'src/a.js', 'const k = process.env.USED_KEY;\nmodule.exports = { k };\n');
    write(tmp, '.env.example', '# contract\nUSED_KEY=\nDEAD_KEY=\n');
    // .github/workflows/deploy-box.yml on this repo: BOX_SSH_HOST is set in
    // `env:` and read by the step's own shell — never by application code.
    write(tmp, '.github/workflows/deploy.yml', 'on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    env:\n      CI_ONLY_KEY: ${{ secrets.CI_ONLY_KEY }}\n    steps:\n      - run: ssh "$CI_ONLY_KEY"\n');
    write(tmp, 'docker-compose.yml', 'services:\n  db:\n    environment:\n      POSTGRES_USER: ${COMPOSE_ONLY_KEY:-x}\n');
    const r = await run(tmp);
    const unused = r.checks.filter((c) => c.passed === false && c.name.startsWith('env-vars:unused-in-code:'));
    assert.deepStrictEqual(unused.map((c) => c.key), ['DEAD_KEY']);
    assert.strictEqual(unused[0].file, '.env.example');
    assert.strictEqual(unused[0].line, 3);
  });

  it('a `${X}` quoted in a compose COMMENT declares nothing (`VAR` on this repo); one on a real line does', async () => {
    write(tmp, 'src/a.js', 'const a = process.env.COMMENTED;\nconst b = process.env.REAL_INTERP;\nmodule.exports = { a, b };\n');
    write(tmp, '.env.example', 'OTHER=\n');
    write(tmp, 'docker-compose.yml', '# Same ${COMMENTED:-default} expansions the app uses.\nservices:\n  app:\n    environment:\n      DATABASE_URL: postgres://${REAL_INTERP:-x}@db/app\n');
    const r = await run(tmp);
    const missing = r.checks.filter((c) => c.passed === false && c.name.startsWith('env-vars:missing-from-example:')).map((c) => c.key);
    assert.deepStrictEqual(missing, ['COMMENTED']);
  });
});

describe('EnvVarsModule — G5 (KI #112, issue #633): .env.example resolved per workspace on a monorepo', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-mono-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function writePkg(root, rel, name) {
    write(root, `${rel}/package.json`, JSON.stringify({ name }));
  }

  it('CONTROL PAIR — a workspace-local .env.example satisfies the check; a genuinely undocumented variable in src/ still fires', async () => {
    // packages/foo ships its own .env.example documenting FOO_DOCUMENTED —
    // reading it is fine. It also reads FOO_UNDOCUMENTED, unguarded, which
    // its own contract does not mention: that is a real, blocking miss.
    writePkg(tmp, 'packages/foo', '@t/foo');
    write(tmp, 'packages/foo/.env.example', 'FOO_DOCUMENTED=\n');
    write(tmp, 'packages/foo/src/index.js', [
      'const a = process.env.FOO_DOCUMENTED;',
      'const b = process.env.FOO_UNDOCUMENTED;',
      'module.exports = { a, b };',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(
      !r.checks.some((c) => c.name === 'env-vars:missing-from-example:FOO_DOCUMENTED'),
      'a var documented in the reading package\'s own .env.example must not fire at all',
    );
    const undoc = r.checks.find((c) => c.name === 'env-vars:missing-from-example:FOO_UNDOCUMENTED');
    assert.ok(undoc, 'a var genuinely undocumented anywhere in the repo must still fire');
    assert.strictEqual(undoc.severity, 'error', 'the owning package ships its own contract and missed this key — blocking');
  });

  it('an unguarded read in a workspace with NO .env.example of its own is a warning, even though the repo root has one', async () => {
    // Root ships an .env.example for the main app. packages/bar has never
    // opted into a documented contract of its own — root's file is not
    // bar's promise, so a miss there is documentation debt, not a boot risk.
    write(tmp, '.env.example', 'ROOT_KEY=\n');
    writePkg(tmp, 'packages/bar', '@t/bar');
    write(tmp, 'packages/bar/src/index.js', 'const x = process.env.BAR_UNDOCUMENTED;\nmodule.exports = { x };\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name === 'env-vars:missing-from-example:BAR_UNDOCUMENTED');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('a variable documented in a DIFFERENT workspace\'s .env.example is still not "missing" (declared is repo-wide)', async () => {
    writePkg(tmp, 'packages/foo', '@t/foo');
    write(tmp, 'packages/foo/.env.example', 'SHARED_KEY=\n');
    writePkg(tmp, 'packages/bar', '@t/bar');
    write(tmp, 'packages/bar/src/index.js', 'const x = process.env.SHARED_KEY;\nmodule.exports = { x };\n');
    const r = await run(tmp);
    assert.ok(!r.checks.some((c) => c.name === 'env-vars:missing-from-example:SHARED_KEY'));
  });
});
