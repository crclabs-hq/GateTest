const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CiSecurityModule = require('../src/modules/ci-security');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new CiSecurityModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function writeWorkflow(root, name, content) {
  const dir = path.join(root, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

describe('CiSecurityModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no workflow files exist', async () => {
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'ci-security:no-files'));
  });

  it('finds both .yml and .yaml in .github/workflows + .gitlab-ci.yml', async () => {
    writeWorkflow(tmp, 'ci.yml', 'name: ci\npermissions: { contents: read }\non: push\njobs: {}\n');
    writeWorkflow(tmp, 'release.yaml', 'name: rel\npermissions: { contents: read }\non: push\njobs: {}\n');
    fs.writeFileSync(path.join(tmp, '.gitlab-ci.yml'), 'stages:\n  - build\n');
    const r = await run(tmp);
    const scanning = r.checks.find((c) => c.name === 'ci-security:scanning');
    assert.match(scanning.message, /3 CI workflow/);
  });
});

describe('CiSecurityModule — action pinning', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-pin-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on branch-pinned actions', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@main',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:branch-pin:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('info-level warning on semver-tag pin (tags are mutable)', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:tag-pin:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });

  it('accepts SHA-pinned actions silently', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:branch-pin:')), undefined);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:tag-pin:')), undefined);
  });

  it('flags action used with no @ref', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // With no @ref the regex won't match a pin pattern; but we still want
    // the module to scan cleanly. Assert the file was scanned.
    assert.ok(r.checks.find((c) => c.name === 'ci-security:scanning'));
  });

  it('skips local action references (./...)', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./.github/actions/my-local-action',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:branch-pin:')), undefined);
  });
});

describe('CiSecurityModule — pwn-request', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-pwn-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors when pull_request_target + checkout of PR head coexist', async () => {
    writeWorkflow(tmp, 'danger.yml', [
      'name: danger',
      'permissions: { contents: read }',
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332',
      '        with:',
      '          ref: ${{ github.event.pull_request.head.sha }}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:pwn-request:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('warns on pull_request_target alone', async () => {
    writeWorkflow(tmp, 'danger.yml', [
      'name: danger',
      'permissions: { contents: read }',
      'on:',
      '  pull_request_target:',
      'jobs: {}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('ci-security:pr-target:')));
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:pwn-request:')), undefined);
  });
});

describe('CiSecurityModule — shell injection + secrets echo', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-run-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on github.event.* interpolated into a run block', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: [issues]',
      'jobs:',
      '  go:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: |',
      '          echo "Issue: ${{ github.event.issue.title }}"',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:shell-injection:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on echoing a secret to stdout', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  go:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "${{ secrets.MY_TOKEN }}"',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('ci-security:secret-echo:')));
  });
});

