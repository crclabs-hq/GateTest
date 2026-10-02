'use strict';

// Credential-exposure and disclosure rules (src/core/disclosure-rules.js) and
// error-swallow:destructive-then-forget — built against Tallrig's bug corpus
// (scored by scripts/cross-test-score.js). Every rule has a control pair: the
// shape that fires it and the fixed / idiomatic shape that must stay quiet.
// The fixtures are written here from the defect CLASS — the corpus itself is
// private and never committed to this public repository.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { urlCredentialParam, errorDetailLeak, weakKdf } = require('../src/core/disclosure-rules');
const ErrorSwallowModule = require('../src/modules/error-swallow');

const L = (src) => src.split('\n');

describe('url-credential-param', () => {
  it('fires: a stream handler takes the session token from ?token= and validates it', () => {
    const src = L([
      'app.get("/events", async (c) => {',
      '  const t = c.req.query("token");',
      '  const userId = await validateSession(t, db);',
      '  if (!userId) return c.json({ error: "bad" }, 401);',
      '});',
    ].join('\n'));
    assert.equal(urlCredentialParam('a.ts', src).length, 1);
  });
  it('fires: the absence is answered 401 "Missing session token" (validator further down)', () => {
    const src = L(['const q = url.searchParams.get("token");', 'if (!q) return new Response("Missing session token", { status: 401 });'].join('\n'));
    assert.equal(urlCredentialParam('a.ts', src).length, 1);
  });
  it('control: the fixed form REFUSES ?token= with 401', () => {
    const src = L([
      'if (c.req.query("token") !== undefined) {',
      '  return c.json({ error: "Session tokens in the URL are not accepted" }, 401);',
      '}',
      'const ticket = c.req.query("ticket");',
      'const userId = redeemTicket(ticket);',
    ].join('\n'));
    assert.equal(urlCredentialParam('a.ts', src).length, 0);
  });
  it('control: a single-purpose capability link (unsubscribe/invite) is not a session credential', () => {
    const src = L(['const t = req.query.token;', 'await unsubscribeByToken(t);', 'res.send("You are unsubscribed");'].join('\n'));
    assert.equal(urlCredentialParam('a.ts', src).length, 0);
  });
  it('fires on the client: a session token written into an EventSource URL', () => {
    const src = L(['const token = getSessionToken();', 'const url = new URL("/stream", base);', 'url.searchParams.set("token", token);'].join('\n'));
    assert.equal(urlCredentialParam('a.ts', src).length, 1);
  });
  it('control: a non-session value in a token-named param on the client stays quiet', () => {
    const src = L(['const page = cursor.next;', 'url.searchParams.set("token", page);'].join('\n'));
    assert.equal(urlCredentialParam('a.ts', src).length, 0);
  });
});

