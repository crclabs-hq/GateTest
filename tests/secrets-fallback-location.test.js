// secrets — a fallback that is a LOCATION is not a credential (Tallrig
// 2026-10-03): `CELITECH_TOKEN_URL ?? "https://api.celitech.com/oauth2/token"`
// and `DEPLOY_MANIFEST_KEY ?? "deploys/manifest.json"`. A URL with userinfo,
// a webhook URL whose path carries the secret, and Tallrig's real
// `?? "vapron-collab-dev-secret"` fallbacks still fire. A dotted
// storage-key name (`"<ext>.pat"`) is a label (Gluecron vscode extension).
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const SecretsModule = require('../src/modules/secrets');

describe('secrets: fallback locations', () => {
  let mod;
  beforeEach(() => { mod = new SecretsModule(); });
  const fb = (line) => mod._envFallbackSecret(line);

  it('a public URL with no userinfo is not a secret', () => {
    assert.strictEqual(fb('const tokenUrl = process.env.CELITECH_TOKEN_URL ?? "https://api.celitech.com/oauth2/token";'), null);
  });
  it('a relative file path is not a secret', () => {
    assert.strictEqual(fb('return process.env.DEPLOY_MANIFEST_KEY ?? "deploys/manifest.json";'), null);
  });
  it('control: a URL with userinfo still fires', () => {
    assert.strictEqual(fb('const u = process.env.DATABASE_URL ?? "postgres://app:s3cretPw9@db:5432/app";'), 'postgres://app:s3cretPw9@db:5432/app');
  });
  it('control: a webhook URL whose path carries a random secret still fires', () => {
    const v = 'https://hooks.chatops.test/services/T00000000/B00000000/Xk9fQ2mZ7pLr4Tv8Wn3yHc6d';
    assert.strictEqual(fb(`const hook = process.env.SLACK_WEBHOOK_SECRET ?? "${v}";`), v);
  });
  it('control: a dev signing secret still fires', () => {
    assert.strictEqual(fb('return process.env.COLLAB_TOKEN_SECRET ?? "vapron-collab-dev-secret";'), 'vapron-collab-dev-secret');
  });
});

describe('secrets: dotted storage-key labels', () => {
  let mod;
  beforeEach(() => { mod = new SecretsModule(); });
  it('a dotted name ending in a credential word is a label', () => {
    assert.strictEqual(mod._isLabelValue('SECRET_KEY = "gluecron.pat'), true);
    assert.strictEqual(mod._isLabelValue('TOKEN_SLOT = "myext.auth.token'), true);
  });
  it('control: a dotted value with no credential word is not a label', () => {
    assert.strictEqual(mod._isLabelValue('PASSWORD = "admin.pass'), false);
  });
});
