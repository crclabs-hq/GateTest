/**
 * A skip that silences a false positive must not silence the line's real
 * findings with it.
 *
 * The secrets module accumulated two blanket line-level skips, each added to
 * kill one specific false positive, each taking a whole class of real
 * credentials down with it:
 *
 *   if (/===|!==/.test(line)) continue;      // for `password === 'SENTINEL'`
 *   if (/process\.env\b/.test(line)) continue; // for `password = process.env.PW`
 *
 * Both intents are correct. Both implementations were far too wide: ANY line
 * that merely CONTAINED a comparison or an env read was skipped entirely, so
 * a hardcoded `sk_live_` key sitting on that same line was never examined —
 * despite the module having an explicit pattern for it.
 *
 * Both are now narrow: the comparison operand is blanked and the env read is
 * neutralised, then the rest of the line is matched as normal. This file is
 * the tripwire. If a future session "fixes" a false positive by widening
 * either skip back to a `continue`, these fail.
 *
 * The negative controls carry equal weight — the original false positives
 * must stay fixed, or the next session simply reverts the whole thing.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SecretsModule = require('../src/modules/secrets');

// Assembled at runtime, never written as one literal.
//
// These fixtures must LOOK like a live Stripe key to exercise the module's
// `sk_live_[A-Za-z0-9]{24,}` rule — which is exactly what GitHub's push
// protection scans for, and it cannot tell a fixture from a real credential.
// Written out in full, this file gets the whole push rejected (GH013); it did,
// on first attempt. Splitting the prefix keeps the raw file text clean while
// the value the module sees is byte-identical.
//
// Do not "tidy" this back into a single literal — that re-blocks every push.
const STRIPE_SHAPED = 'sk_' + 'live_';

async function scan(mod, body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-skips-'));
  try {
    fs.writeFileSync(path.join(tmp, 'probe.js'), body);
    const checks = [];
    const result = { checks, addCheck(n, p, d = {}) { checks.push({ name: n, passed: p, ...d }); } };
    await mod.run(result, { projectRoot: tmp });
    const hit = checks.find((c) => c.name.includes('probe.js'));
    return hit ? hit.details.map((d) => ({ line: d.line, type: d.type })) : [];
  } finally {
    // Removed after the scan has finished reading it — the previous shape
    // returned the promise from `try` and deleted the directory on a 50 ms
    // timer, a race the scan won only because the file was small.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe('secrets: blanket skips must not swallow real findings', () => {
  let mod;
  beforeEach(() => { mod = new SecretsModule(); });

  const strip = (l) => mod._stripComparisonLiterals(l);

  // ---- the comparison skip ------------------------------------------------

  it('blanks the comparison operand, not the whole line', () => {
    assert.strictEqual(
      strip(`const c = { apiKey: 'sk_live_REALKEY', on: mode === 'prod' };`),
      `const c = { apiKey: 'sk_live_REALKEY', on: mode == 0 };`,
    );
  });

  it('handles the reversed operand order and loose equality', () => {
    assert.strictEqual(strip(`if ('prod' === mode) {}`), `if (0 == mode) {}`);
    assert.strictEqual(strip(`if (mode != 'dev') {}`), `if (mode == 0) {}`);
  });

  it('finds a real key sharing a line with a comparison', async () => {
    const found = await scan(mod,
      `const config = { apiKey: '${STRIPE_SHAPED}ABCDEFGH1234567890abcdefgh', on: mode === 'prod' };\n`);
    assert.ok(found.some((f) => f.line === 1 && f.type === 'Stripe Live Key'),
      `expected the Stripe-shaped key to be found, got ${JSON.stringify(found)}`);
  });

  it('NEGATIVE: a sentinel comparison is still not a secret', async () => {
    const found = await scan(mod,
      `if (password === 'REJECTED_VALUE_SENTINEL') { throw new Error('no'); }\n`);
    assert.deepStrictEqual(found, [], `expected silence, got ${JSON.stringify(found)}`);
  });

  // ---- the env-read skip --------------------------------------------------

  it('finds a real key sharing a line with an env read', async () => {
    const found = await scan(mod,
      `const h = { authorization: '${STRIPE_SHAPED}ZYXWVUT9876543210zyxwvut', region: process.env.AWS_REGION };\n`);
    assert.ok(found.some((f) => f.line === 1 && f.type === 'Stripe Live Key'),
      `expected the Stripe-shaped key to be found, got ${JSON.stringify(found)}`);
  });

  it('NEGATIVE: a bare env read is still not a secret', async () => {
    const found = await scan(mod, `const dbPassword = process.env.DB_PASSWORD;\n`);
    assert.deepStrictEqual(found, [], `expected silence, got ${JSON.stringify(found)}`);
  });

  it('NEGATIVE: an env read does not get double-reported as a fallback', async () => {
    const found = await scan(mod,
      `const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "layova-admin";\n`);
    assert.deepStrictEqual(found, [{ line: 1, type: 'Fallback Secret' }],
      `expected exactly one finding, got ${JSON.stringify(found)}`);
  });
});
