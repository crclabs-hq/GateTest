// =============================================================================
// SECRETS — vendor-shaped credentials block in prose; generic ones do not
// =============================================================================
// Bringing documentation into scope (2026-09-01) created a second problem the
// same day. A real AWS key in SECURITY.md scored 0.3 via the doc-file
// confidence discount — soft, non-blocking, found and operationally ignored.
// Exempting the whole secrets module from that discount fixed it and broke
// something worse: axios @81df7a5 went 7 blocking -> 8, gaining NINE findings
// from its own HTTP Basic auth documentation in four languages —
//
//     docs/pages/advanced/authentication.md    password: "myPassword"
//     README.md                                password: 's00pers3cret'
//
// — which is a library explaining itself, not a leak. That was reverted.
//
// The distinction is not module-level, it is PATTERN-level:
//
//   vendor-shaped   AKIA… / sk_live_… / ghp_… / PEM header
//                   recognisable from the VALUE alone; nobody writes one to
//                   illustrate a concept          -> blocks anywhere
//   identifier-keyed  password|api_key|token = "<8+ chars>"
//                   matches any value after a keyword; exactly what auth
//                   docs contain                  -> soft in prose, blocks in code
//
// CONFIG IS NOT PROSE. A credential in .yaml/.toml/.ini/.env is real. That
// boundary has its own tests below because it is the one a later change will
// be tempted to move.
//
// Arrived at independently by gluecron-com-78's scanner on the same axios
// files, which is the strongest evidence either of us had that it is right.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SecretsModule = require('../src/modules/secrets');
const { BLOCK_THRESHOLD } = require('../src/core/confidence');

// Assembled at runtime — a literal here is rejected by push protection, and
// correctly so. See tests/secrets-docs-scanning.test.js.
const AWS_KEY = 'AKIA' + 'I0SFODNN7REALKEY';
const PEM = '-----BEGIN RSA PRIVATE KEY-----';

/** Run the module and return findings with their effective confidence. */
async function scan(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-prose-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
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

/** Did the module mark this finding confident enough to block? */
function isConfident(finding) {
  return typeof finding.meta.confidence === 'number'
    && finding.meta.confidence >= BLOCK_THRESHOLD;
}

describe('secrets — vendor-shaped credentials block in prose', () => {
  it('an AWS access key in README.md is confident', async () => {
    const found = await scan({ 'README.md': `# Setup\n\nawsKey = "${AWS_KEY}"\n` });
    assert.ok(found.length > 0, 'the key was not detected at all');
    assert.ok(isConfident(found[0]), 'an AWS key in a README must be blocking, not soft');
  });

  // A real PEM body is 64-column base64. The fixture carries one such line so
  // the test asserts what it claims: a KEY in docs blocks.
  const PEM_BODY = 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AW2fD1jsJ6fCJgq1gz0i';

  it('a PEM key in docs/setup.md is confident', async () => {
    const found = await scan({ 'docs/setup.md': `# Setup\n\n${PEM}\n${PEM_BODY}\n` });
    assert.ok(found.length > 0, 'the private key was not detected at all');
    assert.ok(isConfident(found[0]), 'a PEM key in docs must be blocking');
  });

  it('a single-line env-style PEM with a literal \\n body is still detected', async () => {
    const found = await scan({ 'docs/setup.md': `Set it like this:\n\nKEY="${PEM}\\n${PEM_BODY}\\n-----END RSA PRIVATE KEY-----"\n` });
    assert.ok(found.length > 0, 'a one-line PEM with real material must be detected');
  });

  it('control: a PEM header followed by an ellipsis placeholder is the FORMAT, not a key', async () => {
    // docs/ops/GO_LIVE_RUNBOOK.md blocked the self-scan at confidence 1.0 on
    // exactly this: `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END…`.
    const found = await scan({ 'docs/setup.md': `# Setup\n\nPaste the whole file, e.g. \`${PEM}\\nMIIE...\\n-----END RSA PRIVATE KEY-----\`\n` });
    assert.strictEqual(found.length, 0, 'a header with no key material behind it must not be reported');
    const found2 = await scan({ 'docs/setup.md': `# Setup\n\n${PEM}\nMIIEow...\n-----END RSA PRIVATE KEY-----\n` });
    assert.strictEqual(found2.length, 0, 'a multi-line placeholder body must not be reported either');
  });
});

describe('secrets — identifier-keyed patterns stay soft in prose', () => {
  // The axios cases, verbatim.
  const DOC_CASES = {
    'password example (axios auth docs)': 'password: "myPassword"\n',
    'password slug (axios README)': "password: 's00pers3cret'\n",
    'api key example': 'apiKey: "abcd1234efgh5678"\n',
  };

  for (const [why, body] of Object.entries(DOC_CASES)) {
    it(`soft, not blocking: ${why}`, async () => {
      const found = await scan({ 'docs/authentication.md': `# Auth\n\n${body}` });
      for (const f of found) {
        assert.ok(
          !isConfident(f),
          `${why} must not block — this is what auth documentation looks like`,
        );
      }
    });
  }

  it('the SAME generic pattern in code is not softened by this rule', async () => {
    // The load-bearing half. If prose handling leaked into source files, every
    // hardcoded password in real code would go quiet.
    const found = await scan({ 'src/config.ts': 'const password = "myPassword";\n' });
    assert.ok(found.length > 0, 'a hardcoded password in source must still be reported');
    for (const f of found) {
      assert.notStrictEqual(
        f.meta.confidence, 0.3,
        'source files must not receive the doc-file discount',
      );
    }
  });
});

describe('secrets — config formats are NOT prose', () => {
  // A credential in a config file is real regardless of pattern shape. This is
  // the boundary most likely to be widened carelessly later.
  const CONFIG_FILES = {
    'app.yaml': 'database:\n  password: "myPassword"\n',
    'config.toml': 'password = "myPassword"\n',
    'settings.ini': '[db]\npassword = "myPassword"\n',
  };

  for (const [name, body] of Object.entries(CONFIG_FILES)) {
    it(`${name} is treated as configuration, not documentation`, async () => {
      const found = await scan({ [name]: body });
      assert.ok(found.length > 0, `${name}: credential not detected`);
      for (const f of found) {
        assert.notStrictEqual(
          f.meta.confidence, 0.3,
          `${name} must not receive the doc-file discount — config is not prose`,
        );
      }
    });
  }
});
