// =============================================================================
// SECRETS — the value tested is the MATCHED value, never a neighbouring one
// =============================================================================
// gluecron-com-78 shipped a bug worth inheriting the test for, not the bug:
// their identifier-keyed rules had no capture group, so the detector fell back
// to "the first quoted string on the line". Given axios's documented shape
//
//     auth: { username: 'janedoe', password: 's00pers3cret' }
//
// it extracted `janedoe` — a preceding VALUE, seven characters, judged too
// short to be a secret — and reported nothing. A real password went unreported
// because another field sat to its left. Their fallback's own comment warned
// about picking up a preceding KEY name; the case that occurs is a preceding
// value.
//
// We are immune, and these tests exist so we stay immune rather than remain so
// by accident. Two structural properties do it, and both are easy to break
// while editing patterns:
//
//   1. Every identifier-keyed regex begins at the keyword and allows only
//      `\s*[:=]` or a quote-free type annotation (`: str =`, IDENT_ASSIGN in
//      secrets.js) before the value, so a match can never begin before the
//      keyword and can never span a preceding field.
//   2. Value-based suppression reads `m[0]` — the match — not the line.
//      `_looksLikeReference` documents this invariant explicitly: "match is
//      the secrets regex hit, which always begins at the identifier, so the
//      first quote in it is always the value's opening quote."
//
// Add a pattern that can match before its keyword, or re-derive the value from
// the line, and these fail.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SecretsModule = require('../src/modules/secrets');

// Assembled — a literal is rejected by push protection, correctly.
const AWS = 'AKIA' + 'I0SFODNN7REALKEY';
const GHP = 'ghp_' + '16CharsMinimum0000000000000000000000';
const SK = 'sk_live_' + '51H8xQ2eZvKYlo2CkqB9mVxNvR7dPqW3sTuV';

async function fires(source, filename = 'config.js') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-extract-'));
  try {
    fs.writeFileSync(path.join(root, filename), source);
    const checks = [];
    const result = {
      addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); },
      addInfo() {},
    };
    await new SecretsModule().run(result, { projectRoot: root });
    return checks.some((c) => !c.passed && !/gitignore/i.test(c.id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('secrets — a preceding field does not hide the credential', () => {
  const CASES = {
    'alone on the line': `const c = { password: 's00pers3cret' };\n`,
    // The exact shape from axios's README that broke the other engine.
    'preceded by a short value': `const c = { username: 'janedoe', password: 's00pers3cret' };\n`,
    'axios docs verbatim': `auth: { username: 'janedoe', password: 's00pers3cret' }\n`,
    'preceded by two fields': `const c = { a: 'x', b: 'y', secret: 'hunter2SuperLongValue' };\n`,
    'apiKey after a short value': `const c = { user: 'bob', apiKey: 'abcd1234efgh5678' };\n`,
  };

  for (const [why, src] of Object.entries(CASES)) {
    it(`fires: ${why}`, async () => {
      assert.strictEqual(
        await fires(src), true,
        `a credential was missed because of what sits to its left:\n  ${src.trim()}`,
      );
    });
  }
});

describe('secrets — a placeholder-shaped NAME does not suppress a real value', () => {
  // The mirror of the above: suppression reads the match, and the match for a
  // vendor-shaped credential is the key itself, so a reassuring variable name
  // cannot silence it. gluecron's engine had the opposite failure — firing
  // BECAUSE of a variable name (`CELITECH_TOKEN_URL`). One design choice,
  // two opposite ways to be wrong.
  const CASES = {
    'your_api_key holding a real AWS key': `const your_api_key = "${AWS}";\n`,
    'yourApiKey holding a real GitHub PAT': `const yourApiKey = "${GHP}";\n`,
    'changeme_token holding a real PAT': `const changeme_token = "${GHP}";\n`,
    'exampleKey holding a real Stripe key': `const exampleKey = "${SK}";\n`,
    'placeholder_secret holding a real Stripe key': `const placeholder_secret = "${SK}";\n`,
  };

  for (const [why, src] of Object.entries(CASES)) {
    it(`fires: ${why}`, async () => {
      assert.strictEqual(
        await fires(src), true,
        `a real credential was suppressed by its variable NAME:\n  ${src.trim()}`,
      );
    });
  }

  it('but a placeholder VALUE is still suppressed', async () => {
    // The load-bearing negative. Without it, "never suppress" would pass
    // every test above and reintroduce the false positives the allow-list
    // exists to prevent.
    assert.strictEqual(
      await fires(`const apiSecret = "changeme-please-now";\n`), false,
      'a placeholder value must still be suppressed',
    );
  });
});
