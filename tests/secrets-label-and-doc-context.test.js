// =============================================================================
// SECRETS — values that NAME things, lines that DOCUMENT things (2026-09-14)
// =============================================================================
// Three clean third-party repos scanned with `--suite standard`; every
// blocking `secrets:` finding opened at its line, none a credential:
//
//   django/django   docs/_ext/djangodocs.py:290        token = "make.bat"
//   django/django   django/contrib/auth/views.py:262   reset_url_token = "set-password"
//   django/django   django/contrib/auth/views.py:246   INTERNAL_RESET_SESSION_TOKEN = "_password_reset_token"
//   django/django   django/template/base.py:746        >>> token = 'variable|default:"…"'   (a doctest)
//   sindresorhus/got source/core/options.ts:260        secret: 'passphrase'                 (inside a TSDoc example)
//
// (The security module's half of the same day — AWS's published example key
// reported inside secrets.js's own list, and a rollup that blocked harder
// than its constituents — is tests/security-example-key-and-rollup.test.js.)
//
// Every relaxation below carries its still-fires half. A rule that stopped
// working and a rule that learned a shape look identical from the outside
// without one.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SecretsModule = require('../src/modules/secrets');

// Assembled at runtime — a literal vendor prefix is rejected by push protection.
const STRIPE_LIVE = ['sk', 'live', '9f2b7c1d4e6a8b0c2d4e6f8a1b3c5d7e9f0a2b4c'].join('_');
const GITHUB_PAT = 'ghp_' + 'Q7x2P9m4K8r3T6v1W5y8Z0a3B6c9D2e5F8g1H4j7';
// AKIA + 16 that is neither the published example nor a typed run.
const AWS_KEY = 'AKIA' + 'Q7X2P9M4K8R3T6V1';

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-label-'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.env\n*.pem\n*.key\n');
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

