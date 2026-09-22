const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ShellModule = require('../src/modules/shell');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new ShellModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('ShellModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no shell scripts exist', async () => {
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'shell:no-files'));
  });

  it('finds .sh, .bash, and .zsh files', async () => {
    write(tmp, 'a.sh',   '#!/usr/bin/env bash\nset -euo pipefail\necho a\n');
    write(tmp, 'b.bash', '#!/usr/bin/env bash\nset -euo pipefail\necho b\n');
    write(tmp, 'c.zsh',  '#!/usr/bin/env zsh\nset -euo pipefail\necho c\n');
    const r = await run(tmp);
    const scanning = r.checks.find((c) => c.name === 'shell:scanning');
    assert.match(scanning.message, /3 shell/);
  });

  it('excludes node_modules', async () => {
    write(tmp, 'node_modules/foo/bad.sh', 'rm -rf $HOME\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'shell:no-files'));
  });

  // KI #106 control pair — files are chosen by src/core/shell-files.js, not
  // by extension: an extensionless deploy script with a bash shebang is the
  // commonest place for `rm -rf $DIR/` and was never opened before.
  const DEPLOY = '#!/usr/bin/env bash\nset -e\nrm -rf $DIR/\n';

  it('POSITIVE: extensionless bin/deploy with a bash shebang FIRES unsafe-rm', async () => {
    write(tmp, 'bin/deploy', DEPLOY);
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name === 'shell:unsafe-rm:bin/deploy:3');
    assert.ok(hit, r.checks.map((c) => c.name).join(', '));
    assert.strictEqual(hit.severity, 'error');
  });

  it('NEGATIVE: the same bytes under LICENSE, or under a node shebang, are not shell', async () => {
    write(tmp, 'LICENSE', DEPLOY);
    write(tmp, 'bin/cli', '#!/usr/bin/env node\nconst DIR = "x";\nrequire("child_process").execSync("rm -rf $DIR/");\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'shell:no-files'), r.checks.map((c) => c.name).join(', '));
  });

  it('a .ksh file is scanned; a .sh still is', async () => {
    write(tmp, 'a.ksh', DEPLOY);
    write(tmp, 'b.sh', DEPLOY);
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'shell:unsafe-rm:a.ksh:3'));
    assert.ok(r.checks.find((c) => c.name === 'shell:unsafe-rm:b.sh:3'));
  });
});

describe('ShellModule — shebang + set -e', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-shb-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('info-flags missing shebang', async () => {
    write(tmp, 'script.sh', 'echo hello\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:no-shebang:')));
  });

  it('warns when set -e / pipefail is missing', async () => {
    write(tmp, 'script.sh', '#!/usr/bin/env bash\necho hello\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:missing-set-e:')));
  });

  it('accepts `set -euo pipefail`', async () => {
    write(tmp, 'script.sh', '#!/usr/bin/env bash\nset -euo pipefail\necho hello\n');
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('shell:missing-set-e:')), undefined);
  });

  it('accepts `set -o errexit`', async () => {
    write(tmp, 'script.sh', '#!/usr/bin/env bash\nset -o errexit\necho hello\n');
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('shell:missing-set-e:')), undefined);
  });
});

describe('ShellModule — curl | sh', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-curl-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on curl | sh', async () => {
    write(tmp, 'install.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'curl -sSL https://example.com/install.sh | sh',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('shell:curl-pipe-sh:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on wget | bash', async () => {
    write(tmp, 'install.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'wget -qO- https://example.com/install | bash',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:curl-pipe-sh:')));
  });

  it('does not flag curl piped to a non-shell command', async () => {
    write(tmp, 'fetch.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'curl -sSL https://example.com/data.json | jq .',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('shell:curl-pipe-sh:')), undefined);
  });
});

describe('ShellModule — unsafe rm', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-rm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on `rm -rf $VAR` (unquoted)', async () => {
    write(tmp, 'clean.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'rm -rf $BUILD_DIR',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('shell:unsafe-rm:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on `rm -rf /`', async () => {
    write(tmp, 'nuke.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'rm -rf /',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:unsafe-rm:')));
  });

  it('accepts quoted + guarded `rm -rf "$VAR"`', async () => {
    write(tmp, 'clean.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      ': "${BUILD_DIR:?BUILD_DIR required}"',
      'rm -rf -- "$BUILD_DIR"',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('shell:unsafe-rm:')), undefined);
  });
});