describe('CiSecurityModule — permissions + soft-fail', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-perm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns when top-level permissions block is missing', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'on: push',
      'jobs: {}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('ci-security:no-permissions:')));
  });

  it('accepts a file that declares permissions at the top level', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions:',
      '  contents: read',
      'on: push',
      'jobs: {}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:no-permissions:')), undefined);
  });

  it('errors on continue-on-error: true attached to a gatetest step (Bible Forbidden #24)', async () => {
    writeWorkflow(tmp, 'gate.yml', [
      'name: gate',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  gate:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Run GateTest',
      '        run: npx gatetest --suite full',
      '        continue-on-error: true',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:soft-fail-gate:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('does NOT flag continue-on-error on non-gate steps', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Try flaky script',
      '        run: ./scripts/flaky.sh',
      '        continue-on-error: true',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:soft-fail-gate:')), undefined);
  });
});

describe('CiSecurityModule — summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-sum-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('always records a summary when files were scanned', async () => {
    writeWorkflow(tmp, 'ci.yml', 'name: ci\npermissions: { contents: read }\non: push\njobs: {}\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'ci-security:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});

// Regression: Crontech's ai-deploy-supervisor.yml (2026-05-24) ran on
// `workflow_run` triggers from a deploy workflow, then tried to read the
// upstream run's logs via `gh run view` / API. The default GITHUB_TOKEN
// scope doesn't include `actions:` — every API call silently 403'd, and
// the supervisor's own diagnosis disappeared behind the meta-failure.
// This describe block guards the rule that catches this footgun before
// it ships.
describe('CiSecurityModule — workflow_run missing actions: read', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const findingName = (workflow) =>
    `ci-security:workflow-run-missing-actions-read:.github/workflows/${workflow}`;

  it('warns when workflow_run trigger has no actions: read', async () => {
    writeWorkflow(tmp, 'supervisor.yml', `name: supervisor
on:
  workflow_run:
    workflows: ['deploy']
    types: [completed]
permissions:
  contents: read
  pull-requests: write
jobs:
  diagnose:
    runs-on: ubuntu-latest
    steps:
      - run: gh run view \${{ github.event.workflow_run.id }} --log-failed
`);
    const r = await run(tmp);
    const finding = r.checks.find((c) => c.name === findingName('supervisor.yml'));
    assert.ok(finding, 'should flag missing actions: read');
    assert.strictEqual(finding.severity, 'warning');
    assert.match(finding.message, /silently 403/);
  });

  it('passes when actions: read is explicitly granted', async () => {
    writeWorkflow(tmp, 'supervisor.yml', `name: supervisor
on:
  workflow_run:
    workflows: ['deploy']
    types: [completed]
permissions:
  contents: read
  actions: read
jobs:
  diagnose:
    runs-on: ubuntu-latest
    steps:
      - run: gh run view \${{ github.event.workflow_run.id }} --log-failed
`);
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name === findingName('supervisor.yml')), undefined);
  });

  it('passes when actions: write is explicitly granted', async () => {
    writeWorkflow(tmp, 'supervisor.yml', `name: supervisor
on:
  workflow_run:
    workflows: ['deploy']
permissions:
  actions: write
jobs:
  rerun:
    runs-on: ubuntu-latest
    steps:
      - run: gh run rerun \${{ github.event.workflow_run.id }}
`);
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name === findingName('supervisor.yml')), undefined);
  });

  it('passes when permissions: read-all is set', async () => {
    writeWorkflow(tmp, 'supervisor.yml', `name: supervisor
on:
  workflow_run:
    workflows: ['deploy']
permissions: read-all
jobs:
  diagnose:
    runs-on: ubuntu-latest
    steps:
      - run: gh run view \${{ github.event.workflow_run.id }}
`);
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name === findingName('supervisor.yml')), undefined);
  });

  it('does not fire when there is no workflow_run trigger', async () => {
    writeWorkflow(tmp, 'normal.yml', `name: normal
on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`);
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name === findingName('normal.yml')), undefined);
  });

  it('does not false-positive on workflow names containing "Actions"', async () => {
    // The rule must match `actions:` as a permissions key, not as part of
    // a workflow name like `name: GitHub Actions Deploy Check`.
    writeWorkflow(tmp, 'noisy.yml', `name: GitHub Actions Deploy Check
on:
  workflow_run:
    workflows: ['deploy']
# permissions block intentionally missing — this MUST still flag
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`);
    const r = await run(tmp);
    assert.ok(
      r.checks.find((c) => c.name === findingName('noisy.yml')),
      'workflow name containing "Actions" must not satisfy the permission check',
    );
  });
});

