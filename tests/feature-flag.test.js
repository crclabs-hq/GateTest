const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FeatureFlagModule = require('../src/modules/feature-flag');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new FeatureFlagModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('FeatureFlagModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'feature-flag:no-files'));
  });

  it('summary when files are scanned', async () => {
    write(tmp, 'src/a.ts', 'const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'feature-flag:summary'));
  });
});

describe('FeatureFlagModule — JS always-true conditionals', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-at-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on if (true)', async () => {
    write(tmp, 'src/a.js', 'if (true) { doThing(); }\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-true-if:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on if (1)', async () => {
    write(tmp, 'src/a.js', 'if (1) { doThing(); }\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-true-if:')));
  });

  it('errors on if (!false)', async () => {
    write(tmp, 'src/a.js', 'if (!false) { doThing(); }\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-true-if:')));
  });

  it('errors on if (!0)', async () => {
    write(tmp, 'src/a.js', 'if (!0) { doThing(); }\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-true-if:')));
  });

  it('does not flag if (someVar)', async () => {
    write(tmp, 'src/a.js', 'if (someVar) { doThing(); }\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag if (true && cond)', async () => {
    write(tmp, 'src/a.js', 'if (true && cond) { doThing(); }\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('FeatureFlagModule — JS always-false conditionals', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-af-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on if (false)', async () => {
    write(tmp, 'src/a.js', 'if (false) { deadCode(); }\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-false-if:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on if (0)', async () => {
    write(tmp, 'src/a.js', 'if (0) { deadCode(); }\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-false-if:')));
  });

  it('warns on if (!true)', async () => {
    write(tmp, 'src/a.js', 'if (!true) { deadCode(); }\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-false-if:')));
  });
});

