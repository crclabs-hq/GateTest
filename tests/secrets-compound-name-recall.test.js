// =============================================================================
// SECRETS — compound and typed identifier names are seen (recall)
// =============================================================================
// The identifier-keyed Password/Secret rule required the keyword to sit
// IMMEDIATELY before `:`/`=`. So, verified 2026-09-29 against origin/main,
// each of these was reported quiet with a high-entropy literal while
// `SECRET = "…"` fired:
//
//   SECRET_KEY = "…"                  Django settings.py
//   secret_key: str = "…"             pydantic Settings (DavenRoe
//                                     backend/app/core/config.py:12)
//   const secretKey = "…"
//   db_password: str = "…"            any typed assignment, every rule
//   const apiToken: string = "…"
//
// Each shape is a CONTROL PAIR: the high-entropy value fires; the same shape
// holding a placeholder (`change-me-in-production`, `your-secret-key-here`)
// stays quiet through PLACEHOLDER_VALUE_RE (src/core/env-placeholder.js,
// imported by secrets.js) — the #842 DR-6 side.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SecretsModule = require('../src/modules/secrets');

const VALUE = 'k9F2vQ7xL1mR4pT8wZ3cB6nJ0hY5dG2s';

async function findings(source, filename) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-compound-'));
  try {
    fs.writeFileSync(path.join(root, filename), source);
    const checks = [];
    const result = {
      addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); },
      addInfo() {},
    };
    await new SecretsModule().run(result, { projectRoot: root });
    return checks.filter((c) => !c.passed && !/gitignore/i.test(c.id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const SHAPES = [
  ['settings.py', (v) => `SECRET_KEY = "${v}"`],
  ['config.py', (v) => `class Settings(BaseSettings):\n    secret_key: str = "${v}"`],
  ['config.py', (v) => `class Settings(BaseSettings):\n    secret_key: Optional[str] = "${v}"`],
  ['config.py', (v) => `class Settings(BaseSettings):\n    secret_key: str | None = "${v}"`],
  ['auth.js', (v) => `const secretKey = "${v}";`],
  ['auth.ts', (v) => `const secretKey: string = "${v}";`],
  ['config.yml', (v) => `secret-key: "${v}"`],
  ['db.py', (v) => `db_password: str = "${v}"`],
  ['client.ts', (v) => `const apiToken: string = "${v}";`],
  ['client.py', (v) => `api_key: str = "${v}"`],
];

const PLACEHOLDERS = ['change-me-in-production', 'your-secret-key-here'];

describe('secrets: compound and typed identifier names (recall)', () => {
  for (const [file, shape] of SHAPES) {
    it(`fires on ${JSON.stringify(shape(VALUE).split('\n').pop().trim())}`, async () => {
      const found = await findings(shape(VALUE), file);
      assert.strictEqual(found.length, 1, `expected exactly one finding, got ${found.length}`);
    });
    for (const p of PLACEHOLDERS) {
      it(`stays quiet on ${JSON.stringify(shape(p).split('\n').pop().trim())}`, async () => {
        assert.deepStrictEqual(await findings(shape(p), file), []);
      });
    }
  }

  it('`secret_token = "…"` is ONE finding, not one per rule', async () => {
    // `secret_token` is already Token's; a `token` suffix on the secret rule
    // would report the same value twice.
    const found = await findings(`secret_token = "${VALUE}"`, 'a.py');
    assert.strictEqual(found.length, 1);
  });

  it('a type annotation cannot span into a neighbouring field', async () => {
    // No `=` between the name and the value: not an assignment, no match on
    // `secret`. The password beside it is still its own, single finding.
    const found = await findings(`const o = { secret: foo, password: "${VALUE}" };`, 'o.js');
    assert.strictEqual(found.length, 1);
  });

  it('`secretKeyRef` is a different name — no match', async () => {
    assert.deepStrictEqual(await findings(`secretKeyRef = "${VALUE}"`, 'k.py'), []);
  });
});