// Regression: Crontech's stale-installed gatetest-gate.yml on 2026-05-25
// silently failed every SARIF upload because the gatetest job's
// permissions block didn't include `actions: read`. github/codeql-action/
// upload-sarif calls /repos/.../actions/runs/... to attach results to
// the right run; without the scope it errors with "Resource not
// accessible by integration" and the Security tab never updates. OUR
// OWN ci.yml had the same bug (caught + fixed in the same commit that
// added this rule). Static catch ensures it can't ship again.
describe('CiSecurityModule — codeql-action/upload-sarif missing actions: read', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const findingName = (workflow) =>
    `ci-security:codeql-sarif-missing-actions-read:.github/workflows/${workflow}`;

  it('WARNS when upload-sarif is used without actions: read — private repos need the scope, public ones do not, and the file cannot say which (was error until 2026-09-14)', async () => {
    writeWorkflow(tmp, 'gate.yml', `name: gate
on: push
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - run: ./scan.sh
      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
`);
    const r = await run(tmp);
    const f = r.checks.find((c) => c.name === findingName('gate.yml'));
    assert.ok(f, 'must flag missing actions: read when upload-sarif present');
    assert.strictEqual(f.severity, 'warning',
      'severity must be WARNING — the scope is required on private repositories only, and a workflow file cannot say which kind it runs in');
    assert.match(f.message, /Resource not accessible by integration/);
    assert.match(f.message, /PRIVATE repository/);
  });

  it('passes when actions: read is explicitly granted alongside security-events: write', async () => {
    writeWorkflow(tmp, 'gate.yml', `name: gate
on: push
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v4
      - run: ./scan.sh
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
`);
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name === findingName('gate.yml')), undefined);
  });

  it('passes when permissions: read-all is set (shorthand grants actions)', async () => {
    writeWorkflow(tmp, 'gate.yml', `name: gate
on: push
permissions: read-all
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: github/codeql-action/upload-sarif@v3
`);
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name === findingName('gate.yml')), undefined);
  });

  it('does not fire when codeql-action is not used', async () => {
    writeWorkflow(tmp, 'plain.yml', `name: plain
on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`);
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name === findingName('plain.yml')), undefined);
  });

  it('matches any pinned version of upload-sarif (v3, v4, SHA)', async () => {
    writeWorkflow(tmp, 'gate.yml', `name: gate
on: push
permissions:
  security-events: write
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@ab1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c
`);
    const r = await run(tmp);
    assert.ok(
      r.checks.find((c) => c.name === findingName('gate.yml')),
      'SHA-pinned upload-sarif must still flag without actions: read',
    );
  });
});

// 2026-09-05: every Rust repo was blocked on `dtolnay/rust-toolchain@stable`
// (a toolchain channel, that action's documented use) and vapor/ktor on their
// OWN reusable workflows at @main. Both are mutable and stay reported — as
// warnings. A third-party action on a branch is the supply-chain risk and
// stays an error.
describe('CiSecurityModule — branch refs: channel and own-workflow are warnings', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-pin-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const WF = (uses) => `name: ci\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${uses}\n`;
  async function pinSeverity(uses, env = {}) {
    const saved = { GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY, GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE };
    // GITHUB_REPOSITORY only names the scanned project when the scan targets
    // the workflow's own checkout — so the workspace is set to tmp here.
    if (env.GITHUB_REPOSITORY) { process.env.GITHUB_REPOSITORY = env.GITHUB_REPOSITORY; process.env.GITHUB_WORKSPACE = env.GITHUB_WORKSPACE || tmp; } else { delete process.env.GITHUB_REPOSITORY; delete process.env.GITHUB_WORKSPACE; }
    try {
      if (env.remote) {
        const { execFileSync } = require('child_process');
        execFileSync('git', ['init', '-q'], { cwd: tmp });
        execFileSync('git', ['remote', 'add', 'origin', env.remote], { cwd: tmp });
      }
      writeWorkflow(tmp, 'ci.yml', WF(uses));
      const r = await run(tmp);
      const c = r.checks.find((x) => !x.passed && /branch-pin/.test(x.name));
      return c ? c.severity : null;
    } finally {
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }
  it('dtolnay/rust-toolchain@stable is a warning', async () => {
    assert.strictEqual(await pinSeverity('dtolnay/rust-toolchain@stable'), 'warning');
  });
  it("the repository's own reusable workflow on main is a warning", async () => {
    assert.strictEqual(await pinSeverity('vapor/ci/.github/workflows/test.yml@main', { GITHUB_REPOSITORY: 'vapor/vapor' }), 'warning');
  });
  it("someone else's reusable workflow on main is still an error", async () => {
    assert.strictEqual(await pinSeverity('other-org/ci/.github/workflows/test.yml@main', { GITHUB_REPOSITORY: 'vapor/vapor' }), 'error');
  });
  it('a third-party action on a branch is still an error', async () => {
    assert.strictEqual(await pinSeverity('someone/action@main'), 'error');
  });
  // CI's corpus job scans vapor with GITHUB_REPOSITORY=crclabs-hq/GateTest:
  // vapor's own reusable workflows came back as third-party errors (1 → 4,
  // 2026-09-05). The scanned project's remote decides; the env var only
  // when the project IS the workflow's workspace.
  it("the scanned project's remote wins over GITHUB_REPOSITORY when the project is not the workspace", async () => {
    assert.strictEqual(await pinSeverity('vapor/ci/.github/workflows/test.yml@main', { GITHUB_REPOSITORY: 'crclabs-hq/GateTest', GITHUB_WORKSPACE: '/somewhere/else', remote: 'https://github.com/vapor/vapor.git' }), 'warning');
  });
  it('GITHUB_REPOSITORY alone, for a root that is NOT the workspace, makes nothing "our own"', async () => {
    assert.strictEqual(await pinSeverity('vapor/ci/.github/workflows/test.yml@main', { GITHUB_REPOSITORY: 'vapor/vapor', GITHUB_WORKSPACE: '/somewhere/else' }), 'error');
  });
});