describe('FeatureFlagModule — JS stale-const', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-sc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on const FEATURE_NEW_CHECKOUT = true', async () => {
    write(tmp, 'src/a.js', 'const FEATURE_NEW_CHECKOUT = true;\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('feature-flag:stale-const:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on const ENABLE_X = false', async () => {
    write(tmp, 'src/a.js', 'const ENABLE_X = false;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:stale-const:')));
  });

  it('does not flag let hasErrored = true (local mutable state)', async () => {
    // let / var bindings are mutable local state initializers, not flags.
    // Classic pattern: `let hasErrored = false; ... hasErrored = true;`.
    write(tmp, 'src/a.js', 'let hasErrored = false;\nif (fail) hasErrored = true;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:stale-const:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag const isReady = fetchStatus() (non-literal)', async () => {
    write(tmp, 'src/a.js', 'const isReady = fetchStatus();\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag const MAX_RETRIES = 3', async () => {
    write(tmp, 'src/a.js', 'const MAX_RETRIES = 3;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag const name = "x"', async () => {
    write(tmp, 'src/a.js', 'const name = "x";\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag const userFlags = fetchFlags()', async () => {
    write(tmp, 'src/a.js', 'const userFlags = fetchFlags();\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('FeatureFlagModule — Python always-true / always-false', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-py-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on if True:', async () => {
    write(tmp, 'src/a.py', 'if True:\n    pass\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('feature-flag:py-always-true-if:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on if not False:', async () => {
    write(tmp, 'src/a.py', 'if not False:\n    pass\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:py-always-true-if:')));
  });

  it('warns on if False:', async () => {
    write(tmp, 'src/a.py', 'if False:\n    pass\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('feature-flag:py-always-false-if:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does not flag if condition:', async () => {
    write(tmp, 'src/a.py', 'if condition:\n    pass\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('FeatureFlagModule — Python stale-const', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-pc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on FEATURE_X = True', async () => {
    write(tmp, 'src/a.py', 'FEATURE_X = True\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:py-stale-const:')));
  });

  it('warns on ENABLE_FOO = False', async () => {
    write(tmp, 'src/a.py', 'ENABLE_FOO = False\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('feature-flag:py-stale-const:')));
  });

  it('does not flag MAX_RETRIES = 3', async () => {
    write(tmp, 'src/a.py', 'MAX_RETRIES = 3\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag indented local self.enabled = True (class body)', async () => {
    write(tmp, 'src/a.py', 'class C:\n    ENABLED = True\n');
    const r = await run(tmp);
    const staleHits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:py-stale-const:'),
    );
    assert.strictEqual(staleHits.length, 0);
  });
});

describe('FeatureFlagModule — suppressions', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-sup-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('honours // flag-ok on the same line (JS)', async () => {
    write(tmp, 'src/a.js', 'if (true) { x(); } // flag-ok — placeholder during wiring\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('honours # flag-ok on the same line (Python)', async () => {
    write(tmp, 'src/a.py', 'if True:  # flag-ok\n    pass\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('FeatureFlagModule — minified skip', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-min-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips .min.js files', async () => {
    write(tmp, 'public/vendor.min.js', 'if(true){a()}if(false){b()}\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('feature-flag:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('FeatureFlagModule — test path downgrade', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-t-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('downgrades error -> warning in test paths (JS)', async () => {
    write(tmp, 'tests/a.test.js', 'if (true) { assertTrue(); }\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-true-if:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('downgrades warning -> info in test paths (JS always-false)', async () => {
    write(tmp, 'tests/a.test.js', 'if (false) { dead(); }\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('feature-flag:always-false-if:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });
});

// #842 DR-2 (DavenRoe USCorpTaxationsGuide.jsx:591): "...is PHC income if (1)
// a named individual must" — English inside a JSX element, matched as `if (1)`
// because the `>` of its opening tag sat on the previous line.
describe('FeatureFlagModule — JSX prose is not a conditional (#842 DR-2)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-jsx-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const GUIDE = [
    'export default function Guide() {',
    '  return (',
    '    <div className="space-y-3">',
    '      <InfoBox color="purple" title="Personal Service Contracts">',
    '        Income from a contract for personal services is PHC income if (1) a named individual must',
    '        perform the services (or approval is required), and (2) 25% or more of the corporation',
    '      </InfoBox>',
    '      <p>',
    '        if (1) the sentence starts with the words, it is still prose',
    '      </p>',
    '    </div>',
    '  );',
    '}',
  ];
  const ids = (r) => r.checks.filter((c) => !c.passed && /^feature-flag:always-(?:true|false)-if:/.test(c.name)).map((c) => c.line);

  it('NEGATIVE: the DavenRoe page is quiet — mid-sentence `if (1)` and a prose line that starts with it', async () => {
    write(tmp, 'src/pages/Guide.jsx', GUIDE.concat('').join('\n'));
    assert.deepStrictEqual(ids(await run(tmp)), []);
  });

  it('POSITIVE: `if (1) {`, `if (true) {` and `} else if (false) {` in the same component code still fire', async () => {
    const code = [
      'export default function Guide({ user }) {',
      '  if (1) { return null; }',
      '  if (true) { track(user); }',
      '  if (user) { a(); } else if (false) { b(); }',
    ].concat(GUIDE.slice(1));
    write(tmp, 'src/pages/Guide.jsx', code.concat('').join('\n'));
    assert.deepStrictEqual(ids(await run(tmp)), [2, 3, 4]);
  });
});

// #842 DR-3 (DavenRoe csv_adapter.py:435,460, source.py:198,205): the
// empty-async-generator idiom `if False:` / `yield  # pragma: no cover` is how
// a coroutine is typed as an AsyncIterator that yields nothing — dead on purpose.
describe('FeatureFlagModule — Python empty-generator idiom (#842 DR-3)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ff-gen-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const ids = (r) => r.checks.filter((c) => !c.passed && c.name.startsWith('feature-flag:py-always-false-if:')).map((c) => c.line);

  it('NEGATIVE: a bare `yield` body (with or without the pragma comment) is quiet', async () => {
    write(tmp, 'src/adapter.py', [
      'async def pull_accounts(self) -> AsyncIterator[PulledAccount]:',
      '    if False:',
      '        yield  # pragma: no cover',
      '',
      'async def pull_bills(self) -> AsyncIterator[PulledBill]:',
      '    """Default empty."""',
      '    if False:',
      '        yield',
      '    return',
      '',
    ].join('\n'));
    assert.deepStrictEqual(ids(await run(tmp)), []);
  });

  it('POSITIVE: `if False:` guarding real statements, or a yield followed by more body, still fires', async () => {
    write(tmp, 'src/adapter.py', [
      'def f():',
      '    if False:',
      '        do_thing()',
      '',
      'def g():',
      '    if False:',
      '        yield',
      '        cleanup()',
      '',
    ].join('\n'));
    assert.deepStrictEqual(ids(await run(tmp)), [2, 6]);
  });
});
