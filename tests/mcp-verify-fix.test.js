// ============================================================================
// MCP verify_fix TOOL TEST — the "prove your fix worked" primitive.
// ============================================================================
// bin/gatetest-mcp.mjs guards its stdio-transport connect behind an
// entrypoint check, so we can dynamic-import it from CJS and call the REAL
// handler in-process — no child process, no re-implemented contract.
//
// Coverage:
//   - path helpers: normalizeRelPath / pathsTailMatch (incl. Windows separators)
//   - collectFlaggedChecks shape extraction
//   - real handler on a seeded-bug fixture: ❌ NOT VERIFIED before, ✅ after
//   - scoping: findings in untouched files don't block the verdict
//   - no-files + no-git fallback is honest about being project-wide
//   - tool is declared in TOOLS with the right schema
// ============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let mcp; // dynamic-imported ESM namespace

before(async () => {
  mcp = await import('../bin/gatetest-mcp.mjs');
});

// ── fixture helpers ─────────────────────────────────────────────────────────

function makeTmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-verify-fix-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function textOf(response) {
  return (response.content || []).map((c) => c.text || '').join('\n');
}

// A file the syntax/secrets modules will flag: hardcoded AWS-shaped key.
const BUGGY_JS = [
  '// payment config',
  'const AWS_SECRET_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";',
  'module.exports = { AWS_SECRET_ACCESS_KEY };',
  '',
].join('\n');

const CLEAN_JS = [
  '// payment config',
  'const awsKey = process.env.AWS_SECRET_ACCESS_KEY;',
  'module.exports = { awsKey };',
  '',
].join('\n');

const INNOCENT_JS = 'module.exports = function add(a, b) { return a + b; };\n';

// ── helper units ────────────────────────────────────────────────────────────

describe('verify_fix — path helpers', () => {
  it('normalizeRelPath converts backslashes and strips ./', () => {
    assert.strictEqual(mcp.normalizeRelPath('src\\middleware\\auth.ts'), 'src/middleware/auth.ts');
    assert.strictEqual(mcp.normalizeRelPath('./lib/x.js'), 'lib/x.js');
  });

  it('pathsTailMatch: exact, tail, and Windows-separator matches', () => {
    assert.ok(mcp.pathsTailMatch('src/config.js', 'src/config.js'));
    assert.ok(mcp.pathsTailMatch('repo/src/config.js', 'src/config.js'));
    assert.ok(mcp.pathsTailMatch('src/config.js', 'repo/src/config.js'));
    assert.ok(mcp.pathsTailMatch('src\\middleware\\auth.ts', 'src/middleware/auth.ts'));
  });

  it('pathsTailMatch: segment-boundary only — no substring false positives', () => {
    assert.strictEqual(mcp.pathsTailMatch('myconfig.js', 'config.js'), false);
    assert.strictEqual(mcp.pathsTailMatch('src/xconfig.js', 'config.js'), false);
    assert.strictEqual(mcp.pathsTailMatch('', 'config.js'), false);
  });

  it('collectFlaggedChecks pulls only error/warning checks with module attribution', () => {
    const result = {
      results: [
        {
          module: 'secrets',
          checks: [
            { severity: 'error', message: 'key found', file: 'a.js', line: 2 },
            { severity: 'info', message: 'scanned 3 files' },
          ],
        },
        { module: 'lint', checks: [{ severity: 'warning', message: 'var used', file: 'b.js' }] },
      ],
    };
    const flagged = mcp.collectFlaggedChecks(result);
    assert.strictEqual(flagged.length, 2);
    assert.strictEqual(flagged[0].module, 'secrets');
    assert.strictEqual(flagged[1].severity, 'warning');
  });
});

// ── tool registration ───────────────────────────────────────────────────────

