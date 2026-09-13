// =============================================================================
// CORPUS GATE — the two findings that BLOCKED expressjs/express on 2026-09-02
// =============================================================================
// The first automated run of scripts/corpus-gate.js reported express at 2
// blocking findings where the hand-run benchmark of 2026-09-01 had 0. Both
// were passes on Windows that became false positives on Linux:
//
//   secrets:tracked-.npmrc   express commits a config-only .npmrc
//                            (package-lock=false, ignore-scripts=true …).
//                            "likely contains secrets" was a guess about the
//                            filename, not a reading of the file.
//   docs:readme              express's README is `Readme.md`. existsSync on a
//                            case-insensitive filesystem said yes; Linux said no.
//
// Every relaxation below carries its still-fires half.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const SecretsModule = require('../src/modules/secrets');
const DocumentationModule = require('../src/modules/documentation');

function gitRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-express-blockers-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execSync('git init -q && git add -A', { cwd: root, stdio: 'ignore' });
  return root;
}

function trackedFinding(files, name) {
  const root = gitRepo(files);
  try {
    const r = { checks: [], addCheck(n, p, m) { this.checks.push({ name: n, passed: p, ...(m || {}) }); }, addInfo() {} };
    new SecretsModule()._checkEnvFiles(root, r);
    return r.checks.find((c) => c.name === `secrets:tracked-${name}`) || null;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('secrets — a tracked .npmrc is judged by its contents', () => {
  it('config-only .npmrc (the express case) produces NO finding', () => {
    const f = trackedFinding({ '.npmrc': 'package-lock=false\nmin-release-age=7\nignore-scripts=true\nallow-git=none\n', 'index.js': '' }, '.npmrc');
    assert.strictEqual(f, null);
  });

  it('NEGATIVE CONTROL: .npmrc carrying an _authToken still BLOCKS', () => {
    const f = trackedFinding({ '.npmrc': '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789\n', 'index.js': '' }, '.npmrc');
    assert.ok(f && f.passed === false, 'must be reported');
    assert.strictEqual(f.severity, 'error');
    assert.doesNotMatch(f.message, /could not confirm/, 'git answered, so the message carries no caveat');
  });

  // Three-state git probe (2026-09-13). Under a loaded full-suite run the 5 s
  // `git ls-files` probe timed out and the _authToken .npmrc above was
  // reported as CLEAN — a false negative on the highest-severity check the
  // module has. The probe now distinguishes "git answered: not tracked"
  // (stay quiet) from "git could not answer" (fail toward detection).
  describe('when git cannot answer, a credential-carrying file is still reported', () => {
    const NPMRC = '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789\n';

    function withProbe(probeResult) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-git-probe-'));
      fs.writeFileSync(path.join(root, '.npmrc'), NPMRC);
      try {
        const mod = new SecretsModule();
        mod._exec = () => ({ stdout: '', stderr: '', signal: null, timedOut: false, spawnError: null, ...probeResult });
        const r = { checks: [], addCheck(n, p, m) { this.checks.push({ name: n, passed: p, ...(m || {}) }); }, addInfo() {} };
        mod._checkEnvFiles(root, r);
        return r.checks.find((c) => c.name === 'secrets:tracked-.npmrc') || null;
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }

    it('git answered "not tracked" (exit 1): nothing to report — the file is not committed', () => {
      assert.strictEqual(withProbe({ exitCode: 1 }), null);
    });

    it('git timed out: reported, and the message says tracking was not confirmed', () => {
      const f = withProbe({ exitCode: 1, timedOut: true });
      assert.ok(f && f.passed === false && f.severity === 'error');
      assert.match(f.message, /git timed out/);
    });

    it('not a git checkout (exit 128): reported with the exit code in the caveat', () => {
      const f = withProbe({ exitCode: 128 });
      assert.ok(f && f.passed === false);
      assert.match(f.message, /git exit 128/);
    });

    it('git binary missing (spawn ENOENT, which _exec used to fold into exit 1): reported', () => {
      const f = withProbe({ exitCode: 1, spawnError: 'ENOENT' });
      assert.ok(f && f.passed === false);
      assert.match(f.message, /could not run \(ENOENT\)/);
    });

    it('_exec reports a spawn failure distinctly from a real exit 1', () => {
      const BaseModule = require('../src/modules/base-module');
      const r = new BaseModule()._exec('definitely-not-a-real-binary-gatetest-0913 --version', { timeout: 5000 });
      assert.notStrictEqual(r.exitCode, 0);
      // On every platform the shell either reports the command missing (exit
      // 127 / 1 with a shell error) or the spawn itself fails; either way the
      // caller must not read it as a verdict.
      assert.ok(r.exitCode !== 1 || r.spawnError || /not (found|recognized)/i.test(r.stderr), JSON.stringify(r));
    });
  });

  it('a tracked .env holding only placeholders is a warning, not a block', () => {
    const f = trackedFinding({ '.env': 'DATABASE_URL=\nAPI_KEY=your-api-key-here\nPORT=3000\n', 'index.js': '' }, '.env');
    assert.ok(f, 'a tracked .env is always at least a hygiene warning');
    assert.strictEqual(f.severity, 'warning');
  });

  it('NEGATIVE CONTROL: a tracked .env with a real-looking value still BLOCKS', () => {
    // A high-entropy value with no placeholder shape. (Deliberately NOT a
    // vendor-prefixed key: GitHub push protection rejects the canonical Stripe
    // docs example as a live secret, and a fixture that cannot be pushed is
    // not a fixture.)
    const f = trackedFinding({ '.env': 'DATABASE_PASSWORD=q7Vt2pLm9xKw4RzN8bYh\n', 'index.js': '' }, '.env');
    assert.ok(f && f.severity === 'error');
  });

  it('NEGATIVE CONTROL: tracked key material always BLOCKS regardless of content', () => {
    // The verdict is by FILENAME, so the body can be elided — and an elided
    // body is what keeps our own line scanner (which reads this test as source)
    // from reporting the fixture as a committed key (Code Scanning 4308).
    const f = trackedFinding({ 'id_rsa': '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...\n', 'index.js': '' }, 'id_rsa');
    assert.ok(f && f.severity === 'error');
  });
});

describe('documentation — the README is found whatever it is called', () => {
  function readmeCheck(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-readme-'));
    try {
      for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), body);
      const r = { checks: [], addCheck(n, p, m) { this.checks.push({ name: n, passed: p, ...(m || {}) }); }, addInfo() {} };
      new DocumentationModule()._checkReadme(root, r);
      return r.checks.find((c) => c.name === 'docs:readme') || null;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const BODY = '# Project\n\n## Install\n\nnpm i\n\n## Usage\n\nrun it\n\n## License\n\nMIT\n' + 'x'.repeat(400);

  for (const name of ['README.md', 'Readme.md', 'readme.md', 'README', 'README.rst', 'readme.markdown']) {
    it(`finds ${name}`, () => {
      const c = readmeCheck({ [name]: BODY });
      assert.ok(!c || c.passed !== false, `${name} was reported missing: ${c && c.message}`);
    });
  }

  it('NEGATIVE CONTROL: a repo with no README at all is still reported', () => {
    const c = readmeCheck({ 'index.js': '' });
    assert.ok(c && c.passed === false);
  });

  it('NEGATIVE CONTROL: README-ish names that are not a README do not count', () => {
    const c = readmeCheck({ 'README-template.md': BODY, 'readme.js': '' });
    assert.ok(c && c.passed === false, 'README-template.md is not the README');
  });
});