/** Run the secrets module; return the failed `secrets:<file>` checks. */
async function secrets(files) {
  const root = repo(files);
  try {
    const checks = [];
    const result = { addCheck(id, passed, meta) { checks.push({ id, passed, ...(meta || {}) }); }, addInfo() {} };
    await new SecretsModule().run(result, { projectRoot: root });
    return checks.filter((c) => !c.passed && /^secrets:(?!gitignore|tracked)/.test(c.id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Lines the secrets module reported for `file`, or [] when it stayed quiet. */
async function secretLines(files, file) {
  const hit = (await secrets(files)).find((c) => c.id === `secrets:${file}`);
  // Distinct lines: a Stripe key assigned to `secret` is reported by both
  // the identifier-keyed and the vendor-shaped rule, which is fine — the
  // question here is which LINES fired.
  return hit ? [...new Set(hit.details.map((d) => d.line))] : [];
}

describe('secrets — a value that NAMES something is not a credential', () => {
  it('silent: django docs/_ext/djangodocs.py — token = "make.bat" is a filename', async () => {
    assert.deepStrictEqual(await secretLines({
      'docs/_ext/djangodocs.py': [
        'def visit_console_html(self, node):',
        '    for token in cmdline.split():',
        '        if token == "make":',
        '            token = "make.bat"',
        '            changed = True',
        '',
      ].join('\n'),
    }, 'docs/_ext/djangodocs.py'), []);
  });

  it('silent: django auth/views.py — reset_url_token = "set-password" is a URL slug', async () => {
    assert.deepStrictEqual(await secretLines({
      'django/contrib/auth/views.py': [
        'INTERNAL_RESET_SESSION_TOKEN = "_password_reset_token"',
        '',
        'class PasswordResetConfirmView(PasswordContextMixin, FormView):',
        '    reset_url_token = "set-password"',
        '',
      ].join('\n'),
    }, 'django/contrib/auth/views.py'), []);
  });

  it('silent: a filename with a key-file extension is still a filename', async () => {
    assert.deepStrictEqual(await secretLines({
      'src/tls.js': "const keyPath = 'server.key';\nconst token = 'client-cert.pem';\n",
    }, 'src/tls.js'), []);
  });

  it('fires: a slug that does not name a credential is a weak password (layova-admin)', async () => {
    assert.deepStrictEqual(await secretLines({
      'src/auth.js': "const password = 'layova-admin';\n",
    }, 'src/auth.js'), [1]);
  });

  it('fires: password = "password" is a weak default, not a label (corpus6 pin)', async () => {
    assert.deepStrictEqual(await secretLines({
      'src/users.ts': "    password: 'password',\n",
    }, 'src/users.ts'), [1]);
  });

  it('fires: a high-entropy value is a credential even when it ends in an extension', async () => {
    // Long, mixed letters and digits, 3.5+ bits/char: no filename rule may
    // quiet it. (`.key` is on the extension list precisely so that
    // `keyPath = 'server.key'` is a path — the entropy guard is what keeps
    // the two apart.)
    assert.deepStrictEqual(await secretLines({
      'src/cfg.js': "const token = 'x9Fq2Lm8vB4nZ7kQ1wR5tY3.key';\n",
    }, 'src/cfg.js'), [1]);
  });

  it('fires: a Stripe key assigned to a name still fires (vendor-shaped never reaches the label rule)', async () => {
    assert.deepStrictEqual(await secretLines({
      'src/pay.js': `const secret = '${STRIPE_LIVE}';\n`,
    }, 'src/pay.js'), [1]);
  });
});

describe('secrets — a line that DOCUMENTS is not an assignment', () => {
  it('silent: got source/core/options.ts — secret: \'passphrase\' inside a TSDoc fenced example', async () => {
    assert.deepStrictEqual(await secretLines({
      'source/core/options.ts': [
        '/**',
        'Hooks allow modifications during the request lifecycle.',
        '',
        '@example',
        '```',
        "import got from 'got';",
        '',
        'const {headers} = await instance(',
        "\t'https://httpbin.org/anything',",
        '\t{',
        "\t\tsecret: 'passphrase'",
        '\t}',
        ').json();',
        '```',
        '*/',
        'export type Hooks = {};',
        '',
      ].join('\n'),
    }, 'source/core/options.ts'), []);
  });

  it('silent: django template/base.py — a `>>>` doctest inside a docstring', async () => {
    assert.deepStrictEqual(await secretLines({
      'django/template/base.py': [
        'class FilterExpression:',
        '    """',
        '    Parse a variable token and its optional filters, e.g.',
        '',
        '        >>> token = \'variable|default:"Default value"|date:"Y-m-d"\'',
        '        >>> p = Parser(\'\')',
        '    """',
        '',
        '    def __init__(self, token, parser):',
        '        pass',
        '',
      ].join('\n'),
    }, 'django/template/base.py'), []);
  });

  it('silent: a `>>>` doctest line in a .rst is documentation wherever it sits', async () => {
    const found = await secrets({ 'docs/api.rst': ">>> token = 'variable|default:abcdef'\n" });
    assert.deepStrictEqual(found, []);
  });

  it('fires: the same assignment as CODE below the docstring still fires', async () => {
    assert.deepStrictEqual(await secretLines({
      'src/settings.py': [
        '"""',
        'Settings.',
        '"""',
        '',
        'PASSWORD = "k4j8s9d2f7g1h3j5l0z9x8c7v6b5n4m3"',
        '',
      ].join('\n'),
    }, 'src/settings.py'), [5]);
  });

  it('fires: an .env body inlined in a JS template literal is a committed credential', async () => {
    // Only Python multi-line strings are docstrings; a backtick block that
    // holds config is config.
    assert.deepStrictEqual(await secretLines({
      'src/inline-env.js': [
        'const env = `',
        'DB_PASSWORD="k4j8s9d2f7g1h3j5l0z9x8c7v6b5n4m3"',
        '`;',
        '',
      ].join('\n'),
    }, 'src/inline-env.js'), [2]);
  });

  it('fires: a vendor-shaped key inside a block comment is still a key', async () => {
    assert.deepStrictEqual(await secretLines({
      'src/notes.js': [
        '/*',
        `  rotate this one: ${GITHUB_PAT}`,
        '*/',
        '',
      ].join('\n'),
    }, 'src/notes.js'), [2]);
  });

  it('silent: the source of a regex literal describes a shape, not a value', async () => {
    assert.deepStrictEqual(await secretLines({
      'src/detector.js': `const AWS_RE = /${AWS_KEY}/g;\n`,
    }, 'src/detector.js'), []);
  });

  it('fires: the same text in quotes is a value', async () => {
    assert.deepStrictEqual(await secretLines({
      'src/detector.js': `const AWS_ID = '${AWS_KEY}';\n`,
    }, 'src/detector.js'), [1]);
  });
});

