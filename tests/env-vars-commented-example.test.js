// envVars — a commented `# KEY=` line in .env.example documents an optional
// key (Gluecron, 2026-10-03). Reads of it are not missing-from-example, and
// it is never reported as unused. Prose naming a key after other words is
// not a declaration; an undocumented key still blocks.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EnvVarsModule = require('../src/modules/env-vars');

async function names(example, code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-env-cmt-'));
  try {
    fs.writeFileSync(path.join(root, '.env.example'), example);
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts/check.mjs'), code);
    const checks = [];
    await new EnvVarsModule().run({ addCheck(n, p, d = {}) { checks.push({ n, p, ...d }); } }, { projectRoot: root });
    return checks.filter((c) => !c.p).map((c) => c.n).sort();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('envVars — commented example keys', () => {
  it('a `# KEY=` line documents the key', async () => {
    const f = await names('DATABASE_URL=\n# NONMEMBER_PAT=\n#   EXPECT_SHA=\n', 'const db = process.env.DATABASE_URL;\nconst a = process.env.NONMEMBER_PAT;\nconst b = process.env.EXPECT_SHA;\nexport { db, a, b };\n');
    assert.deepStrictEqual(f, []);
  });
  it('a commented key nothing reads is not reported unused', async () => {
    const f = await names('DATABASE_URL=\n# OPTIONAL_FLAG=\n', 'export const db = process.env.DATABASE_URL;\n');
    assert.deepStrictEqual(f, []);
  });
  it('control: prose naming a key is not a declaration', async () => {
    const f = await names('DATABASE_URL=\n# Set NONMEMBER_PAT=x to enable the check\n', 'export const db = process.env.DATABASE_URL;\nexport const a = process.env.NONMEMBER_PAT;\n');
    assert.deepStrictEqual(f, ['env-vars:missing-from-example:NONMEMBER_PAT']);
  });
});
