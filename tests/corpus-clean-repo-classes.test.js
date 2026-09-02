// =============================================================================
// CORPUS GATE — false-positive classes found on the six CLEAN repos, 2026-09-02
// =============================================================================
// First automated run of scripts/corpus-gate.js. Every relaxation below was
// measured on a real third-party repo and carries its still-fires half, so a
// widened exclusion is distinguishable from a rule that stopped working.
//
//   hardcodedUrl   axios: bare `http://localhost` as a URL-parse base
//   ciSecurity     fastify: `${{ github.event.pull_request.base.sha }}`
//   prSize         axios: a pinned commit ON main sized as a 52,447-line PR
//   bundleSize     lodash: committed dist/lodash.js graded as a page bundle
//   documentation  lodash: README lacking a "usage" section BLOCKED the gate
//   links          chalk/axios/fastify/lodash: `string,`, `LINK`,
//                  `sponsor.imageUrl`, `www.websitename.com`, ../node_modules
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-clean-classes-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}
function result() {
  return { checks: [], addCheck(name, passed, meta) { this.checks.push({ name, passed, ...(meta || {}) }); }, addInfo() {} };
}
async function runModule(Module, files, opts = {}) {
  const root = repo(files);
  try {
    const r = result();
    await new Module().run(r, { projectRoot: root, ...opts });
    return r.checks.filter((c) => !c.passed);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const errors = (checks) => checks.filter((c) => (c.severity || 'error') === 'error');

describe('hardcodedUrl — a bare http://localhost is a URL-parse base, not an endpoint', () => {
  const HardcodedUrl = require('../src/modules/hardcoded-url');
  it('silent on the axios idioms', async () => {
    const f = await runModule(HardcodedUrl, {
      'lib/a.js': "const origin = (hasBrowserEnv && window.location.href) || 'http://localhost';\n",
      'lib/b.js': "const u = new URL(path, 'http://localhost');\n",
      'lib/c.js': "const base = isAbsolute ? path : 'http://localhost/';\n",
    });
    assert.deepStrictEqual(f.filter((c) => /localhost/.test(c.name)), []);
  });
  it('NEGATIVE CONTROL: a port or a path still fires', async () => {
    const f = await runModule(HardcodedUrl, {
      'lib/a.js': "const API = 'http://localhost:3000';\n",
      'lib/b.js': "const HOOK = 'http://localhost/api/hook';\n",
    });
    assert.strictEqual(f.filter((c) => /localhost/.test(c.name)).length, 2);
  });
});

describe('ciSecurity — commit SHAs and numbers from the event are not injectable', () => {
  const CiSecurity = require('../src/modules/ci-security');
  const wf = (line) => ['on: pull_request', 'jobs:', '  j:', '    runs-on: ubuntu-latest', '    steps:', '      - run: |', `          ${line}`, ''].join('\n');
  it('silent on the fastify case (base.sha / head.sha into git diff)', async () => {
    const f = await runModule(CiSecurity, { '.github/workflows/w.yml': wf('git diff --name-only "${{ github.event.pull_request.base.sha }}" "${{ github.event.pull_request.head.sha }}"') });
    assert.deepStrictEqual(f.filter((c) => /shell-injection/.test(c.name)), []);
  });
  it('silent on a PR number', async () => {
    const f = await runModule(CiSecurity, { '.github/workflows/w.yml': wf('gh pr view ${{ github.event.pull_request.number }}') });
    assert.deepStrictEqual(f.filter((c) => /shell-injection/.test(c.name)), []);
  });
  it('NEGATIVE CONTROL: a title, a branch name, or head_ref still fires', async () => {
    for (const line of [
      'echo "${{ github.event.pull_request.title }}"',
      'git checkout ${{ github.event.pull_request.head.ref }}',
      'echo ${{ github.head_ref }}',
      'echo "${{ github.event.pull_request.base.sha }}" "${{ github.event.issue.body }}"',
    ]) {
      const f = await runModule(CiSecurity, { '.github/workflows/w.yml': wf(line) });
      assert.ok(f.some((c) => /shell-injection/.test(c.name)), `must fire on: ${line}`);
    }
  });
});

describe('prSize — a commit already on the base branch is not a pull request', () => {
  const PrSize = require('../src/modules/pr-size');
  function gitRepo() {
    const root = repo({ 'a.js': 'x\n' });
    const git = (c) => execSync(`git ${c}`, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init -q -b main'); git('add -A'); git('commit -qm one');
    fs.writeFileSync(path.join(root, 'big.js'), Array.from({ length: 1500 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n');
    git('add -A'); git('commit -qm two');
    // A remote whose default branch carries these commits — the corpus
    // shape (pinned checkout of a pushed commit), and any CI scan of main.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-clean-classes-remote-'));
    execSync('git init -q --bare -b main', { cwd: remote, stdio: 'pipe' });
    git(`remote add origin ${remote}`); git('push -q origin main'); git('remote set-head origin main');
    return { root, git, remote };
  }
  it('HEAD already on the remote default branch → no PR → no size findings', async () => {
    const { root } = gitRepo();
    try {
      const r = result();
      await new PrSize().run(r, { projectRoot: root });
      assert.deepStrictEqual(r.checks.filter((c) => !c.passed && /pr-size/.test(c.name)), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('NEGATIVE CONTROL: a local main with no remote still sizes the last commit (pre-push hook)', async () => {
    const root = repo({ 'a.js': 'x\n' });
    const git = (c) => execSync(`git ${c}`, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    try {
      git('init -q -b main'); git('add -A'); git('commit -qm one');
      fs.writeFileSync(path.join(root, 'big.js'), Array.from({ length: 1500 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n');
      git('add -A'); git('commit -qm two');
      const r = result();
      await new PrSize().run(r, { projectRoot: root });
      assert.ok(r.checks.some((c) => !c.passed && /pr-size/.test(c.name)), 'the developer committing to main locally still gets the last commit sized');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('NEGATIVE CONTROL: a branch ahead of main is still sized', async () => {
    const { root, git } = gitRepo();
    try {
      git('checkout -q -b feature');
      fs.writeFileSync(path.join(root, 'huge.js'), Array.from({ length: 2000 }, (_, i) => `const w${i} = ${i};`).join('\n') + '\n');
      git('add -A'); git('commit -qm three');
      const r = result();
      await new PrSize().run(r, { projectRoot: root });
      assert.ok(r.checks.some((c) => !c.passed && /pr-size/.test(c.name)), 'a real oversized branch must still be reported');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('bun.lock is excluded like every other lockfile', async () => {
    const { root, git } = gitRepo();
    try {
      git('checkout -q -b feature');
      fs.writeFileSync(path.join(root, 'bun.lock'), Array.from({ length: 3000 }, (_, i) => `"pkg${i}": "1.0.0",`).join('\n') + '\n');
      git('add -A'); git('commit -qm lock');
      const r = result();
      await new PrSize().run(r, { projectRoot: root });
      assert.ok(!r.checks.some((c) => /file-too-large:bun\.lock/.test(c.name)), 'a lockfile is generated, never reviewed line by line');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('bundleSize — a library dist/ without a bundler manifest is advisory', () => {
  const BundleSize = require('../src/modules/bundle-size');
  it('lodash-shaped dist/lodash.js over budget is a warning, not an error', async () => {
    const f = await runModule(BundleSize, { 'package.json': '{"name":"lib"}', 'dist/lib.js': 'x'.repeat(600 * 1024) });
    const over = f.filter((c) => /bundle-size:(largest-chunk|total)-error/.test(c.name));
    assert.ok(over.length >= 1, 'still reported');
    assert.ok(over.every((c) => c.severity === 'warning'), 'never blocking without a manifest');
  });
});

describe('documentation — README completeness never blocks a build', () => {
  const Documentation = require('../src/modules/documentation');
  it('a README with no usage/install section is a warning', async () => {
    const f = await runModule(Documentation, { 'README.md': '# lib\n\nA utility library. See the docs site.\n' + 'x'.repeat(300) });
    const sections = f.filter((c) => /docs:readme-/.test(c.name));
    assert.ok(sections.length >= 1, 'still reported');
    assert.ok(sections.every((c) => c.severity === 'warning'));
  });
  it('a missing README is a warning', async () => {
    const f = await runModule(Documentation, { 'index.js': '' });
    const c = f.find((x) => x.name === 'docs:readme');
    assert.ok(c && c.severity === 'warning');
  });
});

describe('links — placeholders, code samples, dependency assets and harness pages', () => {
  const Links = require('../src/modules/links');
  const broken = (checks) => (checks.find((c) => c.name === 'links:internal') || { details: [] }).details || [];
  it('silent on the chalk / fastify / axios / lodash shapes', async () => {
    const f = await runModule(Links, {
      'readme.md': 'Use `chalk.hex(string, number)`.\n\n```js\nlink(text)(string, number)\n```\n\n[docs](string, number)\n',
      'EXPENSE_POLICY.md': 'Submit via [the form](LINK).\n',
      'docs/style.md': 'Link to [your site](www.websitename.com).\n',
      'docs/es/index.md': '<a href="{{sponsor.website}}"><img src="{{sponsor.imageUrl}}"></a>\n[x]({{sponsor.website}})\n',
      'perf/index.html': '<html><body><script src="../node_modules/benchmark/benchmark.js"></script><a href="./missing.html">x</a></body></html>\n',
    });
    assert.deepStrictEqual(broken(f), []);
  });
  it('NEGATIVE CONTROL: a genuinely broken relative link in docs still fires', async () => {
    const f = await runModule(Links, { 'README.md': 'See [contributing](./CONTRIBUTING.md) and [guide](docs/guide.md).\n' });
    const hrefs = broken(f).map((d) => d.href).sort();
    assert.deepStrictEqual(hrefs, ['./CONTRIBUTING.md', 'docs/guide.md']);
  });
  it('NEGATIVE CONTROL: a user-facing page with a broken relative link still fires', async () => {
    const f = await runModule(Links, { 'public/index.html': '<a href="./about.html">about</a>\n' });
    assert.deepStrictEqual(broken(f).map((d) => d.href), ['./about.html']);
  });
});