describe('ShellModule — eval + secrets', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-eval-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on `eval $VAR`', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'eval "$CMD"',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:eval-var:')));
  });

  it('errors on `eval $(cmd)`', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'eval $(get-config)',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:eval-var:')));
  });

  // issue #633 (2026-09-22): `run(){ eval "$@"; }` — the dry-run/verbose
  // wrapper idiom — was reported 5x on one repo, 0 of them real: the
  // shell has already tokenized "$@" into the caller's own argument
  // vector, structurally different from eval'ing a single variable.
  it('CONTROL PAIR (issue #633): `eval "$@"` (positional-params wrapper) is quiet; `eval "$CMD"` beside it still fires', async () => {
    write(tmp, 'scripts/run.sh', [
      '#!/usr/bin/env bash',
      'run() { echo "+ $@"; eval "$@"; }',
      'run "$CMD"',
    ].join('\n'));
    const r = await run(tmp);
    const evals = r.checks.filter((c) => c.name.startsWith('shell:eval-var:'));
    assert.strictEqual(evals.length, 0, JSON.stringify(evals));
  });

  it('`eval "${@}"` and `eval "$*"` are the same passthrough shape and stay quiet', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'run_a() { eval "${@}"; }',
      'run_b() { eval "$*"; }',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.filter((c) => c.name.startsWith('shell:eval-var:')).length, 0);
  });

  it('`eval "$@ extra"` (not a pure passthrough) and `eval "$1"` still fire', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'eval "$@ extra"',
      'eval "$1"',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.filter((c) => c.name.startsWith('shell:eval-var:')).length, 2);
  });

  it('errors on hardcoded AWS access key', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:hardcoded-secret:aws-key:')));
  });

  it('errors on embedded private key marker', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'KEY="-----BEGIN RSA PRIVATE KEY-----"',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:hardcoded-secret:private-key:')));
  });
});

describe('ShellModule — POSIX / portability', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-posix-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns when #!/bin/sh uses [[ ]]', async () => {
    write(tmp, 's.sh', [
      '#!/bin/sh',
      'set -e',
      'if [[ "$x" = "y" ]]; then echo hi; fi',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:sh-but-bashism:double-bracket:')));
  });

  it('warns when #!/bin/sh uses here-strings', async () => {
    write(tmp, 's.sh', [
      '#!/bin/sh',
      'set -e',
      'grep foo <<< "$data"',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:sh-but-bashism:here-string:')));
  });

  it('does NOT warn about bashisms when shebang is bash', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$x" = "y" ]]; then echo hi; fi',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('shell:sh-but-bashism:')), undefined);
  });

  it('info-flags backtick command substitution', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'X=`date +%s`',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('shell:backticks:')));
  });

  it('accepts $(...) command substitution silently', async () => {
    write(tmp, 's.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'X=$(date +%s)',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('shell:backticks:')), undefined);
  });
});

describe('ShellModule — summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-sum-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records a summary', async () => {
    write(tmp, 's.sh', '#!/usr/bin/env bash\nset -euo pipefail\necho ok\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'shell:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});

describe('ShellModule — a vendored build-tool wrapper is reported, not blocked (2026-09-05)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shell-vendored-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const EVAL = ['#!/bin/sh', 'eval "set -- $(printf x | xargs -n1)"', ''].join('\n');

  it('the stock gradlew / mvnw: eval-var is info and says why', async () => {
    write(tmp, 'gradlew', EVAL);
    write(tmp, 'mvnw', EVAL);
    const r = await run(tmp);
    const evals = r.checks.filter((c) => c.name.startsWith('shell:eval-var:'));
    assert.strictEqual(evals.length, 2, JSON.stringify(r.checks.map((c) => c.name)));
    for (const c of evals) {
      assert.strictEqual(c.severity, 'info');
      assert.match(c.message, /vendored build-tool wrapper/);
    }
  });

  it('the same line in the project\'s own script is still an error', async () => {
    write(tmp, 'scripts/deploy.sh', EVAL);
    const r = await run(tmp);
    const c = r.checks.find((x) => x.name.startsWith('shell:eval-var:'));
    assert.ok(c, 'eval-var must fire');
    assert.strictEqual(c.severity, 'error');
  });
});
