const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WebHeadersModule = require('../src/modules/web-headers');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new WebHeadersModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('WebHeadersModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-wh-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no web-header configs exist', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'web-headers:no-files'));
  });

  it('discovers next.config.js when it contains a headers() function', async () => {
    write(tmp, 'next.config.js', [
      'module.exports = {',
      '  async headers() {',
      '    return [',
      '      {',
      '        source: "/(.*)",',
      '        headers: [',
      '          { key: "Content-Security-Policy", value: "default-src \'self\'" },',
      '          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },',
      '          { key: "X-Frame-Options", value: "DENY" },',
      '          { key: "X-Content-Type-Options", value: "nosniff" },',
      '        ],',
      '      },',
      '    ];',
      '  },',
      '};',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const scanning = r.checks.find((c) => c.name === 'web-headers:scanning');
    assert.ok(scanning);
    assert.match(scanning.message, /1 web-header/);
  });

  it('discovers vercel.json with a headers array', async () => {
    write(tmp, 'vercel.json', JSON.stringify({
      headers: [{
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'self'" },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      }],
    }, null, 2));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'web-headers:scanning'));
  });
});

describe('WebHeadersModule — CSP hardening', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-wh-csp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on CSP containing unsafe-eval', async () => {
    write(tmp, 'next.config.js', [
      'module.exports = {',
      '  async headers() {',
      '    return [{',
      '      source: "/(.*)",',
      '      headers: [',
      "        { key: 'Content-Security-Policy', value: \"default-src 'self'; script-src 'self' 'unsafe-eval'\" },",
      '      ],',
      '    }];',
      '  },',
      '};',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('web-headers:csp-unsafe-eval:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('warns on CSP containing unsafe-inline', async () => {
    write(tmp, 'next.config.js', [
      'module.exports = {',
      '  async headers() {',
      '    return [{',
      '      source: "/(.*)",',
      '      headers: [',
      "        { key: 'Content-Security-Policy', value: \"default-src 'self'; script-src 'self' 'unsafe-inline'\" },",
      '      ],',
      '    }];',
      '  },',
      '};',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('web-headers:csp-unsafe-inline:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });
});

describe('WebHeadersModule — CORS', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-wh-cors-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on wildcard origin + allow-credentials:true', async () => {
    write(tmp, 'server.js', [
      'const app = require("express")();',
      "app.use((req, res, next) => {",
      "  res.setHeader('Access-Control-Allow-Origin', '*');",
      "  res.setHeader('Access-Control-Allow-Credentials', 'true');",
      '  next();',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('web-headers:cors-wildcard-with-credentials:'));
    assert.ok(hit, 'expected CORS wildcard+credentials finding');
    assert.strictEqual(hit.severity, 'error');
  });

  it('does NOT flag wildcard origin without credentials', async () => {
    write(tmp, 'server.js', [
      'const app = require("express")();',
      "app.use((req, res, next) => {",
      "  res.setHeader('Access-Control-Allow-Origin', '*');",
      '  next();',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('web-headers:cors-wildcard-with-credentials:')),
      undefined,
    );
  });
});

describe('WebHeadersModule — missing headers', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-wh-miss-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns when a headers config sets XFO but no CSP', async () => {
    write(tmp, 'next.config.js', [
      'module.exports = {',
      '  async headers() {',
      '    return [{',
      '      source: "/(.*)",',
      '      headers: [',
      '        { key: "X-Frame-Options", value: "DENY" },',
      '      ],',
      '    }];',
      '  },',
      '};',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('web-headers:missing-csp:')));
  });

  it('does NOT warn about missing frame-options when CSP has frame-ancestors', async () => {
    write(tmp, 'vercel.json', JSON.stringify({
      headers: [{
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'none'" },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      }],
    }, null, 2));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('web-headers:missing-frame-options:')),
      undefined,
    );
  });

  it('warns on HSTS max-age below 180 days', async () => {
    write(tmp, 'next.config.js', [
      'module.exports = {',
      '  async headers() {',
      '    return [{',
      '      source: "/(.*)",',
      '      headers: [',
      '        { key: "Content-Security-Policy", value: "default-src \'self\'" },',
      '        { key: "Strict-Transport-Security", value: "max-age=3600" },',
      '        { key: "X-Frame-Options", value: "DENY" },',
      '        { key: "X-Content-Type-Options", value: "nosniff" },',
      '      ],',
      '    }];',
      '  },',
      '};',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('web-headers:hsts-short:'));
    assert.ok(hit);
    assert.strictEqual(hit.maxAge, 3600);
  });
});

describe('WebHeadersModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-wh-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for a well-configured Next.js headers block', async () => {
    write(tmp, 'next.config.js', [
      'module.exports = {',
      '  async headers() {',
      '    return [{',
      '      source: "/(.*)",',
      '      headers: [',
      "        { key: 'Content-Security-Policy', value: \"default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'none'\" },",
      '        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },',
      '        { key: "X-Frame-Options", value: "DENY" },',
      '        { key: "X-Content-Type-Options", value: "nosniff" },',
      '      ],',
      '    }];',
      '  },',
      '};',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `unexpected findings: ${JSON.stringify(issues, null, 2)}`);
  });

  it('KI #43: skips a tests/ dir fixture file entirely, even though it contains unsafe-eval/unsafe-inline/CORS-wildcard/short-HSTS text', async () => {
    // Reproduces the exact self-flagging shape this repo's own
    // tests/web-headers.test.js hit: fixture "source code" embedded as an
    // escaped string inside a .test.js file under a tests/ directory.
    write(tmp, 'tests/web-headers.test.js', [
      "const x = [",
      "  'module.exports = {',",
      "  '  async headers() {',",
      "  '    return [{',",
      "  '      headers: [',",
      "  \"        { key: 'Content-Security-Policy', value: \\\"default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'\\\" },\",",
      "  \"        { key: 'Strict-Transport-Security', value: \\\"max-age=3600\\\" },\",",
      "  '    }];',",
      "  '  },',",
      "  '};',",
      "].join('\\n');",
      "app.use((req, res, next) => {",
      "  res.setHeader('Access-Control-Allow-Origin', '*');",
      "  res.setHeader('Access-Control-Allow-Credentials', 'true');",
      "  next();",
      "});",
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `expected zero findings on a tests/ fixture file, got: ${JSON.stringify(issues, null, 2)}`);
  });

  it('KI #43: still flags the identical pattern when the same file lives OUTSIDE a tests/ dir', async () => {
    // Control case — proves the fix suppresses by PATH, not by silently
    // disabling the rule. Same CORS wildcard+credentials shape as above,
    // written to a plain server file instead of a tests/ path.
    write(tmp, 'server.js', [
      "app.use((req, res, next) => {",
      "  res.setHeader('Access-Control-Allow-Origin', '*');",
      "  res.setHeader('Access-Control-Allow-Credentials', 'true');",
      "  next();",
      "});",
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('web-headers:cors-wildcard-with-credentials:'));
    assert.ok(hit, 'expected the same finding to still fire outside a tests/ dir');
    assert.strictEqual(hit.severity, 'error');
  });

  it('records a summary', async () => {
    write(tmp, 'vercel.json', JSON.stringify({
      headers: [{
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'none'" },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      }],
    }, null, 2));
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'web-headers:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});