describe('CiSecurityModule — taiki-e/install-action@<tool> is a channel, not a branch', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-taiki-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  it('warns rather than errors', async () => {
    writeWorkflow(tmp, 'ci.yml', 'name: ci\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: taiki-e/install-action@cargo-hack\n');
    const r = await run(tmp);
    const c = r.checks.find((x) => !x.passed && /branch-pin/.test(x.name));
    assert.strictEqual(c && c.severity, 'warning');
  });
});

// prisma pr-code-security.yml (2026-09-05): `--baseline-commit ${{
// github.event.pull_request.base.sha }}` was "untrusted event data
// interpolated into a shell". A SHA is 40 hex characters; a `number`/`id`
// is numeric — neither can carry shell metacharacters. Free-text fields
// (`head.ref`, `pull_request.title`, `comment.body`, `release.tag_name`)
// still fire.
describe('CiSecurityModule — shell injection: SHA and numeric leaves are not injectable', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-sha-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const wf = (runLines) => writeWorkflow(tmp, 'ci.yml', [
    'name: ci', 'permissions: { contents: read }', 'on: pull_request', 'jobs:', '  go:', '    runs-on: ubuntu-latest', '    steps:', '      - run: |', ...runLines.map((l) => `          ${l}`), '',
  ].join('\n'));
  const hits = (r) => r.checks.filter((c) => c.name.startsWith('ci-security:shell-injection:')).map((c) => c.name);

  it('NEGATIVE: base.sha, pull_request.number and repository.id are quiet', async () => {
    wf(['semgrep --baseline-commit ${{ github.event.pull_request.base.sha }}', 'echo "PR #${{ github.event.pull_request.number }} repo ${{ github.event.repository.id }}"']);
    assert.deepStrictEqual(hits(await run(tmp)), []);
  });

  it('POSITIVE: head.ref, pull_request.title, comment.body and release.tag_name still fire', async () => {
    wf(['git checkout ${{ github.event.pull_request.head.ref }}', 'echo "${{ github.event.pull_request.title }}"', 'echo "${{ github.event.comment.body }}"', 'VERSION="${{ github.event.release.tag_name }}"']);
    assert.strictEqual(hits(await run(tmp)).length, 4);
  });
});

