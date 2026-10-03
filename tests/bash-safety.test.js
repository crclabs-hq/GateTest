'use strict';

// BASH SAFETY — control pairs for the two package.json / CI shapes that
// blocked real repos on corpus6 (2026-09-05):
//   nestjs/nest  package.json "coverage" / "test:cov"
//                `vitest run --coverage --config vitest.config.coverage.mts || true`
//   trpc/trpc    .github/workflows/check-skills.yml:44
//                `OUTPUT=$(intent stale --json 2>&1) || true` … `echo "$OUTPUT" | node -e`
// and the one left blocking because it IS a swallow (defendant: the code):
//   trpc/trpc    .github/workflows/main.yml:154
//                `cp ./examples/${{ matrix.dir }}/.env.example … || true`
//
// Both downgrades are to WARNING, never silence: a coverage step that never
// fails and a captured-then-inspected exit code are both shapes where a dead
// command can read as clean (Doctrine §1), so the customer is still told.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BashSafetyModule = require('../src/modules/bash-safety');

async function scan(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bash-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const checks = [];
    const result = { checks, addCheck(name, passed, meta) { checks.push({ name, passed, ...(meta || {}) }); } };
    await new BashSafetyModule().run(result, { projectRoot: root });
    return checks.filter((c) => !c.passed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const names = (f) => f.map((c) => c.name).join(', ');
// The swallow finding on a line: pipe-true, or devnull-swallow when the line
// is `2>/dev/null || true` (reported once since 2026-10-03, not under both).
const pipeTrue = (f) => f.find((c) => /^bash-safety:(?:pipe-true|devnull-swallow):/.test(c.name));

describe('bash-safety — package.json: a coverage script declared non-fatal by its name', () => {
  const NEST = {
    test: 'vitest run',
    coverage: 'vitest run --coverage --config vitest.config.coverage.mts || true',
    'test:cov': 'vitest run --coverage --config vitest.config.coverage.mts || true',
  };

  it('NEGATIVE: nest "coverage" and "test:cov" are warnings — still reported, with the reason', async () => {
    const f = await scan({ 'package.json': JSON.stringify({ name: 'nest', scripts: NEST }) });
    for (const s of ['coverage', 'test:cov']) {
      const hit = f.find((c) => c.name === `bash-safety:pipe-true:package.json:${s}`);
      assert.ok(hit, `${s} must still be reported: ${names(f)}`);
      assert.equal(hit.severity, 'warning');
      assert.match(hit.message, /coverage step/);
    }
    assert.ok(!f.some((c) => c.severity === 'error'), names(f));
  });

  it('POSITIVE: "test" going green on red is still an error — the NAME governs, not --coverage', async () => {
    const f = await scan({ 'package.json': JSON.stringify({ name: 'x', scripts: {
      test: 'vitest run --coverage || true',
      build: 'tsc || true',
      'recover:db': 'node recover.js || true',
    } }) });
    for (const s of ['test', 'build', 'recover:db']) {
      const hit = f.find((c) => c.name === `bash-safety:pipe-true:package.json:${s}`);
      assert.ok(hit, `${s}: ${names(f)}`);
      assert.equal(hit.severity, 'error', s);
    }
  });
});

describe('bash-safety — `VAR=$(cmd) || true` whose output is inspected below', () => {
  const TRPC_CHECK_SKILLS = [
    'name: check-skills', 'on: push', 'jobs:', '  check:', '    runs-on: ubuntu-latest', '    steps:',
    '      - name: Check staleness', '        id: stale', '        run: |',
    '          OUTPUT=$(intent stale --json 2>&1) || true',
    '          echo "$OUTPUT"', '',
    '          # Check if any skills need review',
    '          NEEDS_REVIEW=$(echo "$OUTPUT" | node -e "console.log(1)")',
    '          if [ -z "$NEEDS_REVIEW" ]; then', '            echo "has_stale=false" >> "$GITHUB_OUTPUT"', '          fi', '',
  ].join('\n');

  it('NEGATIVE: trpc check-skills.yml:44 — warning, with the reason in the message', async () => {
    const f = await scan({ '.github/workflows/check-skills.yml': TRPC_CHECK_SKILLS });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'warning');
    assert.match(hit.message, /captured output is read below/);
  });

  it('POSITIVE: the same capture with nothing reading $OUT afterwards is an error', async () => {
    const f = await scan({ 'deploy.sh': '#!/bin/bash\nset -e\nOUT=$(node deploy.js) || true\necho "deployed"\n' });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });

  it('POSITIVE: a $VAR read in the NEXT YAML step does not count', async () => {
    const yml = [
      'jobs:', '  j:', '    steps:',
      '      - run: |', '          OUT=$(node deploy.js) || true',
      '      - run: echo "$OUT"', '',
    ].join('\n');
    const f = await scan({ '.github/workflows/a.yml': yml });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });

  it('POSITIVE: trpc main.yml:154 `cp … || true` is a real swallow — stays an error (defendant: code)', async () => {
    const yml = [
      'jobs:', '  e2e:', '    steps:',
      '      - run: pnpm build', '',
      '      - run: cp ./examples/${{ matrix.dir }}/.env.example ./examples/${{ matrix.dir }}/.env || true',
      '      - run: pnpm turbo --filter ./examples/${{ matrix.dir }} test-dev', '',
    ].join('\n');
    const f = await scan({ '.github/workflows/main.yml': yml });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });
});

describe('bash-safety — which files are shell is decided by src/core/shell-files.js (KI #106)', () => {
  // The module's private list was `['.sh', '.bash']`: no `.zsh`, and an
  // extensionless `bin/deploy` with `#!/usr/bin/env bash` on line one was
  // never opened at all. Control pair: the same body fires from `bin/deploy`
  // and from `x.zsh`, stays silent under `LICENSE` and under a node shebang.
  const DEPLOY = '#!/usr/bin/env bash\nset -e\nmake release || true\n';
  const swallowAt = (f, rel) => f.find((c) => c.name === `bash-safety:pipe-true:${rel}:3`);

  it('POSITIVE: extensionless bin/deploy with a bash shebang FIRES', async () => {
    const f = await scan({ 'bin/deploy': DEPLOY });
    const hit = swallowAt(f, 'bin/deploy');
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });

  it('POSITIVE: .zsh is scanned (it was not), and .sh still is', async () => {
    const f = await scan({ 'scripts/x.zsh': DEPLOY, 'scripts/y.sh': DEPLOY });
    assert.ok(swallowAt(f, 'scripts/x.zsh'), names(f));
    assert.ok(swallowAt(f, 'scripts/y.sh'), names(f));
  });

  it('NEGATIVE: the same bytes under LICENSE, or a node-shebang script, are not shell', async () => {
    const f = await scan({
      LICENSE: DEPLOY,
      'bin/cli': '#!/usr/bin/env node\n// noop\nrequire("child_process").execSync("rm -rf $DIR/ || true");\n',
    });
    assert.equal(f.length, 0, names(f));
  });
});

describe('bash-safety — `cmd || true` whose OUTCOME is tested on the next line', () => {
  // integrations/husky/pre-push:88-89, verbatim. The exit code is swallowed so
  // the hook can decide on the artefact instead — and it does, on the next line.
  const PRE_PUSH = [
    '#!/bin/sh', 'GATETEST_CACHE="$HOME/.gatetest/cache"',
    'if [ ! -d "$GATETEST_CACHE/.git" ]; then',
    '  mkdir -p "$(dirname "$GATETEST_CACHE")"',
    '  git clone --depth 1 https://github.com/crclabs-hq/gatetest.git "$GATETEST_CACHE" 2>/dev/null || true',
    '  if [ ! -d "$GATETEST_CACHE/.git" ]; then',
    '    echo "[GateTest] Clone unavailable — letting push through; CI gate is the source of truth."',
    '    exit 0', '  fi', '  exit 0', 'fi', '',
  ].join('\n');

  it('NEGATIVE: the pre-push clone is one warning, with the reason', async () => {
    const f = await scan({ '.githooks/pre-push': PRE_PUSH });
    const hits = f.filter((c) => /^bash-safety:(pipe-true|devnull-swallow):/.test(c.name));
    assert.equal(hits.length, 1, names(f));
    for (const h of hits) {
      assert.equal(h.severity, 'warning', h.name);
      assert.match(h.message, /outcome is tested on the next line/);
    }
  });

  it('POSITIVE: the same clone with nothing deciding on it afterwards is an error', async () => {
    const f = await scan({ 'setup.sh': '#!/bin/bash\ngit clone --depth 1 https://example.com/x.git "$DIR" 2>/dev/null || true\necho "ready"\ncd "$DIR"\n' });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });

  it('POSITIVE: a test further than three code lines down does not count', async () => {
    const f = await scan({ 'setup.sh': '#!/bin/bash\nmake build || true\necho a\necho b\necho c\nif [ -f out/bin ]; then echo ok; fi\n' });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });

  it('POSITIVE: integrations/husky/pre-push:97 — the capped cache refresh is a real swallow (defendant: code, suppressed in .gatetestignore with the reason)', async () => {
    const f = await scan({ 'hook.sh': '#!/bin/sh\n( cd "$C" && timeout 5 git pull --ff-only --depth 1 origin HEAD >/dev/null 2>&1 || true )\nexit 0\n' });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });
});

describe('bash-safety — every line of a multi-line `run: |` block is scanned (2026-09-05)', () => {
  // `_isInRunBlock` used to stop at the first line above that began with a
  // word character, so a `|| true` anywhere but the FIRST command of a step
  // was never seen — this repo's dogfood workflow carried two, and ci.yml
  // read as clean. Doctrine §1: a rule that scans one line per block and
  // reports nothing is reporting success while doing nothing.
  const WORKFLOW = [
    'name: x',
    'on: push',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: sweep',
    '        run: |',
    '          mkdir -p .out',                                                    // 9
    '          node run.js 2>&1 | tee .out/sweep.log || true',                  // 10 second line: was invisible
    '          if [ -s .out/sweep.log ]; then',
    '            node summarise.js .out/sweep.log || true',                     // 12 nested deeper than the `if`
    '          fi',
    '      - name: folded',
    '        run: >',
    '          node scan.js',
    '            > .out/scan.log 2>&1 || true',                                  // 17 continuation line, deeper than its head
    '      - name: not shell',
    '        with:',
    '          note: "|| true"',                                                 // 20 a `with:` value, not a run block
    '        env:',
    '          FLAG: cmd || true',                                                // 22 an env value, not a run block
    '      - run: cmd || true',                                                   // 23 single-line list-item run
    '',
  ].join('\n');

  it('POSITIVE: the second line, a nested line, a folded continuation and a one-line `- run:` all fire', async () => {
    const found = await scan({ '.github/workflows/x.yml': WORKFLOW });
    const lines = found.filter((c) => c.name.startsWith('bash-safety:pipe-true:')).map((c) => c.line).sort((a, b) => a - b);
    assert.deepStrictEqual(lines, [10, 12, 17, 23], names(found));
  });

  it('NEGATIVE: a `with:` value and an `env:` value are not shell — the same text there is silent', async () => {
    const found = await scan({ '.github/workflows/x.yml': WORKFLOW });
    const lines = found.map((c) => c.line);
    assert.ok(!lines.includes(20) && !lines.includes(22), names(found));
  });
});

describe('bash-safety — GT-13 (#771): `|| true` on a best-effort CI step is a warning, never blocking', () => {
  // AlecRae.com's CI had 18 blocking findings shaped like this: a step whose
  // name says it is best-effort infra (upload/artifact/cache/coverage/...)
  // is not the product's gate. Control pair from the issue: `npx codecov ||
  // true` under "Upload coverage" is quiet/warning; an unnamed `npm test ||
  // true` still fires as an error no matter what.
  const coverageStep = [
    'jobs:', '  ci:', '    steps:',
    '      - name: Upload coverage',
    '        run: npx codecov || true',
    '',
  ].join('\n');

  it('NEGATIVE: "Upload coverage" / `npx codecov || true` is a warning, with the reason', async () => {
    const f = await scan({ '.github/workflows/ci.yml': coverageStep });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'warning');
    assert.match(hit.message, /best-effort CI plumbing/);
  });

  it('POSITIVE: `npm test || true` still fires as an error, unnamed', async () => {
    const yml = ['jobs:', '  ci:', '    steps:', '      - run: npm test || true', ''].join('\n');
    const f = await scan({ '.github/workflows/ci.yml': yml });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });

  it('POSITIVE: the NAME does not override what the line runs — "Test and report" running npm test still gates', async () => {
    const yml = [
      'jobs:', '  ci:', '    steps:',
      '      - name: Test and report',
      '        run: npm test || true',
      '',
    ].join('\n');
    const f = await scan({ '.github/workflows/ci.yml': yml });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'error');
  });

  it('NEGATIVE: an `id:` naming the step best-effort also downgrades', async () => {
    const yml = [
      'jobs:', '  ci:', '    steps:',
      '      - id: notify-slack',
      '        run: curl -X POST slack.example/webhook || true',
      '',
    ].join('\n');
    const f = await scan({ '.github/workflows/ci.yml': yml });
    const hit = pipeTrue(f);
    assert.ok(hit, names(f));
    assert.equal(hit.severity, 'warning');
  });
});

