// =============================================================================
// SECURITY — the published AWS example key, regex source, and the rollup
// =============================================================================
// GateTest's own full suite BLOCKED (2026-09-14) on one finding:
//
//   security:secret:src/modules/secrets.js:166   Potential AWS Access Key (0.40)
//
// The line is `'AKIAIOSFODNN7EXAMPLE',` inside secrets.js's OWN list of keys
// AWS publishes as the ones to write in docs. Two defects, both the rule's:
//
//   1. security.js's AWS pattern did not know the published example, though
//      secrets.js (PUBLISHED_EXAMPLE_CREDENTIALS) already did.
//   2. The per-file finding scored 0.40 — below the block threshold — but
//      the pathless `security:secrets-scan` rollup scored 1.0 on its own and
//      blocked on a finding the confidence layer had already judged soft.
//
// Each relaxation carries its still-fires half.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SecurityModule = require('../src/modules/security');
const { TestResult } = require('../src/core/runner');

// AKIA + 16 that is neither the published example nor a typed run.
const AWS_KEY = 'AKIA' + 'Q7X2P9M4K8R3T6V1';
const AWS_PUBLISHED_EXAMPLE = 'AKIAIOSFODNN7EXAMPLE';

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-security-example-'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.env\n*.pem\n*.key\n');
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

/** Run the security module with a REAL TestResult so confidence is scored. */
async function security(files) {
  const root = repo(files);
  try {
    const result = new TestResult('security', { projectRoot: root });
    result.start();
    await new SecurityModule().run(result, { projectRoot: root });
    return {
      perFile: result.checks.filter((c) => !c.passed && /^security:secret:/.test(c.name)),
      rollup: result.checks.find((c) => c.name === 'security:secrets-scan'),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('security — the published AWS example key is not a key', () => {
  it('silent: AKIAIOSFODNN7EXAMPLE is the key AWS tells you to write in docs', async () => {
    const r = await security({ 'src/table.js': `const EXAMPLES = new Set(['${AWS_PUBLISHED_EXAMPLE}']);\n` });
    assert.deepStrictEqual(r.perFile.map((c) => c.line), []);
    assert.strictEqual(r.rollup.passed, true, r.rollup.message);
  });

  it('fires: an AWS key that is not the published example still fires', async () => {
    const r = await security({ 'src/table.js': `const KEY = '${AWS_KEY}';\n` });
    assert.deepStrictEqual(r.perFile.map((c) => c.line), [1]);
    assert.strictEqual(r.rollup.passed, false);
  });
});

describe('security — the source of a regex literal describes a shape', () => {
  it('silent: an AWS-shaped regex literal in a JS pattern table', async () => {
    const r = await security({ 'src/rules.js': `const RULES = [{ regex: /${AWS_KEY}/g, name: 'aws' }];\n` });
    assert.deepStrictEqual(r.perFile.map((c) => c.line), []);
  });

  it('fires: the same text in quotes is a value', async () => {
    const r = await security({ 'src/rules.js': `const RULES = [{ value: '${AWS_KEY}', name: 'aws' }];\n` });
    assert.deepStrictEqual(r.perFile.map((c) => c.line), [1]);
  });

  it('fires: a regex-shaped line in a language the stripper does not parse is still reported', async () => {
    // Only the JS family gets regex context; fail toward detection elsewhere.
    const r = await security({ 'src/rules.py': `AWS_RE = r"/${AWS_KEY}/"\n` });
    assert.deepStrictEqual(r.perFile.map((c) => c.line), [1]);
  });
});

describe('security — the rollup never blocks harder than its constituents', () => {
  it('inherits the confidence of its most confident live finding', async () => {
    // A key in an example-data-named file scores below the block threshold;
    // the rollup used to score 1.0 on its own and block anyway.
    const r = await security({ 'src/sample-data.js': `const KEY = '${AWS_KEY}';\n` });
    assert.strictEqual(r.perFile.length, 1);
    assert.ok(r.perFile[0].confidence < 0.7, `expected a soft per-file finding, got ${r.perFile[0].confidence}`);
    assert.strictEqual(r.rollup.passed, false, 'the rollup still reports the count');
    assert.strictEqual(r.rollup.confidence, r.perFile[0].confidence,
      'the rollup must not block harder than the finding it counts');
  });

  it('POSITIVE CONTROL: a confident finding keeps the rollup confident', async () => {
    const r = await security({ 'src/db.js': `const KEY = '${AWS_KEY}';\n` });
    assert.strictEqual(r.perFile.length, 1);
    assert.strictEqual(r.rollup.confidence, r.perFile[0].confidence);
    assert.ok(r.rollup.confidence >= 0.7, `expected a blocking rollup, got ${r.rollup.confidence}`);
  });

  it('takes the MAX across findings, so one confident leak is not diluted by soft ones', async () => {
    const r = await security({
      'src/sample-data.js': `const KEY = '${AWS_KEY}';\n`,
      'src/db.js': `const KEY = '${AWS_KEY}';\n`,
    });
    assert.strictEqual(r.perFile.length, 2);
    assert.strictEqual(r.rollup.confidence, Math.max(...r.perFile.map((c) => c.confidence)));
    assert.ok(r.rollup.confidence >= 0.7);
  });
});