describe('verify_fix — tool registration', () => {
  it('is declared in TOOLS with path required and files/base/maxModules optional', () => {
    const tool = mcp.TOOLS.find((t) => t.name === 'verify_fix');
    assert.ok(tool, 'verify_fix missing from TOOLS');
    assert.deepStrictEqual(tool.inputSchema.required, ['path']);
    assert.ok(tool.inputSchema.properties.files);
    assert.ok(tool.inputSchema.properties.base);
    assert.ok(tool.inputSchema.properties.maxModules);
    assert.match(tool.description, /FIX VERIFIED/);
  });
});

// ── real handler, real engine, seeded fixture ───────────────────────────────

describe('verify_fix — end-to-end verdict on a seeded bug', () => {
  let dir;

  before(() => {
    dir = makeTmpProject({
      'src/payment-config.js': BUGGY_JS,
      'src/add.js': INNOCENT_JS,
      'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    });
  });

  after(() => rmTmp(dir));

  it('rejects a missing path', async () => {
    const res = await mcp.handleVerifyFix({});
    assert.strictEqual(res.isError, true);
    assert.match(textOf(res), /path is required/);
  });

  it('❌ NOT VERIFIED while the seeded secret is present', async () => {
    const res = await mcp.handleVerifyFix({
      path: dir,
      files: ['src/payment-config.js'],
    });
    const text = textOf(res);
    assert.match(text, /❌ NOT VERIFIED/, `expected NOT VERIFIED, got:\n${text}`);
    assert.match(text, /payment-config\.js/);
    // Transparency: says which modules the smart selector chose
    assert.match(text, /Modules run \(smart selection/);
    // Project-wide delta line always present
    assert.match(text, /\*\*Project-wide:\*\*/);
  });

  it('✅ FIX VERIFIED after the fix is applied', async () => {
    fs.writeFileSync(path.join(dir, 'src/payment-config.js'), CLEAN_JS, 'utf-8');
    const res = await mcp.handleVerifyFix({
      path: dir,
      files: ['src/payment-config.js'],
    });
    const text = textOf(res);
    assert.match(text, /✅ FIX VERIFIED/, `expected FIX VERIFIED, got:\n${text}`);
  });

  it('scoping: a bug in an UNTOUCHED file does not block the changed-file verdict', async () => {
    // Re-seed the bug in payment-config, but claim we only changed add.js
    fs.writeFileSync(path.join(dir, 'src/payment-config.js'), BUGGY_JS, 'utf-8');
    const res = await mcp.handleVerifyFix({
      path: dir,
      files: ['src/add.js'],
    });
    const text = textOf(res);
    assert.match(text, /✅ FIX VERIFIED/, `expected verified (bug is in an untouched file), got:\n${text}`);
    // ...but the project-wide delta still shows the project is not clean
    assert.match(text, /\*\*Project-wide:\*\* [1-9]\d* error/);
  });

  it('accepts Windows-style separators in files input', async () => {
    fs.writeFileSync(path.join(dir, 'src/payment-config.js'), BUGGY_JS, 'utf-8');
    const res = await mcp.handleVerifyFix({
      path: dir,
      files: ['src\\payment-config.js'],
    });
    const text = textOf(res);
    assert.match(text, /❌ NOT VERIFIED/, `Windows separators must scope correctly, got:\n${text}`);
  });
});

describe('verify_fix — no-files fallback honesty', () => {
  let dir;

  before(() => {
    // No git repo in the tmp dir → getChangedFiles returns [] → quick-suite fallback
    dir = makeTmpProject({
      'index.js': INNOCENT_JS,
      'package.json': JSON.stringify({ name: 'fixture2', version: '1.0.0' }),
    });
  });

  after(() => rmTmp(dir));

  it('says the verdict is project-wide, not fix-scoped, and suggests passing files', async () => {
    const res = await mcp.handleVerifyFix({ path: dir });
    const text = textOf(res);
    assert.match(text, /project-wide/i);
    assert.match(text, /pass `files:/);
    assert.match(text, /quick suite/);
  });
});