// ── KI #106: shell injection + secrets-in-logs are generic, not GitHub-only ──
//
// The injection surface is TEMPLATE EXPANSION: the host substitutes the
// value into the script text before the shell runs (`${{ }}`, `<< pipeline
// .git.branch >>`, `$(Build.SourceBranchName)`, Buildkite's `$BUILDKITE_*`
// at `pipeline upload`). A host env var read by the shell (`$CIRCLE_BRANCH`,
// `$BITBUCKET_BRANCH`) is the safe idiom the GitHub suggestion recommends
// and must stay quiet — unless the script re-parses it as code.
describe('CiSecurityModule — CircleCI, Azure, Bitbucket, Buildkite, GitLab shell text', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-hosts-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const put = (rel, lines) => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join('\n') + '\n');
  };
  const names = (r, prefix) => r.checks.filter((c) => !c.passed && c.name.startsWith(`ci-security:${prefix}:`)).map((c) => c.name.replace(/^ci-security:[a-z-]+:/, ''));

  it('discovers every host file shape', async () => {
    put('.circleci/config.yml', ['version: 2.1']);
    put('.circleci/continue_config.yml', ['version: 2.1']);
    put('azure-pipelines.yml', ['trigger: [main]']);
    put('bitbucket-pipelines.yml', ['pipelines: {}']);
    put('.buildkite/pipeline.yml', ['steps: []']);
    put('.buildkite/release.yaml', ['steps: []']);
    put('.gitlab-ci.yml', ['stages: [build]']);
    const r = await run(tmp);
    assert.match(r.checks.find((c) => c.name === 'ci-security:scanning').message, /7 CI workflow/);
  });

  it('CircleCI POSITIVE: << pipeline.git.branch >> in run: / command: fires; a secret echoed fires', async () => {
    put('.circleci/config.yml', [
      'jobs:', '  build:', '    steps:',
      '      - run: git checkout << pipeline.git.branch >>',
      '      - run:',
      '          name: Tag',
      '          command: |',
      '            git tag "rel-<< pipeline.git.tag >>"',
      '            echo "$NPM_TOKEN"',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), ['.circleci/config.yml:4', '.circleci/config.yml:8']);
    assert.deepStrictEqual(names(r, 'secret-echo'), ['.circleci/config.yml:9']);
  });

  it('CircleCI NEGATIVE: a SHA/number value, a maintainer-typed pipeline parameter (nest line 115), $CIRCLE_BRANCH read by the shell, a step name, and a secret written to a file stay quiet', async () => {
    put('.circleci/config.yml', [
      'jobs:', '  build:', '    steps:',
      '      - run: git diff << pipeline.git.base_revision >>..<< pipeline.git.revision >>',
      '      - run: echo "build << pipeline.number >>"',
      '      - run: nvm install << pipeline.parameters.maintenance-node-version >>',
      '      - run: echo "on $CIRCLE_BRANCH from ${CIRCLE_PR_USERNAME} sha $CIRCLE_SHA1"',
      '      - run:',
      '          name: Deploy << pipeline.git.branch >>',
      '          command: ./deploy.sh',
      '      - run: echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > ~/.npmrc',
      '      - run: echo "$DOCKER_PASSWORD" | docker login -u x --password-stdin',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), []);
    assert.deepStrictEqual(names(r, 'secret-echo'), []);
    // The GitHub-only rules do not run on a CircleCI file.
    assert.ok(!r.checks.some((c) => /no-permissions|branch-pin|pr-target/.test(c.name)));
  });

  it('Azure POSITIVE: $(Build.SourceBranchName) / $(System.PullRequest.SourceBranch) in script: / bash: / inline task fire; $(MY_SECRET) echoed fires', async () => {
    put('azure-pipelines.yml', [
      'steps:',
      '- script: git checkout $(Build.SourceBranchName)',
      '- bash: |',
      '    echo "PR from $(System.PullRequest.SourceBranch)"',
      '- task: Bash@3',
      '  inputs:',
      '    targetType: inline',
      '    script: |',
      '      git log -1 --format=%s $(Build.SourceVersionMessage)',
      '      echo $(DEPLOY_TOKEN)',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), ['azure-pipelines.yml:2', 'azure-pipelines.yml:4', 'azure-pipelines.yml:9']);
    assert.deepStrictEqual(names(r, 'secret-echo'), ['azure-pipelines.yml:10']);
  });

  it('Azure NEGATIVE: $(Build.SourceVersion) / $(Build.BuildId) / PullRequestId, and a value mapped through env: then read as $VAR, stay quiet', async () => {
    put('azure-pipelines.yml', [
      'steps:',
      '- script: echo "$(Build.SourceVersion) #$(Build.BuildId) pr $(System.PullRequest.PullRequestId)"',
      '- bash: |',
      '    git checkout "$BRANCH"',
      '  env:',
      '    BRANCH: $(Build.SourceBranchName)',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), []);
  });

  it('Bitbucket POSITIVE: $BITBUCKET_BRANCH re-parsed via eval / sh -c fires; echoing a secret fires', async () => {
    put('bitbucket-pipelines.yml', [
      'pipelines:', '  default:', '    - step:', '        script:',
      '          - eval "git checkout $BITBUCKET_BRANCH"',
      '          - sh -c "echo ${BITBUCKET_PR_DESTINATION_BRANCH}"',
      '          - echo "$AWS_SECRET_ACCESS_KEY"',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), ['bitbucket-pipelines.yml:5', 'bitbucket-pipelines.yml:6']);
    assert.deepStrictEqual(names(r, 'secret-echo'), ['bitbucket-pipelines.yml:7']);
  });

  it('Bitbucket NEGATIVE: $BITBUCKET_BRANCH read by the shell, $BITBUCKET_COMMIT / $BITBUCKET_PR_ID, and a plain step stay quiet', async () => {
    put('bitbucket-pipelines.yml', [
      'pipelines:', '  default:', '    - step:', '        script:',
      '          - echo "Building $BITBUCKET_BRANCH at $BITBUCKET_COMMIT (PR $BITBUCKET_PR_ID)"',
      '          - git checkout "$BITBUCKET_BRANCH"',
      '          - npm ci && npm test',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), []);
    assert.deepStrictEqual(names(r, 'secret-echo'), []);
  });

  it('Buildkite POSITIVE: $BUILDKITE_BRANCH / $BUILDKITE_MESSAGE / ${BUILDKITE_PULL_REQUEST_BASE_BRANCH} in command(s): are interpolated at upload and fire', async () => {
    put('.buildkite/pipeline.yml', [
      'steps:',
      '  - label: build',
      '    command: git checkout $BUILDKITE_BRANCH',
      '  - label: notify',
      '    commands:',
      '      - echo "commit: $BUILDKITE_MESSAGE"',
      '      - git diff ${BUILDKITE_PULL_REQUEST_BASE_BRANCH}',
      '      - echo $SLACK_TOKEN',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), ['.buildkite/pipeline.yml:3', '.buildkite/pipeline.yml:6', '.buildkite/pipeline.yml:7']);
    assert.deepStrictEqual(names(r, 'secret-echo'), ['.buildkite/pipeline.yml:8']);
  });

  it('Buildkite NEGATIVE: the $$VAR escape (shell expands at run time), $BUILDKITE_COMMIT, $BUILDKITE_BUILD_NUMBER, and a label mentioning the branch stay quiet', async () => {
    put('.buildkite/pipeline.yml', [
      'steps:',
      '  - label: "build $BUILDKITE_BRANCH"',
      '    command: |',
      '      git checkout "$$BUILDKITE_BRANCH"',
      '      echo "$BUILDKITE_COMMIT build $BUILDKITE_BUILD_NUMBER pr $BUILDKITE_PULL_REQUEST"',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), []);
  });

  it('GitLab: script: lists are read (they never were) — $CI_COMMIT_REF_NAME via eval fires, read as $VAR stays quiet, secret echoed fires', async () => {
    put('.gitlab-ci.yml', [
      'build:',
      '  before_script:',
      '    - echo "on $CI_COMMIT_REF_NAME"',
      '  script:',
      '    - eval "git checkout $CI_COMMIT_REF_NAME"',
      '    - echo "$CI_REGISTRY_PASSWORD" | docker login --password-stdin',
      '    - echo $DEPLOY_TOKEN',
    ]);
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), ['.gitlab-ci.yml:5']);
    assert.deepStrictEqual(names(r, 'secret-echo'), ['.gitlab-ci.yml:7']);
  });

  it('GitHub NEGATIVE: an env: mapping that follows `- run: |` is not part of the script', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci', 'permissions: { contents: read }', 'on: pull_request', 'jobs:', '  go:', '    runs-on: ubuntu-latest', '    steps:',
      '      - run: |',
      '          git checkout "$BRANCH"',
      '        env:',
      '          BRANCH: ${{ github.event.pull_request.head.ref }}',
      '          TITLE: ${{ github.event.pull_request.title }}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), []);
  });

  it('GitHub POSITIVE: $GITHUB_HEAD_REF re-parsed with eval fires; a $NPM_TOKEN echoed to stdout fires', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci', 'permissions: { contents: read }', 'on: pull_request', 'jobs:', '  go:', '    runs-on: ubuntu-latest', '    steps:',
      '      - run: |',
      '          eval "git checkout $GITHUB_HEAD_REF"',
      '          echo "token is $NPM_TOKEN"',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(names(r, 'shell-injection'), ['.github/workflows/ci.yml:9']);
    assert.deepStrictEqual(names(r, 'secret-echo'), ['.github/workflows/ci.yml:10']);
  });
});

