// =============================================================================
// SECURITY MODULE — a credential made of VARIABLE EXPANSIONS is not a secret
// =============================================================================
// The self-scan on 2026-08-31 went BLOCKED on two findings in our own
// docker-compose.yml:
//
//   DATABASE_URL: postgresql://${POSTGRES_USER:-gatetest}:${POSTGRES_PASSWORD:-gatetest}@postgres:5432/…
//
// There is no committed credential on that line. Every component is a
// `${VAR:-default}` expansion — the shape we tell customers to use.
//
// What makes this worth a dedicated file: commit ac138e92 had ALREADY "fixed"
// this. Its message says the switch to `${VAR:-default}` "breaks the
// credential-URL regex". It did not. The placeholder allow-list only
// recognised the bare `${VAR}` form, so `:-gatetest` walked straight past it,
// and nobody measured the mitigation afterwards. Hence: measure it here.
//
// The fix masks expansions inside the line instead of discarding the line, so
// it cannot rot into a blanket mute — and the positive controls below are what
// would catch it if someone tried.
// =============================================================================

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SecurityModule = require('../src/modules/security');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sec-interp-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Scan a single file's content, return the `security:secret:*` finding lines. */
async function secretsIn(filename, body) {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(tmp, filename), body);
  const checks = [];
  const result = { checks, addCheck(name, passed, d = {}) { checks.push({ name, passed, ...d }); } };
  const mod = new SecurityModule();
  await mod.run(result, { projectRoot: tmp });
  return checks
    .filter((c) => !c.passed && /^security:secret:/.test(c.name))
    .map((c) => c.line);
}

/** The rollup check the gate actually blocks on. */
async function rollupPassed(filename, body) {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(tmp, filename), body);
  const checks = [];
  const result = { checks, addCheck(name, passed, d = {}) { checks.push({ name, passed, ...d }); } };
  const mod = new SecurityModule();
  await mod.run(result, { projectRoot: tmp });
  const roll = checks.find((c) => c.name === 'security:secrets-scan');
  assert.ok(roll, 'expected a security:secrets-scan rollup check');
  return roll.passed;
}

describe('security/secrets — expansions in the credential position', () => {
  it('NEGATIVE CONTROL: our own docker-compose line is not a secret', async () => {
    const found = await secretsIn('docker-compose.yml', [
      'services:',
      '  app:',
      '    environment:',
      '      DATABASE_URL: postgresql://${POSTGRES_USER:-gatetest}:${POSTGRES_PASSWORD:-gatetest}@postgres:5432/${POSTGRES_DB:-gatetest}?sslmode=disable',
      '',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('NEGATIVE CONTROL: the rollup passes too, not just the per-line check', async () => {
    // The per-file findings and the pathless rollup are separate checks, and
    // the rollup is the one with no file path for a user to silence.
    assert.strictEqual(
      await rollupPassed('docker-compose.yml',
        '      DATABASE_URL: postgresql://${POSTGRES_USER:-gatetest}:${POSTGRES_PASSWORD:-gatetest}@postgres:5432/db\n'),
      true,
    );
  });

  it('NEGATIVE CONTROL: the other expansion dialects are recognised too', async () => {
    const found = await secretsIn('deploy.yml', [
      'a: postgresql://{{ db_user }}:{{ db_password }}@db:5432/app',
      'b: mysql://$(DB_USER):$(DB_PASSWORD)@db:3306/app',
      'c: mongodb://%DB_USER%:%DB_PASSWORD%@db:27017/app',
      'd: redis://$REDIS_USER:$REDIS_PASSWORD@cache:6379/0',
      '',
    ].join('\n'));
    assert.deepStrictEqual(found, []);
  });

  it('POSITIVE CONTROL: a fully literal connection string still fires', async () => {
    const found = await secretsIn('config.yml',
      'url: postgresql://admin:hunter2correcthorse@db.example.com:5432/prod\n');
    assert.deepStrictEqual(found, [1]);
  });

  it('POSITIVE CONTROL: a literal password beside an expanded username still fires', async () => {
    // This is the case a whole-line skip would have lost — and the reason the
    // fix masks the expansion rather than discarding the line. `${dbUser}` is
    // lower-case on purpose: the pre-existing allow-list only skips
    // upper-case `${VAR}`, so an upper-case name would prove nothing here.
    const found = await secretsIn('config.yml',
      'url: postgresql://${dbUser}:hunter2correcthorse@db.example.com:5432/prod\n');
    assert.deepStrictEqual(found, [1]);
  });

  it('POSITIVE CONTROL: a real credential sharing a line with an expansion still fires', async () => {
    // Not `AKIAIOSFODNN7EXAMPLE`: that is the key AWS PUBLISHES as the one to
    // write in docs, and since 2026-09-14 the rule knows it authenticates
    // nothing (secrets.js PUBLISHED_EXAMPLE_CREDENTIALS). A stand-in for "a
    // real credential" has to be one the rule cannot recognise as fake.
    const found = await secretsIn('config.yml',
      'url: postgresql://${dbUser}:${dbPass}@${dbHost}/app  # aws AKIAQ7X2P9M4K8R3T6V1\n');
    // The AWS key is a comment on a YAML line, which the comment guard does
    // not cover (the line does not START with `#`), so it must still surface.
    assert.deepStrictEqual(found, [1]);
  });

  it('POSITIVE CONTROL: a $-prefixed variable name does not hide its literal value', async () => {
    // Masking a bare `$NAME` used as a VALUE is right; masking one being
    // ASSIGNED to would erase the very keyword the generic key/password rules
    // match on, so `$apiKey = "…"` would go quiet. It must still fire.
    const found = await secretsIn('keys.js',
      'const $apiKey = "abcdef1234567890abcdef";\n');
    assert.deepStrictEqual(found, [1]);
  });

  it('POSITIVE CONTROL: the rollup reports the literal, so the gate still blocks', async () => {
    assert.strictEqual(
      await rollupPassed('config.yml',
        'url: postgresql://admin:hunter2correcthorse@db.example.com:5432/prod\n'),
      false,
    );
  });
});
