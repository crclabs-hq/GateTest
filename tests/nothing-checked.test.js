// =============================================================================
// AN EMPTY SCAN IS NOT A CLEAN ONE (2026-09-14)
// =============================================================================
// Reproduced against the shipped CLI:
//
//   $ gatetest --project ./empty --suite quick
//   GATE: PASSED   Modules: 42/42 passed   ✓ You're good.
//
// on a directory with no source file at all (and again with only a
// package.json). Every module walked the tree, found nothing to read, and
// passed. The verdict was correct and the summary was a lie by omission.
//
// Now: the runner records `nothingChecked`, the console and plain summary
// say it beside the verdict, the JSON carries it, and `--strict` makes it
// the verdict. The still-works half: a tree with one source file is a scan.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hasSourceFiles } = require('../src/core/scan-scope');
const { GateTestRunner } = require('../src/core/runner');
const { GateTestConfig } = require('../src/core/config');
const { plainSummaryLines } = require('../src/core/plain-summary');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-nothing-checked-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

async function summarise(files, options = {}) {
  const root = tree(files);
  try {
    const runner = new GateTestRunner(new GateTestConfig(root), options);
    // No modules registered: the inventory is the runner's, not a module's.
    return await runner.run([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('hasSourceFiles — is there anything here to check?', () => {
  it('false for an empty directory', () => {
    const root = tree({});
    try { assert.strictEqual(hasSourceFiles(root), false); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('false for manifests, lockfiles and docs alone', () => {
    const root = tree({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'package-lock.json': '{}\n',
      'README.md': '# x\n',
      'LICENSE': 'MIT\n',
      '.gitignore': 'node_modules/\n',
    });
    try { assert.strictEqual(hasSourceFiles(root), false); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('false when the only code is under an excluded directory (node_modules, dist)', () => {
    const root = tree({
      'node_modules/dep/index.js': 'module.exports = 1;\n',
      'dist/bundle.js': 'var a=1;\n',
    });
    try { assert.strictEqual(hasSourceFiles(root), false); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('true for one source file, however deep', () => {
    const root = tree({ 'package.json': '{}\n', 'src/lib/deep/x.py': 'x = 1\n' });
    try { assert.strictEqual(hasSourceFiles(root), true); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('true for markup and styles — the presentation modules read those', () => {
    const root = tree({ 'index.html': '<p>hi</p>\n' });
    try { assert.strictEqual(hasSourceFiles(root), true); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('false for a path that cannot be read', () => {
    assert.strictEqual(hasSourceFiles(path.join(os.tmpdir(), `gt-no-such-${process.pid}-${Date.now()}`)), false);
  });
});

describe('runner — nothingChecked on the summary', () => {
  it('an empty tree: PASSED by default, nothingChecked true, root named', async () => {
    const s = await summarise({ 'package.json': '{}\n' });
    assert.strictEqual(s.gateStatus, 'PASSED');
    assert.strictEqual(s.nothingChecked, true);
    assert.ok(typeof s.projectRoot === 'string' && s.projectRoot.length > 0);
  });

  it('an empty tree under --strict: BLOCKED with zero findings', async () => {
    const s = await summarise({ 'package.json': '{}\n' }, { strict: true });
    assert.strictEqual(s.gateStatus, 'BLOCKED');
    assert.strictEqual(s.nothingChecked, true);
    assert.strictEqual(s.checks.blockingErrors, 0);
  });

  it('a tree with a source file: nothingChecked false, strict or not', async () => {
    const s = await summarise({ 'src/a.js': 'module.exports = 1;\n' }, { strict: true });
    assert.strictEqual(s.gateStatus, 'PASSED');
    assert.strictEqual(s.nothingChecked, false);
  });
});

describe('plain summary — the recap says it instead of "You\'re good"', () => {
  const base = { checks: { blockingErrors: 0, softErrors: 0, warnings: 0, baselined: 0 }, projectRoot: '/repo' };

  it('PASSED + nothingChecked: no "You\'re good", the root is named, --strict is offered', () => {
    const text = plainSummaryLines({ ...base, gateStatus: 'PASSED', nothingChecked: true }, {}, { color: false }).join('\n');
    assert.match(text, /Nothing was checked/);
    assert.match(text, /No source files found under \/repo/);
    assert.match(text, /--strict/);
    assert.doesNotMatch(text, /You're good/);
  });

  it('BLOCKED + nothingChecked: says why, does not say "0 issues are blocking"', () => {
    const text = plainSummaryLines({ ...base, gateStatus: 'BLOCKED', nothingChecked: true }, {}, { color: false }).join('\n');
    assert.match(text, /Blocked under --strict/);
    assert.doesNotMatch(text, /0 issues are blocking/);
  });

  it('a real PASSED scan is unchanged', () => {
    const text = plainSummaryLines({ ...base, gateStatus: 'PASSED', nothingChecked: false }, {}, { color: false }).join('\n');
    assert.match(text, /You're good/);
    assert.doesNotMatch(text, /Nothing was checked/);
  });
});

describe('JSON report — nothingChecked is on the record', () => {
  it('json-reporter writes summary.nothingChecked', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'reporters', 'json-reporter.js'), 'utf8');
    assert.match(src, /nothingChecked: summary\.nothingChecked === true/);
  });
});