describe('error-detail-leak', () => {
  it('fires: a customer-facing note names the API key variable', () => {
    const src = L(['return {', '  items: [],', '  note: "Suggestions unavailable — OPENAI_API_KEY not configured.",', '};'].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 1);
  });
  it('control: the same sentence in a log line, or kept in an operator-only field, stays quiet', () => {
    const src = L([
      'const detail = "OPENAI_API_KEY is not configured";',
      'console.warn(`[search] skipped: ${detail}`);',
      'return { items: [], note: "Suggestions are unavailable right now.", operatorDetail: detail };',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 0);
  });
  it('fires: config errors name env vars AND a route returns err.message to the client', () => {
    const src = L([
      'function authUrl() {',
      '  if (!id) throw new Error("Set GITLAB_OAUTH_CLIENT_ID and GITLAB_OAUTH_CLIENT_SECRET.");',
      '}',
      'app.get("/start", (c) => {',
      '  try { return c.redirect(authUrl()); } catch (err) {',
      '    const message = err instanceof Error ? err.message : "error";',
      '    return c.json({ error: message }, 500);',
      '  }',
      '});',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 1);
  });
  it('control: the same file that logs err.message and redirects neutrally stays quiet', () => {
    const src = L([
      'function authUrl() {',
      '  if (!id) throw new Error("Set GITLAB_OAUTH_CLIENT_ID and GITLAB_OAUTH_CLIENT_SECRET.");',
      '}',
      'app.get("/start", (c) => {',
      '  try { return c.redirect(authUrl()); } catch (err) {',
      '    console.error("[oauth] start failed:", err instanceof Error ? err.message : err);',
      '    return c.redirect("/login?error=unavailable");',
      '  }',
      '});',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 0);
  });
});

describe('weak-kdf', () => {
  it('fires: an encryption key made by sha256 of an env secret', () => {
    const src = L(['export function deriveKey(secret) {', '  return createHash("sha256")', '    .update(secret)', '    .digest();', '}'].join('\n'));
    assert.equal(weakKdf('a.ts', src).length, 1);
  });
  it('control: a content hash used as an id (hex digest, no key context) stays quiet', () => {
    const src = L(['function etag(body) {', '  return createHash("sha256").update(body).digest("hex");', '}'].join('\n'));
    assert.equal(weakKdf('a.ts', src).length, 0);
  });
  it('control: HKDF derivation stays quiet', () => {
    const src = L(['function deriveKey(secret) {', '  return Buffer.from(hkdfSync("sha256", secret, salt, "at-rest-v1", 32));', '}'].join('\n'));
    assert.equal(weakKdf('a.ts', src).length, 0);
  });
});

describe('error-swallow:destructive-then-forget', () => {
  async function run(src) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dtf-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'm.ts'), src);
      const checks = [];
      await new ErrorSwallowModule().run(
        { addCheck: (name, passed, d = {}) => checks.push({ name, passed, ...d }) },
        { projectRoot: root, getModuleConfig: () => ({}) },
      );
      return checks.filter((c) => /destructive-then-forget/.test(c.name));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  it('fires: a failed drop is logged, then the tracking row is deleted', async () => {
    const hits = await run([
      'export async function removeTenant(row) {',
      '  try {',
      '    await dropDatabase(row.dbName);',
      '  } catch (error) {',
      '    const msg = error instanceof Error ? error.message : String(error);',
      '    console.error(`drop failed: ${msg}`);',
      '  }',
      '  await db.delete(tenants).where(eq(tenants.id, row.id));',
      '}',
    ].join('\n'));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
  });
  it('control: the catch returns, so the row is deleted only on success', async () => {
    const hits = await run([
      'export async function removeTenant(row) {',
      '  try {',
      '    await dropDatabase(row.dbName);',
      '  } catch (error) {',
      '    return fail("drop failed — database still exists", error);',
      '  }',
      '  await db.delete(tenants).where(eq(tenants.id, row.id));',
      '}',
    ].join('\n'));
    assert.equal(hits.length, 0);
  });
  it('control: a non-destructive call that fails soft before a delete stays quiet', async () => {
    const hits = await run([
      'async function close(row) {',
      '  try {',
      '    await notifyOwner(row);',
      '  } catch (error) {',
      '    console.warn("notify failed", error);',
      '  }',
      '  await db.delete(sessions).where(eq(sessions.id, row.id));',
      '}',
    ].join('\n'));
    assert.equal(hits.length, 0);
  });
});

describe('cross-test harness (scripts/cross-test-score.js)', () => {
  const { splitSnippet, grade, score } = require('../scripts/cross-test-score');
  it('splits a multi-location snippet at its "// ... path:line" separators', () => {
    const files = splitSnippet('// ... a/x.ts:10\nconst a = 1;\n// ... b/y.ts:3\nconst b = 2;', 'a/x.ts');
    assert.deepEqual(files.map((f) => f.file), ['a/x.ts', 'b/y.ts']);
  });
  it('grades caught only when a class-mapped finding disappears on the fix; survivors are noise', () => {
    const entry = { class: 'secret-in-url-query', status: 'fixed' };
    const hit = { module: 'security', ruleId: 'security:url-credential-param', file: 'a.ts' };
    const generic = { module: 'codeQuality', ruleId: 'quality:x', file: 'a.ts' };
    assert.equal(grade(entry, [hit], [], ['a.ts']).grade, 'caught');
    assert.equal(grade(entry, [hit], [hit], ['a.ts']).grade, 'missed', 'a finding that survives the fix is noise');
    assert.equal(grade(entry, [generic], [], ['a.ts']).grade, 'partial');
    assert.equal(grade({ ...entry, status: 'open' }, [hit], null, ['a.ts']).grade, 'caught');
  });
  it('the score formula is (caught + 0.5 × partial) / scored', () => {
    const s = score([{ grade: 'caught', severity: 'P1' }, { grade: 'partial', severity: 'P1' }, { grade: 'missed', severity: 'P2' }, { grade: 'missed', severity: 'P2', status: 'withdrawn' }]);
    assert.equal(s.scored, 3);
    assert.equal(s.catchRate, 0.5);
  });
});
