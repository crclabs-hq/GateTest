// =============================================================================
// SECRETS — corpus7 precision pass (Gluecron, #682)
// =============================================================================
// Four false positives from a real customer scan (ccantynz-alt/Gluecron.com
// @ 915cbe7, quick suite, 22 Sep): an OAuth enum constant read as a Token, an
// RP display-name fallback read as a Fallback Secret, a commented-out default
// password blocking the gate, and an HTML-escaped documentation placeholder
// inside JSX read as a Database URL. Each rule change carries its control
// pair: the false positive that must go quiet, and the real credential in the
// same shape that must still fire.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SecretsModule = require('../src/modules/secrets');

async function scan(files, { gitignore = 'node_modules/\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-c7-'));
  try {
    fs.writeFileSync(path.join(root, '.gitignore'), gitignore);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const checks = [];
    const result = {
      addCheck(id, passed, meta) { checks.push({ id, passed, ...(meta || {}) }); },
      addInfo() {},
    };
    await new SecretsModule().run(result, { projectRoot: root });
    return checks.filter((c) => !c.passed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const fileFindings = (found) => found.filter((c) => !/gitignore/i.test(c.id));

// -----------------------------------------------------------------------------
// Item 1 — grant_type / token_type / response_type enum values are not Tokens
// -----------------------------------------------------------------------------
describe('secrets — corpus7 item 1: OAuth enum values are not Token findings', () => {
  it('silent: an OAuth enum constant on a grant_type line', async () => {
    const found = fileFindings(await scan({
      'scripts/doctor.ts': 'const badRefresh = await jpost("/oauth/token", { grant_type: "authorization_code", access_token: "AUTHORIZATION_CODE" });\n',
    }));
    assert.deepStrictEqual(found.map((f) => f.id), [], 'an OAuth enum constant is not a credential');
  });

  it('fires: a real token value on the same shape of line', async () => {
    const found = fileFindings(await scan({
      'scripts/doctor.ts': 'const badRefresh = await jpost("/oauth/token", { grant_type: "authorization_code", access_token: "aZ9kQm2pXo7Rt5Lw1Ce8Xy3" });\n',
    }));
    assert.ok(found.some((f) => f.id === 'secrets:scripts/doctor.ts'), 'a real-looking token value must still fire');
    const detail = found.find((f) => f.id === 'secrets:scripts/doctor.ts').details.find((d) => d.type === 'Token');
    assert.ok(detail, 'the finding is reported as a Token');
  });

  it('fires: a real token value with no grant_type field on the line', async () => {
    const found = fileFindings(await scan({
      'src/client.ts': 'const t = { access_token: "aZ9kQm2pXo7Rt5Lw1Ce8Xy3" };\n',
    }));
    assert.ok(found.some((f) => f.id === 'secrets:src/client.ts'), 'no OAuth field context — the enum guard must not apply');
  });
});

// -----------------------------------------------------------------------------
// Item 2 — a Fallback Secret needs a secret-bearing NAME and a real value
// -----------------------------------------------------------------------------
describe('secrets — corpus7 item 2: Fallback Secret needs a secret-bearing name and value', () => {
  it('silent: a display-name fallback whose var name only contains "auth" as a substring', async () => {
    const found = fileFindings(await scan({
      'src/lib/config.ts': 'export const rpName = process.env.WEBAUTHN_RP_NAME || "gluecron";\n',
    }));
    assert.deepStrictEqual(found.map((f) => f.id), [], 'WEBAUTHN_RP_NAME is a display name, not a secret-bearing var');
  });

  it('silent: a secret-bearing name with a trivial (bare hostname) fallback', async () => {
    const found = fileFindings(await scan({
      'src/lib/config.ts': 'export const dsnHost = process.env.SENTRY_DSN_HOST ?? "sentry.example.com";\n',
    }));
    assert.deepStrictEqual(found.map((f) => f.id), [], 'a bare hostname fallback is a location, not a credential');
  });

  it('fires: a real hardcoded fallback on AUTH_SECRET', async () => {
    const found = fileFindings(await scan({
      'src/lib/config.ts': 'export const authSecret = process.env.AUTH_SECRET ?? "s3cr3t";\n',
    }));
    assert.ok(found.some((f) => f.id === 'secrets:src/lib/config.ts'), 'AUTH_SECRET has a secret-bearing segment and a non-trivial value');
    const detail = found.find((f) => f.id === 'secrets:src/lib/config.ts').details.find((d) => d.type === 'Fallback Secret');
    assert.ok(detail, 'reported as a Fallback Secret');
  });

  it('fires: a URL fallback carrying its own credential, whatever the var is called', async () => {
    const found = fileFindings(await scan({
      'src/lib/config.ts': 'export const dbUrl = process.env.STORE_LOCATION ?? "postgres://user:realpass@host/db";\n',
    }));
    assert.ok(found.some((f) => f.id === 'secrets:src/lib/config.ts'), 'a URL fallback with userinfo is a credential regardless of the var name');
  });
});

// -----------------------------------------------------------------------------
// Item 3 — a commented-out Fallback Secret is dead code, at most an info note
// -----------------------------------------------------------------------------
describe('secrets — corpus7 item 3: commented-out fallback secrets never block', () => {
  it('info only: a `//`-commented default password fallback', async () => {
    const found = fileFindings(await scan({
      'src/lib/intelligence.ts': '//   const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? \'layova-admin\';\n',
    }));
    assert.ok(found.length > 0, 'still on the record');
    assert.ok(found.every((f) => f.severity === 'info'), 'never an error or warning');
    assert.ok(!found.some((f) => f.id === 'secrets:src/lib/intelligence.ts' && (f.details || []).some((d) => d.type === 'Fallback Secret')),
      'not folded into the blocking finding for the file');
  });

  it('info only: a `*` JSDoc-commented default password fallback', async () => {
    const found = fileFindings(await scan({
      'src/lib/intelligence.ts': ' *   const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? \'layova-admin\';\n',
    }));
    assert.ok(found.length > 0, 'still on the record');
    assert.ok(found.every((f) => f.severity === 'info'), 'never an error or warning');
  });

  it('info only: a `/* ... */`-commented default password fallback', async () => {
    const found = fileFindings(await scan({
      'src/lib/intelligence.ts': '/* const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? \'layova-admin\'; */\n',
    }));
    assert.ok(found.length > 0, 'still on the record');
    assert.ok(found.every((f) => f.severity === 'info'), 'never an error or warning');
  });

  it('fires as an error: the exact same fallback, uncommented', async () => {
    const found = fileFindings(await scan({
      'src/lib/intelligence.ts': 'const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? \'layova-admin\';\n',
    }));
    const check = found.find((f) => f.id === 'secrets:src/lib/intelligence.ts');
    assert.ok(check, 'live code still fires');
    assert.equal(check.severity, 'error');
    assert.ok(check.details.some((d) => d.type === 'Fallback Secret'));
  });
});

// -----------------------------------------------------------------------------
// Item 4 — an HTML-escaped placeholder inside JSX display text is documentation
// -----------------------------------------------------------------------------
describe('secrets — corpus7 item 4: JSX-escaped placeholders are not Database URLs', () => {
  it('silent: &lt;password&gt; inside a JSX <code> element', async () => {
    const found = fileFindings(await scan({
      'src/routes/admin-database.tsx': [
        'export function AdminDatabase() {',
        '  return (',
        '    <code>DATABASE_URL=postgres://gluecron:&lt;password&gt;@postgres:5432/gluecron</code>',
        '  );',
        '}',
        '',
      ].join('\n'),
    }));
    assert.deepStrictEqual(found.map((f) => f.id), [], 'an HTML-escaped placeholder in JSX display text is documentation');
  });

  it('silent: the literal <password> placeholder form', async () => {
    const found = fileFindings(await scan({
      'src/setup.md': 'Set `DATABASE_URL=postgres://gluecron:<password>@postgres:5432/gluecron` in your .env\n',
    }));
    assert.deepStrictEqual(found.map((f) => f.id), [], 'the plain <placeholder> convention already reads as documentation');
  });

  it('fires: a real postgres URL with credentials inside JSX display text', async () => {
    const found = fileFindings(await scan({
      'src/routes/admin-database.tsx': [
        'export function AdminDatabase() {',
        '  return (',
        '    <code>DATABASE_URL=postgres://gluecron:realpass123@postgres:5432/gluecron</code>',
        '  );',
        '}',
        '',
      ].join('\n'),
    }));
    assert.ok(found.some((f) => f.id === 'secrets:src/routes/admin-database.tsx'), 'a real leaked credential inside JSX text must still fire');
  });

  it('fires: a real postgres URL with credentials in plain code', async () => {
    const found = fileFindings(await scan({
      'src/db.ts': 'const url = "postgres://user:realpass@host";\n',
    }));
    assert.ok(found.some((f) => f.id === 'secrets:src/db.ts'), 'a real credential in ordinary code must still fire');
  });
});