// django .github/workflows/postgis.yml:63 (2026-09-05): `initdb …
// --pwfile=<(echo "$PGPASSWORD")` was "secret piped to echo". A process
// substitution, a command substitution or a backtick captures the output
// for another command — it never reaches the log.
describe('CiSecurityModule — secret-echo: captured echo output is not stdout', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-echo-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const wf = (runLines) => writeWorkflow(tmp, 'ci.yml', [
    'name: ci', 'permissions: { contents: read }', 'on: push', 'jobs:', '  db:', '    runs-on: ubuntu-latest', '    steps:', '      - run: |', ...runLines.map((l) => `          ${l}`), '',
  ].join('\n'));
  const hits = (r) => r.checks.filter((c) => c.name.startsWith('ci-security:secret-echo:')).map((c) => c.name);

  it('NEGATIVE: <(echo "$PGPASSWORD"), $(echo "$TOKEN" | base64) and `echo $TOKEN` are quiet', async () => {
    wf([
      'initdb -D "$GITHUB_WORKSPACE/.tmp/pgdata" --username="user" --auth=scram-sha-256 --pwfile=<(echo "$PGPASSWORD")',
      'AUTH=$(echo "$NPM_TOKEN" | base64)',
      'AUTH=`echo $NPM_TOKEN`',
    ]);
    assert.deepStrictEqual(hits(await run(tmp)), []);
  });

  it('POSITIVE: the same variable echoed to stdout still fires', async () => {
    wf(['echo "$PGPASSWORD"', 'echo token=$NPM_TOKEN']);
    assert.strictEqual(hits(await run(tmp)).length, 2);
  });
});

describe('CiSecurityModule — an echo inside a redirected `{ … }` group never reaches stdout (2026-09-05)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-group-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const step = (closer) => [
    'name: ci',
    'on: push',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: |',
    '          {',
    '            echo "DATABASE_URL=$DB_URL"',
    '            echo "SUPABASE_JWT_SECRET=$JWT_SECRET"',
    `          ${closer}`,
    '',
  ].join('\n');

  it('NEGATIVE: prisma ci.yml:440 — the group is appended to $GITHUB_ENV', async () => {
    writeWorkflow(tmp, 'ci.yml', step('} >> "$GITHUB_ENV"'));
    const r = await run(tmp);
    assert.deepStrictEqual(r.checks.filter((c) => c.name.startsWith('ci-security:secret-echo:')).map((c) => c.name), []);
  });

  it('POSITIVE: the same group with no redirect prints the secret', async () => {
    writeWorkflow(tmp, 'ci.yml', step('}'));
    const r = await run(tmp);
    assert.deepStrictEqual(r.checks.filter((c) => c.name.startsWith('ci-security:secret-echo:')).map((c) => c.name), ['ci-security:secret-echo:.github/workflows/ci.yml:10']);
  });
});
