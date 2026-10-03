// hardcodedUrl — a loopback URL as a property value in a MULTI-LINE object
// literal is a data-table entry (Tallrig's service registry, 2026-10-03:
// `    health: http("http://127.0.0.1:9120/health"),` with the `{`/`,` on the
// line above). Controls: a ternary continuation line and a direct fetch
// still fire.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HardcodedUrl = require('../src/modules/hardcoded-url');

async function localhostErrors(src) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hurl-ml-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/registry.ts'), src);
    const checks = [];
    await new HardcodedUrl().run({ addCheck(n, p, d = {}) { checks.push({ n, p, ...d }); } }, { projectRoot: root });
    return checks.filter((c) => !c.p && c.n.startsWith('hardcoded-url:localhost:') && (c.severity || 'error') === 'error').map((c) => c.n.split(':').pop());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('hardcodedUrl — multi-line data tables', () => {
  it('NEGATIVE: a helper-wrapped entry on its own line', async () => {
    assert.deepStrictEqual(await localhostErrors([
      'export const UNITS = [',
      '  {',
      '    name: "dns",',
      '    health: http("http://127.0.0.1:9120/health"),',
      '  },',
      '];',
    ].join('\n')), []);
  });

  it('POSITIVE: a plain multi-line config value still fires (PR #85 guard)', async () => {
    assert.deepStrictEqual(await localhostErrors([
      'const config = {',
      '  apiBase: "http://localhost:3000",',
      '};',
      'fetch(config.apiBase);',
    ].join('\n')), ['2']);
  });
  it('POSITIVE: a ternary continuation line still fires', async () => {
    assert.deepStrictEqual(await localhostErrors([
      'export const B = isStaging',
      "  ? 'https://staging.example.com'",
      "  : 'http://localhost:4000';",
    ].join('\n')), ['3']);
  });
  it('POSITIVE: a direct fetch on its own line still fires', async () => {
    assert.deepStrictEqual(await localhostErrors([
      'export async function ping() {',
      '  return fetch(',
      '    "http://127.0.0.1:9120/health",',
      '  );',
      '}',
    ].join('\n')), ['3']);
  });
});
