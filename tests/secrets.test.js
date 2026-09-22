const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SecretsModule = require('../src/modules/secrets');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('SecretsModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new SecretsModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new SecretsModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

describe('SecretsModule — prose values are not credentials (self-scan false positive)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-prose-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scan(filename, source) {
    fs.writeFileSync(path.join(tmp, filename), source);
    const mod = new SecretsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && c.name.startsWith('secrets:') && c.file === filename);
  }

  // The exact shape that blocked GateTest's own gate: a map from env-var
  // NAME to a human explanation. `CRON_SECRET` matches the rule; the value
  // is an English sentence, not a credential.
  it('does not flag an env-var docs map with sentence values', async () => {
    const found = await scan('preflight.js', [
      'const REQUIRED = {',
      "  CRON_SECRET: 'the scan queue is never drained so no commit status is ever posted',",
      "  RESEND_API_KEY: 'transactional email cannot send and key delivery fails silently',",
      '};',
      'module.exports = { REQUIRED };',
    ].join('\n'));
    assert.deepStrictEqual(found, [], `expected no findings, got ${JSON.stringify(found)}`);
  });

  it('STILL flags a real hardcoded credential', async () => {
    // Assembled at runtime, never written as one literal. The fixture has to
    // LOOK like a live Stripe key for our own rule to fire on it, and a
    // contiguous one in the source trips GitHub's push protection — which
    // blocked this very commit on 2026-07-27. Split here, whole on disk.
    const liveKey = ['sk', 'live', '51H8xQ2eZvKYlo2Cabcdef1234'].join('_');
    const found = await scan('config.js', `const apiKey = '${liveKey}';`);
    assert.strictEqual(found.length, 1, 'a real key must not be excused as prose');
  });

  it('STILL flags a key-shaped value even when the line has several words', async () => {
    // Four+ words, but one is a long letters+digits run — key-shaped.
    // Deliberately avoids the substring "example", which the placeholder
    // allow-list suppresses earlier and would mask what this test checks.
    const found = await scan('cfg.js', "const token = 'prod key is AKIAIOSFODNN7QQZZTT1234 ok';");
    assert.strictEqual(found.length, 1, 'entropy run must defeat the prose heuristic');
  });

  it('STILL flags a short quoted secret (too few words to be prose)', async () => {
    const found = await scan('short.js', "const password = 'hunter2hunter2';");
    assert.strictEqual(found.length, 1);
  });

  it('_looksLikeProse only accepts plain-language values', () => {
    const mod = new SecretsModule();
    assert.strictEqual(mod._looksLikeProse("SECRET: 'the queue is never drained"), true);
    assert.strictEqual(mod._looksLikeProse("secret: 'abc123def456ghi789jkl"), false);
    assert.strictEqual(mod._looksLikeProse("password: 'one two three"), false, '3 words is under the threshold');
    assert.strictEqual(mod._looksLikeProse("token: 'set FOO_BAR=1 then retry now"), false, 'code-ish chars are not prose');
  });
});

describe('SecretsModule — placeholder suppression actually runs (regression)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-ph-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scan(filename, source) {
    fs.writeFileSync(path.join(tmp, filename), source);
    const mod = new SecretsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && c.name.startsWith('secrets:') && c.file === filename);
  }

  // The placeholder allow-list existed but never executed: `test()` advanced
  // lastIndex on the /g regex, so the following `exec()` returned null and
  // the `if (m)` block was skipped every time. Documented placeholders were
  // therefore reported as hard errors for every customer.
  for (const placeholder of ['changeme', 'your_api_key_here', 'REPLACE_ME_NOW', 'xxxxxxxxxxxx']) {
    it(`suppresses the documented placeholder "${placeholder}"`, async () => {
      const found = await scan('conf.js', `const password = '${placeholder}';`);
      assert.deepStrictEqual(found, [], `placeholder ${placeholder} must not be a finding`);
    });
  }

  it('a real credential on the same shape is still an error', async () => {
    const found = await scan('conf.js', "const password = 'Xk92Lq0ZbTn4Ww81';");
    assert.strictEqual(found.length, 1);
  });
});

describe('SecretsModule — "example" suppression is word-bounded', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-ex-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scan(source) {
    fs.writeFileSync(path.join(tmp, 'cfg.js'), source);
    const mod = new SecretsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && c.file === 'cfg.js');
  }

  it('a high-entropy key is NOT excused just for containing "example"', async () => {
    const found = await scan('const AWS_SECRET_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";');
    assert.strictEqual(found.length, 1, 'embedded "example" must not silence a key-shaped value');
  });

  it('a standalone "example" placeholder is still suppressed', async () => {
    const found = await scan("const password = 'example_secret';");
    assert.deepStrictEqual(found, []);
  });
});

