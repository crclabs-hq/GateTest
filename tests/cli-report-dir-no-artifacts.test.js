'use strict';

/**
 * Complaint C22 (2026-09-25): every `gatetest` scan wrote ~134 KB into the
 * scanned checkout — `.gatetest/reports/*`, `.gatetest/reports/scan-
 * history.json`, `.gatetest/memory.json` and `.gatetest/memory/
 * fingerprint.json` — with NO CLI opt-out. A CI runner, a monorepo, or
 * anyone scanning a read-only tree got a dirty `git status` with no way to
 * avoid it.
 *
 * `--report-dir <path>` / `GATETEST_REPORT_DIR` relocate all of it (every
 * reporter AND the two memory stores) under one path; `--no-artifacts` /
 * `GATETEST_NO_ARTIFACTS=1` writes none of it. Both are resolved through
 * ONE helper, `src/core/report-paths.js` (doctrine #4).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseArgs } = require('../src/core/cli-args');
const {
  DEFAULT_REPORT_DIR,
  ENV_REPORT_DIR,
  ENV_NO_ARTIFACTS,
  resolveReportDir,
  resolveMemoryRoot,
  artifactsDisabled,
} = require('../src/core/report-paths');
const { gatetestDirIsGitignored, isGitRepo } = require('../src/core/gitignore-hint');

const BIN = path.join(__dirname, '..', 'bin', 'gatetest.js');

function tmpProject(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"c22-fixture","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = (a, b) => a + b;\n');
  return root;
}

/**
 * Clean child env — never inherit an outer GATETEST_REPORT_DIR/NO_ARTIFACTS,
 * and telemetry stays ON by default (unless a test opts out itself) so the
 * persistent-memory write this suite checks for (.gatetest/memory.json,
 * written from the telemetry-gated flywheel path) is deterministic
 * regardless of the ambient shell.
 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('GATETEST_REPORT_DIR' in extra)) delete env.GATETEST_REPORT_DIR;
  if (!('GATETEST_NO_ARTIFACTS' in extra)) delete env.GATETEST_NO_ARTIFACTS;
  if (!('GATETEST_NO_TELEMETRY' in extra)) delete env.GATETEST_NO_TELEMETRY;
  return env;
}

function run(args, env) {
  return execFileSync(process.execPath, [BIN, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  }).replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// CLI flags — parsed, not swallowed
// ---------------------------------------------------------------------------

describe('cli-args — --report-dir / --no-artifacts', () => {
  it('--report-dir <path> is a value flag', () => {
    const args = parseArgs(['--report-dir', '/tmp/out']);
    assert.equal(args.reportDir, '/tmp/out');
    assert.equal(args.unknownArgs, undefined);
  });

  it('--report-dir with no value is reported, not silently defaulted', () => {
    const args = parseArgs(['--report-dir']);
    assert.deepEqual(args.missingValues, ['--report-dir']);
  });

  it('--no-artifacts is a boolean flag', () => {
    assert.equal(parseArgs(['--no-artifacts']).noArtifacts, true);
    assert.equal(parseArgs([]).noArtifacts, undefined);
  });
});

// ---------------------------------------------------------------------------
// The one resolved-path helper — precedence and defaults
// ---------------------------------------------------------------------------

describe('report-paths — resolveReportDir / resolveMemoryRoot / artifactsDisabled', () => {
  const fakeConfig = (projectRoot, outputDir) => ({
    projectRoot,
    get: (key) => (key === 'reporting.outputDir' ? outputDir : undefined),
  });

  it('resolveReportDir joins the default relative to projectRoot', () => {
    assert.equal(
      resolveReportDir(fakeConfig('/repo', DEFAULT_REPORT_DIR)),
      path.resolve('/repo', DEFAULT_REPORT_DIR),
    );
  });

  it('resolveReportDir honours an absolute configured outputDir', () => {
    assert.equal(resolveReportDir(fakeConfig('/repo', '/tmp/out')), path.resolve('/tmp/out'));
  });

  it('resolveMemoryRoot defaults to <project>/.gatetest with no env override', () => {
    delete process.env[ENV_REPORT_DIR];
    assert.equal(resolveMemoryRoot('/repo'), path.join('/repo', '.gatetest'));
  });

  it('resolveMemoryRoot follows GATETEST_REPORT_DIR when set', () => {
    process.env[ENV_REPORT_DIR] = '/tmp/redirected';
    try {
      assert.equal(resolveMemoryRoot('/repo'), path.resolve('/repo', '/tmp/redirected'));
    } finally {
      delete process.env[ENV_REPORT_DIR];
    }
  });

  it('artifactsDisabled reads GATETEST_NO_ARTIFACTS strictly ("1" only)', () => {
    delete process.env[ENV_NO_ARTIFACTS];
    assert.equal(artifactsDisabled(), false);
    process.env[ENV_NO_ARTIFACTS] = '1';
    try {
      assert.equal(artifactsDisabled(), true);
    } finally {
      delete process.env[ENV_NO_ARTIFACTS];
    }
  });
});

// ---------------------------------------------------------------------------
// End to end — default location, --report-dir, --no-artifacts, env precedence
// ---------------------------------------------------------------------------

describe('gatetest --suite quick — where it writes', () => {
  it('default: writes the known files under <project>/.gatetest/', () => {
    const root = tmpProject('gt-c22-default-');
    try {
      const out = run(['--suite', 'quick', '--project', root], childEnv());
      assert.match(out, /GATE: (PASSED|BLOCKED)/);
      assert.ok(fs.existsSync(path.join(root, '.gatetest', 'reports', 'gatetest-report-latest.json')));
      assert.ok(fs.existsSync(path.join(root, '.gatetest', 'reports', 'gatetest-report-latest.html')));
      assert.ok(fs.existsSync(path.join(root, '.gatetest', 'reports', 'scan-history.json')));
      assert.ok(fs.existsSync(path.join(root, '.gatetest', 'memory', 'fingerprint.json')));
      assert.ok(fs.existsSync(path.join(root, '.gatetest', 'memory.json')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('--report-dir <tmp>: writes there and nothing under <project>/.gatetest/', () => {
    const root = tmpProject('gt-c22-reportdir-');
    const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-c22-out-'));
    try {
      const out = run(['--suite', 'quick', '--project', root, '--report-dir', out2], childEnv());
      assert.match(out, /GATE: (PASSED|BLOCKED)/);
      assert.ok(fs.existsSync(path.join(out2, 'gatetest-report-latest.json')), 'report lands directly in --report-dir');
      assert.ok(fs.existsSync(path.join(out2, 'memory', 'fingerprint.json')), 'memory relocates under --report-dir');
      assert.ok(fs.existsSync(path.join(out2, 'memory.json')));
      assert.equal(fs.existsSync(path.join(root, '.gatetest')), false, 'nothing left behind in the scanned checkout');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(out2, { recursive: true, force: true });
    }
  });

  it('--no-artifacts: writes nothing, exits 0, still prints a summary; --format json still emits', () => {
    const root = tmpProject('gt-c22-noartifacts-');
    try {
      const out = run(['--suite', 'quick', '--project', root, '--no-artifacts'], childEnv());
      assert.match(out, /GATE: (PASSED|BLOCKED)/);
      assert.equal(fs.existsSync(path.join(root, '.gatetest')), false);

      const jsonOut = run(['--suite', 'quick', '--project', root, '--no-artifacts', '--format', 'json'], childEnv());
      const doc = JSON.parse(jsonOut);
      assert.ok(doc.gateStatus, 'stdout JSON document still emitted with --no-artifacts');
      assert.equal(fs.existsSync(path.join(root, '.gatetest')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('env precedence: GATETEST_REPORT_DIR alone redirects; the flag wins over a different env value', () => {
    const root = tmpProject('gt-c22-envprec-');
    const envOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-c22-envonly-'));
    const flagWins = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-c22-flagwins-'));
    try {
      run(['--suite', 'quick', '--project', root], childEnv({ GATETEST_REPORT_DIR: envOnly }));
      assert.ok(fs.existsSync(path.join(envOnly, 'gatetest-report-latest.json')), 'env var alone redirects');
      assert.equal(fs.existsSync(path.join(root, '.gatetest')), false);

      run(['--suite', 'quick', '--project', root, '--report-dir', flagWins], childEnv({ GATETEST_REPORT_DIR: envOnly }));
      assert.ok(fs.existsSync(path.join(flagWins, 'gatetest-report-latest.json')), 'flag beats env');
      assert.equal(fs.existsSync(path.join(root, '.gatetest')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(envOnly, { recursive: true, force: true });
      fs.rmSync(flagWins, { recursive: true, force: true });
    }
  });

  it('GATETEST_NO_ARTIFACTS=1 env alone (no flag) also suppresses every write', () => {
    const root = tmpProject('gt-c22-envnoart-');
    try {
      const out = run(['--suite', 'quick', '--project', root], childEnv({ GATETEST_NO_ARTIFACTS: '1' }));
      assert.match(out, /GATE: (PASSED|BLOCKED)/);
      assert.equal(fs.existsSync(path.join(root, '.gatetest')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The .gitignore hint — exactly once in the right case, absent in every
// documented exclusion
// ---------------------------------------------------------------------------

describe('gitignore-hint — is .gatetest/ covered by the project\'s own .gitignore?', () => {
  it('false with no .gitignore at all', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-c22-noignore-'));
    try {
      assert.equal(gatetestDirIsGitignored(root), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('false when .gitignore exists but does not mention .gatetest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-c22-othergitignore-'));
    try {
      fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\ndist/\n');
      assert.equal(gatetestDirIsGitignored(root), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('true for the standard ".gatetest/" line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-c22-ignored-'));
    try {
      fs.writeFileSync(path.join(root, '.gitignore'), '.gatetest/\n');
      assert.equal(gatetestDirIsGitignored(root), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('isGitRepo checks for a .git directory only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-c22-notgit-'));
    try {
      assert.equal(isGitRepo(root), false);
      fs.mkdirSync(path.join(root, '.git'));
      assert.equal(isGitRepo(root), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gatetest --suite quick — the C22 first-time hint end to end', () => {
  const { spawnSync } = require('node:child_process');
  const HINT = 'hint: add .gatetest/ to .gitignore, or use --report-dir / --no-artifacts';

  function gitFixture(prefix) {
    const root = tmpProject(prefix);
    fs.mkdirSync(path.join(root, '.git')); // isGitRepo only checks existence
    return root;
  }

  function scan(root, extraArgs = []) {
    return spawnSync(process.execPath, [BIN, '--suite', 'quick', '--project', root, ...extraArgs], {
      env: childEnv(), encoding: 'utf8', timeout: 60000,
    });
  }

  it('appears exactly once: a git repo whose .gitignore does not cover .gatetest/', () => {
    const root = gitFixture('gt-c22-hint-fire-');
    try {
      const r = scan(root);
      const occurrences = r.stderr.split(HINT).length - 1;
      assert.equal(occurrences, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('absent: .gitignore already covers .gatetest/', () => {
    const root = gitFixture('gt-c22-hint-ignored-');
    fs.writeFileSync(path.join(root, '.gitignore'), '.gatetest/\n');
    try {
      assert.equal(scan(root).stderr.includes(HINT), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('absent: --format json mode', () => {
    const root = gitFixture('gt-c22-hint-json-');
    try {
      assert.equal(scan(root, ['--format', 'json']).stderr.includes(HINT), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('absent: --no-artifacts', () => {
    const root = gitFixture('gt-c22-hint-noart-');
    try {
      assert.equal(scan(root, ['--no-artifacts']).stderr.includes(HINT), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
