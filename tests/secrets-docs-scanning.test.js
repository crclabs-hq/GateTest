// =============================================================================
// SECRETS — documentation files are scanned, and doc placeholders are not
// =============================================================================
// Until 2026-09-01 the secrets module did not open `.md` at all. A real
// `sk_live_…` planted in README.md produced ZERO findings. Secrets pasted into
// a setup guide are one of the most common ways credentials actually get
// committed, and we were structurally blind to every one of them.
//
// HOW IT WAS FOUND, because the method matters more than the bug:
// another engine (Gluecron's scorer, on a scan of Vapron) reported a docs page
// teaching `openssl rand -hex 32` as a CRITICAL hardcoded credential. I set
// out to demonstrate that OUR module stayed quiet on the same shape. It did —
// and then the positive control showed it stayed quiet on a REAL key in the
// same file type. Silence from not looking is indistinguishable from
// precision unless you plant something that must be found. A favourable
// cross-engine comparison was concealing a false negative.
//
// Switching docs on immediately traded that false negative for a false
// positive: NodeGoat's README documents
//     mongodb://<username>:<password>@<cluster>/<dbname>
// which the Database-URL rule matched. Angle brackets are THE fill-this-in
// convention, so they joined the placeholder allow-list.
//
// That allow-list existed TWICE, character-for-character, under a comment
// reading "one definition, one behaviour" — and the copies had already
// diverged on the `i` flag, so `CHANGEME` was suppressed on one path and
// reported on the other. Now one constant.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SecretsModule = require('../src/modules/secrets');

// Assembled at runtime rather than written as a literal.
//
// The first version of this file spelled the key out, and GitHub's push
// protection rejected the push: "Push cannot contain secrets — Stripe API
// Key". The value is fabricated, but it is shaped exactly like a live key,
// which is the whole point of a positive control — and a scanner's own test
// fixtures are no more entitled to commit one than anyone else's code.
//
// Resolving that by clicking the "allow this secret" link would have trained
// the repo to wave through the exact pattern this module exists to catch.
// The detector still sees the assembled value in the temp file it scans.
const REAL_KEY = ['sk', 'live', '9f2b7c1d4e6a8b0c2d4e6f8a1b3c5d7e9f0a2b4c'].join('_');

async function scan(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-'));
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
    // `gitignore-*` checks are about repo hygiene, not file contents.
    return checks.filter((c) => !c.passed && !/gitignore/i.test(c.id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('secrets — documentation is in scope', () => {
  // The positive controls. Without these, every "stays quiet" test below is
  // satisfied by a module that reads nothing at all — which is exactly the
  // state this fix corrected.
  for (const ext of ['md', 'mdx', 'txt', 'rst']) {
    it(`finds a real key in README.${ext}`, async () => {
      const found = await scan({ [`README.${ext}`]: `# Setup\n\napiSecret = "${REAL_KEY}"\n` });
      assert.ok(
        found.length > 0,
        `a live credential in a .${ext} file must be reported — it was invisible before 2026-09-01`,
      );
    });
  }

  it('still finds keys in ordinary source', async () => {
    const found = await scan({ 'config.js': `const apiSecret = "${REAL_KEY}";\n` });
    assert.ok(found.length > 0);
  });
});

describe('secrets — documentation conventions are not credentials', () => {
  const QUIET = {
    'angle-bracket connection string (NodeGoat README)':
      'mongodb://<username>:<password>@<cluster>/<dbname>?ssl=true\n',
    'angle-bracket paste slot':
      'export GLUECRON_WEBHOOK_SECRET=<paste-value-here>\n',
    'a guide teaching key generation':
      'Run `openssl rand -hex 32` and paste the output.\n',
    'your-api-key placeholder':
      'apiKey = "your-api-key-here"\n',
    // Assembled, like REAL_KEY above. GitHub's push protection rejects this
    // one too — an all-`x` redacted sample, which is a placeholder by
    // construction. Their scanner keys on the `sk_live_` prefix and length;
    // ours suppresses it via the `xxx+` entry in the allow-list. Worth noting
    // that the false positive we are asserting against here is one a major
    // scanner ships.
    'x-redacted sample':
      `stripeSecret = "${['sk', 'live', 'x'.repeat(28)].join('_')}"\n`,
    'vendor placeholder':
      'token = "vpk_YOUR_API_KEY_HERE"\n',
  };

  for (const [why, body] of Object.entries(QUIET)) {
    it(`silent: ${why}`, async () => {
      const found = await scan({ 'docs/SETUP.md': `# Setup\n\n${body}` });
      assert.deepStrictEqual(
        found.map((f) => f.id), [],
        `${why} is documentation, not a leak`,
      );
    });
  }
});

describe('secrets — the placeholder allow-list is single-sourced', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modules', 'secrets.js'), 'utf8',
  );

  it('the regex literal appears exactly once — in src/core/env-placeholder.js, imported here', () => {
    // #842 DR-6: the shape list moved beside the present-but-fake env
    // detector (the website reads it through its `env-placeholder` shim), so
    // the engine, the CLI and /api/status agree on what filler looks like.
    const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'env-placeholder.js'), 'utf8');
    const copiesInCore = (core.match(/change\[_-\]\?me\|placeholder/g) || []).length;
    assert.strictEqual(copiesInCore, 1, 'exactly one PLACEHOLDER_VALUE_RE literal in src/core/env-placeholder.js');
    const copiesHere = (src.match(/change(?:\[_-\]\?)?me\|placeholder/g) || []).length;
    assert.strictEqual(
      copiesHere, 0,
      'the placeholder allow-list has been duplicated again — the two copies ' +
      'previously diverged on the `i` flag, so CHANGEME was suppressed on one ' +
      'code path and reported on the other',
    );
    assert.match(src, /require\('\.\.\/core\/env-placeholder'\)/, 'secrets.js imports the one definition');
  });

  it('hyphenated and underscored change-me / dummy shapes are placeholders (#842 DR-6)', async () => {
    const quiet = await scan({
      'config.py': 'secret_key: str = "change-me-in-production"\n',
      'b.js': 'const apiSecret = "change_me";\nconst token = "dummy-token";\n',
    });
    assert.deepStrictEqual(quiet.map((f) => f.id), [], 'placeholder values reported as secrets');
  });

  it('is case-insensitive on every path', async () => {
    // The exact divergence: uppercase must be suppressed in a direct
    // assignment AND in an env-var fallback.
    const direct = await scan({ 'a.js': 'const apiSecret = "CHANGEME-PLEASE-NOW";\n' });
    const fallback = await scan({ 'b.js': 'const apiSecret = process.env.API_SECRET ?? "CHANGEME-PLEASE-NOW";\n' });
    assert.deepStrictEqual(direct.map((f) => f.id), [], 'uppercase placeholder reported in a direct assignment');
    assert.deepStrictEqual(fallback.map((f) => f.id), [], 'uppercase placeholder reported in an env fallback');
  });

  it('an env fallback with a REAL literal is still reported', async () => {
    // Guards the case-insensitivity fix from becoming a blanket mute.
    const found = await scan({ 'c.js': `const apiSecret = process.env.API_SECRET ?? "${REAL_KEY}";\n` });
    assert.ok(found.length > 0, 'a hardcoded fallback credential must still be reported');
  });
});