// Issue #633 (Tallrig, 76-workspace monorepo): 13/13 sampled findings were
// false positives, two named shapes —
//   1. `vapron-default-key-change-me`, a placeholder the app's own boot
//      guard REJECTS (`if (key === 'vapron-default-key-change-me') throw …`).
//      Investigated: PLACEHOLDER_VALUE_RE's `default[_-]?(?:secret|key|
//      password|token)` alternative already matches the `default-key`
//      segment inside this value case-insensitively, so it is suppressed by
//      the very first placeholder check the main scan loop runs (line 826)
//      before any comparison/assignment context is even considered — the
//      comparison itself is ALSO already neutralised by
//      _stripComparisonLiterals for `===`/`!==`/`==`/`!=`. No rule change
//      reproduces a finding for this value in any of: a same-line `===`
//      comparison, an `_envFallbackSecret` (`?? '...'`) default, or a bare
//      assignment — see the three describe blocks below.
//   2. `` $(openssl rand -hex 32) `` — a shell command substitution that
//      GENERATES a value, not a literal. Investigated: _looksLikeReference
//      already treats any value starting with `$(` or a backtick as a
//      reference rather than a literal (see its own doc comment, which
//      predates this issue and was written for a different command
//      entirely — `sed`), so no command-specific list is needed; `openssl`,
//      `uuidgen`, etc. all trigger the same `$(` / backtick prefix check.
//
// Both shapes are already excluded by existing, generalised logic — not a
// hardcoded match on these two exact strings. These tests are the control
// pair the issue asked for: the two reported shapes stay quiet, and a real
// hardcoded AWS-style key alongside them still fires.
describe('SecretsModule — issue #633: boot-guard placeholder and $(...) generator are not secrets', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-633-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scan(filename, source) {
    fs.writeFileSync(path.join(tmp, filename), source);
    const mod = new SecretsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && c.name.startsWith('secrets:') && c.file === filename);
  }

  // A real hardcoded AWS-style key — assembled at runtime, split across
  // pieces on disk, same convention as the sk_live_ fixture above, so this
  // commit doesn't itself trip GitHub push protection.
  const REAL_AWS_KEY = ['AKIA', 'QWERTYUIOPASDFGH'].join('');

  it('the boot-guard placeholder in a same-line === comparison is quiet; a real key beside it still fires', async () => {
    const found = await scan('guard.js', [
      "if (apiKey === 'vapron-default-key-change-me') {",
      "  throw new Error('change the default key before deploying');",
      '}',
      `const accessKeyId = "${REAL_AWS_KEY}";`,
    ].join('\n'));
    assert.strictEqual(found.length, 1, `expected exactly the AWS key to fire, got ${JSON.stringify(found)}`);
    assert.match(found[0].details[0].type, /^AWS/);
  });

  it('the boot-guard placeholder as an env-fallback default is quiet', async () => {
    const found = await scan('fallback.js', [
      "const AUTH_SECRET = process.env.AUTH_SECRET ?? 'vapron-default-key-change-me';",
      "if (AUTH_SECRET === 'vapron-default-key-change-me') {",
      "  throw new Error('rotate the secret');",
      '}',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('the boot-guard placeholder as a bare assignment is quiet', async () => {
    const found = await scan('bare.js', "const secretToken = 'vapron-default-key-change-me';\n");
    assert.deepStrictEqual(found, []);
  });

  it('a $(openssl ...) command substitution assigned to a credential-named identifier is quiet; a real key beside it still fires', async () => {
    const found = await scan('gen.sh', [
      'export DATABASE_PASSWORD="$(openssl rand -hex 32)"',
      'export SESSION_TOKEN="$(uuidgen)"',
      `export AWS_ACCESS_KEY_ID="${REAL_AWS_KEY}"`,
    ].join('\n'));
    assert.strictEqual(found.length, 1, `expected exactly the AWS key to fire, got ${JSON.stringify(found)}`);
    assert.match(found[0].details[0].type, /^AWS/);
  });

  it('a backtick command substitution is quiet the same way', async () => {
    const found = await scan('gen2.js', 'const secret = `$(openssl rand -hex 32)`;\n');
    assert.deepStrictEqual(found, []);
  });
});

// secrets.js carried its own private test-path regex, which did not know the
// separator-compound dirs (`js_tests/`, `runtime-tests/`) that base-module's
// TEST_PATH_RE learned from django and hono. One definition now.
describe('SecretsModule — test-tree detection is the canonical predicate', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-testpath-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function severityOf(rel) {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'const aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";\nconst k = "AKIAIOSFODNN7EXAMPLE";\n');
    const result = makeResult();
    await new SecretsModule().run(result, { projectRoot: tmp });
    const check = result.checks.find((c) => c.name === `secrets:${rel}`);
    return check ? check.severity : null;
  }

  it('js_tests/ is a test tree (django) — a fixture, not a leak: info, not error', async () => {
    assert.strictEqual(await severityOf('js_tests/admin/creds.test.js'), 'info');
  });
  it('runtime-tests/ is a test tree (hono): info, not error', async () => {
    assert.strictEqual(await severityOf('runtime-tests/node/creds.js'), 'info');
  });
  it('a file that merely contains "test" in its name is application code', async () => {
    assert.strictEqual(await severityOf('src/contest.js'), 'error');
  });
});