describe('bash-safety — GT-13 (#771): the two shell shapes from AlecRae\'s own scripts', () => {
  // The 18 blocking findings the issue counted were mostly NOT in YAML: they
  // were `chmod 644 "$STATUS_FILE" 2>/dev/null || true` in three deploy-status
  // scripts (pipe-true + devnull-swallow, six findings) and `check_tcp … ||
  // true` in health-check.sh, where check_tcp itself calls check_fail on the
  // miss. Both stay REPORTED (warning); the controls that must stay blocking
  // are from the same scripts: `exec 9>"$LOCK_FILE" 2>/dev/null || true` in
  // auto-deploy.sh (the deploy then silently never runs) and `cp
  // "$MIG"/*.sql "$PROBE/" 2>/dev/null || true` in check-schema-drift.sh.
  const devnull = (f) => f.find((c) => c.name.startsWith('bash-safety:devnull-swallow:'));

  it('NEGATIVE: `chmod 644 "$STATUS_FILE" 2>/dev/null || true` is one warning, with the reason', async () => {
    const f = await scan({ 'scripts/check-deploy-drift.sh': 'set -e\nmv "$tmp" "$STATUS_FILE"\nchmod 644 "$STATUS_FILE" 2>/dev/null || true\n' });
    const d = devnull(f);
    assert.ok(d, names(f));
    assert.ok(!f.some((c) => c.name.startsWith('bash-safety:pipe-true:')), names(f));
    assert.equal(d.severity, 'warning');
    assert.match(d.message, /chmod only changes file metadata/);
  });

  it('POSITIVE: `exec 9>"$LOCK_FILE" 2>/dev/null || true` (lock never taken, deploy silently skipped) stays an error', async () => {
    const f = await scan({ 'scripts/auto-deploy.sh': 'set -e\nexec 9>"$LOCK_FILE" 2>/dev/null || true\nif ! flock -n 9; then exit 0; fi\n' });
    const d = devnull(f);
    assert.ok(d, names(f));
    assert.equal(d.severity, 'error');
  });

  it('POSITIVE: `cp "$MIG"/*.sql "$PROBE/" 2>/dev/null || true` (the probe then diffs against nothing) stays an error', async () => {
    const f = await scan({ 'scripts/check-schema-drift.sh': 'set -e\ncp "$MIG"/*.sql "$PROBE/" 2>/dev/null || true\n' });
    const p = pipeTrue(f);
    assert.ok(p, names(f));
    assert.equal(p.severity, 'error');
  });

  const healthCheck = [
    '#!/usr/bin/env bash', 'set -e',
    'check_fail() { echo "  FAIL: $1" >&2; FAILED=1; }',
    'check_tcp() {',
    '    local host="$1" port="$2" name="$3"',
    '    if timeout 3 bash -c "echo >/dev/tcp/${host}/${port}" 2>/dev/null; then',
    '        return 0',
    '    else',
    '        check_fail "${name} — ${host}:${port} is not reachable"',
    '        return 1',
    '    fi',
    '}',
    'check_tcp "$MTA_HOST" 25 "MTA (SMTP/25)" || true',
    '',
  ].join('\n');

  it('NEGATIVE: `check_tcp … || true` where check_tcp prints its own verdict is a warning', async () => {
    const f = await scan({ 'infrastructure/scripts/health-check.sh': healthCheck });
    const p = pipeTrue(f);
    assert.ok(p, names(f));
    assert.equal(p.severity, 'warning');
    assert.match(p.message, /check_tcp is defined in this file and prints its own verdict/);
  });

  it('POSITIVE: a same-file function that reports nothing (`deploy() { ssh box git pull; }`) stays an error', async () => {
    const f = await scan({ 'scripts/deploy.sh': 'set -e\ndeploy() {\n    ssh box "cd /opt/app && git pull"\n}\ndeploy || true\n' });
    const p = pipeTrue(f);
    assert.ok(p, names(f));
    assert.equal(p.severity, 'error');
  });

  it('POSITIVE: a function that is only CALLED here (defined in a sourced file) stays an error', async () => {
    const f = await scan({ 'scripts/probe.sh': 'set -e\nsource ./lib.sh\ncheck_tcp "$HOST" 25 || true\n' });
    const p = pipeTrue(f);
    assert.ok(p, names(f));
    assert.equal(p.severity, 'error');
  });
});

describe('bash-safety — `VAR=$(cmd || true)` is the capture shape too (2026-09-05)', () => {
  // ktor switch-base-branch.sh:133 — the `|| true` sits INSIDE the
  // substitution; the exit status is traded for the output exactly as in
  // `VAR=$(cmd) || true`, and `$origin_url` is read on the next lines.
  const CAPTURE = 'origin_url=$(git remote get-url "$ORIGIN_REMOTE" 2> /dev/null || true)';

  it('NEGATIVE: read below — a warning with the reason', async () => {
    const found = await scan({ 'switch.sh': ['#!/bin/bash', CAPTURE, 'if [ -z "$origin_url" ]; then echo none; fi', ''].join('\n') });
    const c = pipeTrue(found);
    assert.ok(c, names(found));
    assert.strictEqual(c.severity, 'warning');
    assert.match(c.message, /captured output is read below/);
  });

  it('POSITIVE: nothing reads it — an error', async () => {
    const found = await scan({ 'switch.sh': ['#!/bin/bash', CAPTURE, 'echo done', ''].join('\n') });
    const c = pipeTrue(found);
    assert.ok(c, names(found));
    assert.strictEqual(c.severity, 'error');
  });
});
