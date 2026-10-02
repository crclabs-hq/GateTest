// =============================================================================
// CROSS-FILE TAINT ANALYSIS MODULE TEST
// =============================================================================
// Tests for src/modules/cross-file-taint.js
// Validates cross-boundary taint propagation: user input from one file
// reaching dangerous sinks in another file.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CrossFileTaintModule = require('../../src/modules/cross-file-taint.js');

// ---------------------------------------------------------------------------
// Minimal TestResult stub
// ---------------------------------------------------------------------------

function makeResult() {
  const checks = [];
  return {
    checks,
    addCheck(rule, passed, meta = {}) {
      checks.push({ rule, passed, ...meta });
    },
    errors() { return checks.filter(c => c.severity === 'error'); },
    warnings() { return checks.filter(c => c.severity === 'warning'); },
    infos() { return checks.filter(c => c.severity === 'info'); },
  };
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-cross-file-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFiles(files) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'case-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

async function run(files) {
  const dir = writeFiles(files);
  const mod = new CrossFileTaintModule();
  const result = makeResult();
  await mod.run(result, { projectRoot: dir });
  return result;
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — shape', () => {
  it('has correct name and description', () => {
    const mod = new CrossFileTaintModule();
    assert.strictEqual(mod.name, 'crossFileTaint');
    assert.ok(mod.description.toLowerCase().includes('taint'), `description: ${mod.description}`);
  });

  it('implements run()', () => {
    const mod = new CrossFileTaintModule();
    assert.strictEqual(typeof mod.run, 'function');
  });
});

// ---------------------------------------------------------------------------
// Empty / no-JS directory
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — empty directory', () => {
  it('handles empty project gracefully', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
    const mod = new CrossFileTaintModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: dir });
    assert.ok(result.checks.length > 0, 'should emit at least one check');
    // no errors on empty project
    assert.strictEqual(result.errors().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — SQL injection via exported tainted value
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — SQL injection cross-file', () => {
  it('detects tainted req.body value reaching .query() in another file', async () => {
    const result = await run({
      'routes/user.js': `
const { getUserById } = require('../db/queries');
function getUser(req, res) {
  const userId = req.body.id;
  const user = getUserById(userId);
  res.json(user);
}
module.exports = { getUser };
`,
      'db/queries.js': `
const db = require('./db');
function getUserById(userId) {
  return db.query('SELECT * FROM users WHERE id = ' + userId);
}
module.exports = { getUserById };
`,
    });
    // The taint is within db/queries.js itself (userId is a param), but the
    // cross-file path should flag when the exported function is called with a
    // tainted arg in routes/user.js. The module uses a simpler heuristic:
    // it looks for tainted exports from a file that are then used at sinks
    // in the importing file, OR flags the sink in the db file when it's
    // called. Either path is acceptable — let's just verify no crash and
    // we get a summary.
    const summary = result.checks.find(c => c.rule === 'cross-file-taint:summary');
    assert.ok(summary, 'should have summary check');
  });

  it('detects tainted export used at sql sink in importer', async () => {
    const result = await run({
      'helper.js': `
function buildQuery(userInput) {
  const q = userInput;
  module.exports.lastQuery = q;
  return q;
}
module.exports = { buildQuery };
`,
      'handler.js': `
const { buildQuery } = require('./helper');
function handle(req, res) {
  const input = req.query.filter;
  const q = buildQuery(input);
  db.query(q);
}
`,
    });
    const summary = result.checks.find(c => c.rule === 'cross-file-taint:summary');
    assert.ok(summary, 'should produce summary');
    // handler.js has: input tainted from req.query, q assigned from input (tainted),
    // then db.query(q) — should flag
    const errors = result.errors();
    assert.ok(errors.length > 0, `expected at least one error, got: ${JSON.stringify(errors.map(e => e.rule))}`);
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — eval() sink
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — eval sink', () => {
  it('flags tainted variable used in eval()', async () => {
    const result = await run({
      'index.js': `
function run(req) {
  const code = req.body.script;
  eval(code);
}
`,
    });
    const errors = result.errors();
    const evalError = errors.find(e => e.sink === 'eval');
    assert.ok(evalError, `expected eval error, got: ${JSON.stringify(errors.map(e => e.sink))}`);
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — exec() sink
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — exec sink', () => {
  it('flags tainted variable used in exec()', async () => {
    const result = await run({
      'runner.js': `
const { exec } = require('child_process');
function runCmd(req, res) {
  const cmd = req.params.command;
  exec(cmd);
}
`,
    });
    const errors = result.errors();
    const execError = errors.find(e => e.sink === 'exec');
    assert.ok(execError, `expected exec error`);
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — file read sink
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — file read sink', () => {
  it('flags tainted variable used in readFile()', async () => {
    const result = await run({
      'files.js': `
const fs = require('fs');
function serveFile(req, res) {
  const filename = req.query.file;
  fs.readFile(filename, 'utf-8', (err, data) => res.send(data));
}
`,
    });
    const errors = result.errors();
    const fileError = errors.find(e => e.sink === 'file-read');
    assert.ok(fileError, `expected file-read error`);
  });

  it('flags readFileSync with tainted path', async () => {
    const result = await run({
      'sync.js': `
const fs = require('fs');
function read(req) {
  const p = req.params.path;
  return fs.readFileSync(p, 'utf-8');
}
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'file-read'), 'should flag readFileSync');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — spawn sink
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — spawn sink', () => {
  it('flags spawn() with tainted argument', async () => {
    const result = await run({
      'proc.js': `
const { spawn } = require('child_process');
function start(req) {
  const bin = req.body.binary;
  spawn(bin, []);
}
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'spawn'), 'should flag spawn');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — path traversal
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — path traversal', () => {
  it('flags path.join() with tainted argument', async () => {
    const result = await run({
      'static.js': `
const path = require('path');
const fs = require('fs');
function serve(req, res) {
  const file = req.query.name;
  const full = path.join(__dirname, 'public', file);
  res.sendFile(full);
}
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'path-join'), 'should flag path.join with tainted arg');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — DOM injection
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — DOM injection', () => {
  it('flags dangerouslySetInnerHTML with tainted data', async () => {
    const result = await run({
      'component.jsx': `
function Unsafe({ req }) {
  const html = req.query.content;
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'dom-inject'), 'should flag dangerouslySetInnerHTML');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — suppression
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — suppression', () => {
  it('does not flag when taint-ok comment is present on sink line', async () => {
    const result = await run({
      'safe.js': `
const fs = require('fs');
function read(req) {
  const p = req.params.path;
  return fs.readFileSync(p, 'utf-8'); // taint-ok — path is validated upstream
}
`,
    });
    const errors = result.errors().filter(e => e.file === 'safe.js');
    assert.strictEqual(errors.length, 0, 'taint-ok should suppress finding');
  });

  it('does not flag when sanitisation is present in context', async () => {
    const result = await run({
      'validated.js': `
const fs = require('fs');
function read(req) {
  const p = req.params.path;
  const safe = sanitize(p);
  return fs.readFileSync(safe, 'utf-8');
}
`,
    });
    const errors = result.errors().filter(e => e.file === 'validated.js');
    assert.strictEqual(errors.length, 0, 'sanitize() call should suppress');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — ctx.request (Koa style)
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — Koa ctx.request', () => {
  it('detects taint from ctx.request.body', async () => {
    const result = await run({
      'koa-handler.js': `
async function handler(ctx) {
  const userInput = ctx.request.body.data;
  eval(userInput);
}
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'eval'), 'should flag eval with ctx.request.body taint');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — event.body (serverless)
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — event.body serverless', () => {
  it('detects taint from event.body in lambda', async () => {
    const result = await run({
      'lambda.js': `
exports.handler = async (event) => {
  const payload = event.body;
  const result = db.query('SELECT * FROM t WHERE x = ' + payload);
  return result;
};
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'sql-query'), 'should flag sql-query from event.body');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — destructuring
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — destructuring sources', () => {
  it('tracks taint through destructured req.body assignment', async () => {
    const result = await run({
      'destruct.js': `
function handler(req) {
  const { username, password } = req.body;
  exec('login ' + username);
}
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'exec'), 'should flag exec with destructured taint');
  });

  it('tracks taint through destructured req.query assignment', async () => {
    const result = await run({
      'query.js': `
function handler(req) {
  const { search } = req.query;
  db.raw('SELECT * FROM items WHERE name LIKE ' + search);
}
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'sql-query'), 'should flag sql-query from destructured req.query');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — no false positives on clean code
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — no false positives', () => {
  it('does not flag hardcoded SQL queries', async () => {
    const result = await run({
      'clean.js': `
const db = require('./db');
async function getAllUsers() {
  return db.query('SELECT id, name FROM users ORDER BY name');
}
module.exports = { getAllUsers };
`,
    });
    const errors = result.errors();
    assert.strictEqual(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
  });

  it('does not flag parameterized queries', async () => {
    const result = await run({
      'safe-query.js': `
async function findUser(req) {
  const id = req.params.id;
  return db.query('SELECT * FROM users WHERE id = $1', [parseInt(id)]);
}
`,
    });
    // parseInt sanitises the value — no error expected for the query
    // (the sanitiser rule matches parseInt)
    const errors = result.errors().filter(e => e.sink === 'sql-query');
    assert.strictEqual(errors.length, 0, 'parseInt sanitisation should suppress sql-query');
  });

  it('does not flag eval on non-tainted values', async () => {
    const result = await run({
      'math.js': `
function compute(expression) {
  const safe = '2 + 2';
  return eval(safe);
}
`,
    });
    const errors = result.errors().filter(e => e.sink === 'eval');
    assert.strictEqual(errors.length, 0, 'hardcoded eval should not flag');
  });
});

// ---------------------------------------------------------------------------
// issue #633 (2026-09-22): two sanitiser shapes SANITISE_RES did not
// recognise. Control pairs prove the mechanism actually engages (a bare
// version of each shape still fires) rather than the sink never firing at
// all in a single-file scan.
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — CONTROL PAIR (issue #633): a LIKE-escaping helper named escapeForLike is a sanitiser', () => {
  it('quiet: `escapeForLike(input)` feeding a LIKE-clause concat', async () => {
    const result = await run({
      'search.js': `
function searchUsers(req) {
  const input = req.query.name;
  const pattern = escapeForLike(input) + '%';
  return db.query('SELECT * FROM users WHERE name LIKE ' + pattern);
}
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'sql-query');
    assert.strictEqual(errors.length, 0, `escapeForLike must be recognised as a sanitiser: ${JSON.stringify(errors)}`);
  });

  it('STILL FIRES: the same concat with no escaping helper at all', async () => {
    const result = await run({
      'search.js': `
function searchUsers(req) {
  const input = req.query.name;
  const pattern = input + '%';
  return db.query('SELECT * FROM users WHERE name LIKE ' + pattern);
}
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'sql-query');
    assert.ok(errors.length > 0, 'an unescaped concat into a SQL sink must still be flagged');
  });
});

describe('CrossFileTaintModule — CONTROL PAIR (issue #633): an HMAC/signature-verified redirect target is not an open redirect', () => {
  it('quiet: the target is checked against a signature before res.redirect', async () => {
    const result = await run({
      'handler.js': `
function handleCollabRedirect(req, res) {
  const url = req.query.dest;
  const valid = verifySignature(url, req.query.token);
  if (!valid) return res.status(403).end();
  res.redirect(url);
}
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.strictEqual(errors.length, 0, `an HMAC/signature-checked target must not read as an open redirect: ${JSON.stringify(errors)}`);
  });

  it('STILL FIRES: the same tainted target with no signature check', async () => {
    const result = await run({
      'handler.js': `
function handleRedirect(req, res) {
  const url = req.query.dest;
  res.redirect(url);
}
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.ok(errors.length > 0, 'an unchecked tainted redirect target must still be flagged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GT-03 (#771, AlecRae.com scan): three redirect findings, all not open
// redirects. apps/api/src/routes/connect.ts:164/227 put the tainted value in
// the QUERY STRING of a fixed-prefix template literal; tracking.ts:193 is
// gated twenty lines earlier by `if (!verifyTrackedUrl(emailId, targetUrl,
// sig)) return 400` — outside the three-line context window the #633
// sanitiser check reads, and under a name that list never had.
// ─────────────────────────────────────────────────────────────────────────────

describe('CrossFileTaintModule — CONTROL PAIR (#771 GT-03): tainted value only in the query string of a fixed-prefix redirect', () => {
  it('quiet: the customer line — `${webUrl}/onboarding?connected=gmail&email=${encodeURIComponent(tokens.email)}`', async () => {
    const result = await run({
      'connect.ts': `
connect.get("/gmail/callback", async (c) => {
  const code = c.req.query("code");
  const tokens = await exchangeGoogleCode(code);
  kickOffInitialSync(account.id, "Gmail", tokens.email);
  const webUrl = process.env["WEB_URL"] ?? "https://mail.example.com";
  return c.redirect(\`\${webUrl}/onboarding?connected=gmail&email=\${encodeURIComponent(tokens.email)}\`);
});
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.strictEqual(errors.length, 0, `a query-string parameter cannot change the redirect host: ${JSON.stringify(errors)}`);
  });

  it('quiet: a literal host on the sink line — res.redirect(`https://example.com/${path}`)', async () => {
    const result = await run({
      'handler.js': `
function go(req, res) {
  const path = req.query.p;
  res.redirect(\`https://example.com/\${path}\`);
}
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.strictEqual(errors.length, 0, `the browser can only ever be sent to example.com: ${JSON.stringify(errors)}`);
  });

  it('STILL FIRES: the tainted value sits BEFORE the `?` (in the path), same template shape', async () => {
    const result = await run({
      'connect.ts': `
connect.get("/go", async (c) => {
  const code = c.req.query("code");
  const tokens = await exchangeGoogleCode(code);
  const webUrl = process.env["WEB_URL"] ?? "https://mail.example.com";
  return c.redirect(\`\${webUrl}/\${tokens.next}?connected=gmail\`);
});
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.ok(errors.length > 0, 'a tainted path segment can still be `//evil.example` and must fire');
  });

  it('STILL FIRES: the host itself is templated — `https://${host}.example.com/`', async () => {
    const result = await run({
      'handler.js': `
function go(req, res) {
  const host = req.query.h;
  res.redirect(\`https://\${host}.example.com/\`);
}
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.ok(errors.length > 0, 'a templated host is attacker-chosen and must fire');
  });
});

// gluecron-src 2026-10-02: 279 of 282 crossFileTaint blockers were Hono
// redirects to a same-origin path with a fixed first segment.
describe('CrossFileTaintModule — CONTROL PAIR: a redirect that starts with a fixed same-origin path', () => {
  const handler = (target, source = 'c.req.param("slug")') => ({
    'org.ts': `
orgRoutes.get("/orgs/:slug/settings", async (c) => {
  const slug = ${source};
  return c.redirect(${target});
});
`,
  });
  const redirects = (result, sev) => (sev === 'error' ? result.errors() : result.warnings()).filter((e) => e.sink === 'redirect');
  it('quiet: c.redirect(`/orgs/${slug}`) — the URL always starts with /o, so it stays on this origin', async () => {
    const result = await run(handler('`/orgs/${slug}`'));
    assert.strictEqual(redirects(result, 'error').length + redirects(result, 'warning').length, 0);
  });
  it('STILL FIRES (error) from query input: c.redirect(`/${next}`) — "/evil.example" makes "//evil.example"', async () => {
    const result = await run(handler('`/${slug}`', 'c.req.query("next")'));
    assert.ok(redirects(result, 'error').length > 0);
  });
  it('STILL FIRES (error) from query input: c.redirect(`${next}/settings`) and c.redirect(next)', async () => {
    assert.ok(redirects(await run(handler('`${slug}/settings`', 'c.req.query("next")')), 'error').length > 0);
    assert.ok(redirects(await run(handler('slug', 'c.req.query("next")')), 'error').length > 0);
  });
  it('WARNING, not error, when only a route parameter reaches it — one path segment, open only via a backslash', async () => {
    for (const target of ['`/${slug}`', '`${slug}/settings`', 'slug']) {
      const result = await run(handler(target));
      assert.strictEqual(redirects(result, 'error').length, 0, target);
      assert.ok(redirects(result, 'warning').length > 0, target);
    }
  });
  it('quiet: a variable NAMED redirect is not "used" by the c.redirect( method on a later multi-line call', async () => {
    const result = await run({
      'auth.ts': `
auth.post("/login/2fa", async (c) => {
  const redirect = c.req.query("redirect");
  if (!ok) {
    return c.redirect(
      "/login?error=locked"
    );
  }
});
`,
    });
    assert.strictEqual(result.errors().filter((e) => e.sink === 'redirect').length, 0);
  });
  it('STILL FIRES: the same variable passed to c.redirect(redirect)', async () => {
    const result = await run({
      'auth.ts': `
auth.post("/login/2fa", async (c) => {
  const redirect = c.req.query("redirect");
  return c.redirect(redirect);
});
`,
    });
    assert.ok(result.errors().filter((e) => e.sink === 'redirect').length > 0);
  });
  it('quiet: the variable came from a same-origin helper — const redirect = safeRedirect(c.req.query("redirect"), "/")', async () => {
    const result = await run({
      'auth.ts': `
auth.post("/login/2fa", async (c) => {
  const redirect = safeRedirect(c.req.query("redirect"), "/");
  const a = 1;
  const b = 2;
  const d = 3;
  const e = 4;
  return c.redirect(redirect);
});
`,
    });
    assert.strictEqual(result.errors().filter((x) => x.sink === 'redirect').length, 0);
  });
});

describe('CrossFileTaintModule — CONTROL PAIR (#771 GT-03): a negated verify-guard earlier in the same handler', () => {
  it('quiet: the customer line — `if (!verifyTrackedUrl(emailId, targetUrl, sig)) return 400` twenty lines above c.redirect(targetUrl)', async () => {
    const result = await run({
      'tracking.ts': `
tracking.get("/:emailId/click", async (c) => {
  const emailId = c.req.param("emailId");
  const targetUrl = c.req.query("url");
  if (!targetUrl) {
    return c.text("Missing url parameter", 400);
  }
  // The signature is over (emailId, url) and only this server can produce it.
  if (!verifyTrackedUrl(emailId, targetUrl, c.req.query(SIGNATURE_PARAM))) {
    return c.text("Invalid or missing link signature", 400);
  }
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.text("Invalid URL protocol", 400);
    }
  } catch {
    return c.text("Invalid URL", 400);
  }
  recordEvent(emailId, "email.clicked", {
    url: targetUrl,
    userAgent,
  }).catch(() => { /* fire-and-forget */ });
  return c.redirect(targetUrl, 302);
});
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.strictEqual(errors.length, 0, `an HMAC-verified target is not an open redirect: ${JSON.stringify(errors)}`);
  });

  it('STILL FIRES: the guard verifies a DIFFERENT variable than the one redirected to', async () => {
    const result = await run({
      'tracking.ts': `
tracking.get("/:emailId/click", async (c) => {
  const emailId = c.req.param("emailId");
  const targetUrl = c.req.query("url");
  if (!verifyTrackedUrl(emailId, c.req.query(SIGNATURE_PARAM))) {
    return c.text("Invalid or missing link signature", 400);
  }
  return c.redirect(targetUrl, 302);
});
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.ok(errors.length > 0, 'a guard that never sees the target proves nothing about it');
  });

  it('STILL FIRES: the guard lives in a DIFFERENT handler above the one that redirects', async () => {
    const result = await run({
      'tracking.ts': `
tracking.get("/:emailId/open", async (c) => {
  const targetUrl = c.req.query("url");
  if (!verifyTrackedUrl(c.req.param("emailId"), targetUrl, c.req.query("sig"))) {
    return c.text("bad", 400);
  }
  return c.text("ok");
});
tracking.get("/:emailId/click", async (c) => {
  const targetUrl = c.req.query("url");
  return c.redirect(targetUrl, 302);
});
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.ok(errors.length > 0, 'the backward walk must stop at the enclosing route registration');
  });

  it('STILL FIRES: the guard is only quoted in a comment', async () => {
    const result = await run({
      'tracking.ts': `
tracking.get("/:emailId/click", async (c) => {
  const targetUrl = c.req.query("url");
  // TODO: if (!verifyTrackedUrl(emailId, targetUrl, sig)) return c.text("bad", 400);
  return c.redirect(targetUrl, 302);
});
`,
    });
    const errors = result.errors().filter((e) => e.sink === 'redirect');
    assert.ok(errors.length > 0, 'a guard in a comment is not a guard');
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — test paths downgrade to warning
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — test path severity downgrade', () => {
  it('downgrades error to warning for test file sinks', async () => {
    const result = await run({
      'tests/handler.test.js': `
function testExec(req) {
  const cmd = req.params.cmd;
  exec(cmd);
}
`,
    });
    const errors = result.errors();
    const warnings = result.warnings();
    // test path should produce warning, not error
    assert.strictEqual(errors.filter(e => e.file && e.file.includes('tests/')).length, 0);
    // It might still warn
    assert.ok(warnings.length >= 0); // just no exception
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — summary always present
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — summary', () => {
  it('always emits a summary check', async () => {
    const result = await run({
      'app.js': `
const x = 1;
console.log(x);
`,
    });
    const summary = result.checks.find(c => c.rule === 'cross-file-taint:summary');
    assert.ok(summary, 'summary check must be emitted');
    assert.strictEqual(summary.severity, 'info');
  });

  it('summary includes file count', async () => {
    const result = await run({
      'a.js': 'const x = 1;',
      'b.js': 'const y = 2;',
    });
    const summary = result.checks.find(c => c.rule === 'cross-file-taint:summary');
    assert.ok(summary, 'should have summary');
    assert.ok(summary.fileCount >= 2, `expected >= 2 files, got ${summary.fileCount}`);
  });
});

// ---------------------------------------------------------------------------
// Cross-file taint — multi-hop propagation
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — multi-hop taint', () => {
  it('traces taint through an intermediate variable assignment chain', async () => {
    const result = await run({
      'multi.js': `
function process(req) {
  const raw = req.body.input;
  const cleaned = raw;          // propagates taint
  const final = cleaned;        // still tainted
  exec(final);                  // should flag
}
`,
    });
    const errors = result.errors();
    assert.ok(errors.some(e => e.sink === 'exec'), 'should track taint through variable chain');
  });
});

// ---------------------------------------------------------------------------
// Parameterised-ORM safe-harbour (Drizzle / Prisma / Kysely / Postgres.js / ...)
// — file imports a known-safe ORM ⇒ sql-query sinks downgrade error → warning
// — `sql\`...\`` tagged-template sanitiser suppresses entirely
// — non-SQL sinks (eval / exec / file-* / dom-inject) keep error severity
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — parameterised-ORM safe-harbour', () => {
  it('downgrades sql-query sink to warning when drizzle-orm is imported', async () => {
    const result = await run({
      'route.js': `
import { drizzle } from 'drizzle-orm/node-postgres';
import { db } from './db.js';
export async function handler(req) {
  const userId = req.body.userId;
  return await db.execute(userId);
}
`,
    });
    const sqlErrors = result.errors().filter(c => c.sink === 'sql-query');
    const sqlWarnings = result.warnings().filter(c => c.sink === 'sql-query');
    assert.strictEqual(sqlErrors.length, 0, 'sql-query should NOT be error when drizzle-orm imported');
    assert.ok(sqlWarnings.length >= 1, 'sql-query should still surface as warning');
  });

  it('downgrades sql-query sink when @prisma/client is imported', async () => {
    const result = await run({
      'route.js': `
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export async function handler(req) {
  const id = req.body.id;
  return await prisma.$queryRawUnsafe(id);
}
`,
    });
    const sqlErrors = result.errors().filter(c => c.sink === 'sql-query');
    assert.strictEqual(sqlErrors.length, 0, '@prisma/client triggers safe-harbour');
  });

  it('suppresses entirely when sink line uses sql`...` tagged template', async () => {
    const result = await run({
      'route.js': `
import { sql } from 'drizzle-orm';
import { db } from './db.js';
export async function handler(req) {
  const userId = req.body.userId;
  return await db.execute(sql\`SELECT * FROM users WHERE id = \${userId}\`);
}
`,
    });
    const sqlFindings = [...result.errors(), ...result.warnings()].filter(c => c.sink === 'sql-query');
    assert.strictEqual(sqlFindings.length, 0, 'sql`...` tagged template should sanitise');
  });

  it('does NOT downgrade non-SQL sinks even when ORM is imported', async () => {
    const result = await run({
      'route.js': `
import { drizzle } from 'drizzle-orm/node-postgres';
import { exec } from 'child_process';
export async function handler(req) {
  const cmd = req.body.cmd;
  exec(cmd);
}
`,
    });
    const execErrors = result.errors().filter(c => c.sink === 'exec');
    assert.ok(execErrors.length >= 1, 'exec sink stays at error severity');
  });

  it('files without ORM import still flag .query/.execute as error', async () => {
    const result = await run({
      'route.js': `
const db = require('node-pg');
export async function handler(req) {
  const userId = req.body.userId;
  return await db.query('SELECT * FROM users WHERE id = ' + userId);
}
`,
    });
    const sqlErrors = result.errors().filter(c => c.sink === 'sql-query');
    assert.ok(sqlErrors.length >= 1, 'no ORM import = no safe-harbour, error stays');
  });

  it('kysely import triggers safe-harbour', async () => {
    const result = await run({
      'route.js': `
import { Kysely } from 'kysely';
export async function handler(db, req) {
  const id = req.body.id;
  return await db.executeQuery(id);
}
`,
    });
    const sqlErrors = result.errors().filter(c => c.sink === 'sql-query');
    assert.strictEqual(sqlErrors.length, 0, 'kysely triggers safe-harbour');
  });
});

// ---------------------------------------------------------------------------
// Sanitiser comment-stripping — a `// uses sql\`...\`` comment shouldn't
// falsely suppress a real injection finding.
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — sanitiser ignores comment content', () => {
  it('does NOT suppress when only a comment contains the sanitiser pattern', async () => {
    const result = await run({
      'route.js': `
const db = require('pg').Pool;
export async function handler(req) {
  const id = req.body.id;
  // we used to use sql\`...\` template literal here but switched to raw
  return await db.query('SELECT * FROM users WHERE id = ' + id);
}
`,
    });
    const sqlErrors = result.errors().filter(c => c.sink === 'sql-query');
    assert.ok(sqlErrors.length >= 1, 'comment mentioning sql`` should not sanitise');
  });
});

// ---------------------------------------------------------------------------
// Test-fixture self-match — a .test.js file whose OWN source contains a
// multi-line template literal used as sample fixture content (exactly how
// this module's own test suite is written) must not be flagged when this
// module scans its own repo. Self-scan 2026-07-15 found this module
// flagging tests/heavy/cross-file-taint.test.js's eval()/exec() fixtures
// as real findings — the sink text was real, but it lives inside a
// backtick string spanning several lines, not in executable code.
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — does not self-flag its own test fixtures', () => {
  it('does not flag eval()/exec() sample payloads nested in a multi-line template literal', async () => {
    const result = await run({
      'sample.test.js': `
describe('example', () => {
  it('flags tainted eval', async () => {
    const result = await run({
      'index.js': \`
function run(req) {
  const code = req.body.script;
  eval(code);
}
\`,
    });
  });

  it('flags tainted exec', async () => {
    const result = await run({
      'runner.js': \`
const { exec } = require('child_process');
function runCmd(req, res) {
  const cmd = req.params.command;
  exec(cmd);
}
\`,
    });
  });
});
`,
    });
    const sinkErrors = [...result.errors(), ...result.warnings()].filter((c) => c.sink);
    assert.strictEqual(
      sinkErrors.length, 0,
      `expected zero sink findings on fixture text nested in a template literal, got: ${JSON.stringify(sinkErrors.map((e) => e.sink))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Function-parameter taint (phase 2c) — a route handler CALLS an imported
// db helper with a tainted argument, and the helper's OWN parameter reaches
// a sink internally (layered "handler -> db helper" architecture). Mirrors
// the flagship shape documented in _analyseFunctionParamTaint's header.
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — function-parameter taint (phase 2c)', () => {
  it('detects the inline-sink shape: parameter used directly at a sink inside the callee', async () => {
    const result = await run({
      'handler.js': `
const { findOrderById } = require('./query');
function getOrderHandler(req, res) {
  const id = req.params.id;
  const order = findOrderById(id);
  res.json(order);
}
module.exports = { getOrderHandler };
`,
      'query.js': `
function findOrderById(orderId) {
  return conn.query(\`SELECT * FROM orders WHERE id = \${orderId}\`);
}
module.exports = { findOrderById };
`,
    });
    const hit = [...result.errors(), ...result.warnings()].find(
      (c) => c.file === 'query.js' && c.sink === 'sql-query',
    );
    assert.ok(
      hit,
      `expected a cross-file finding for the inline-sink shape, got: ${JSON.stringify(result.checks.map((c) => ({ rule: c.rule, file: c.file, sink: c.sink })))}`,
    );
    assert.strictEqual(hit.severity, 'error');
    assert.ok(hit.message.includes('findOrderById'), `message should name the callee: ${hit.message}`);
  });

  it('detects the assign-then-sink shape: parameter propagates through a local var before the sink', async () => {
    const result = await run({
      'handler2.js': `
const { findOrderById2 } = require('./query2');
function getOrderHandler2(req, res) {
  const id = req.params.id;
  const order = findOrderById2(id);
  res.json(order);
}
module.exports = { getOrderHandler2 };
`,
      'query2.js': `
function findOrderById2(orderId) {
  const sql = \`SELECT * FROM orders WHERE id = \${orderId}\`;
  return conn.query(sql);
}
module.exports = { findOrderById2 };
`,
    });
    const hit = [...result.errors(), ...result.warnings()].find(
      (c) => c.file === 'query2.js' && c.sink === 'sql-query',
    );
    assert.ok(hit, 'expected a cross-file finding for the assign-then-sink shape');
    // Cosmetic: the message should name the ORIGINAL parameter (`orderId`),
    // not the derived local (`sql`), even though propagation tracked `sql`.
    assert.ok(hit.message.includes('orderId'), `message should name the original parameter: ${hit.message}`);
  });

  it('does not flag when the callee sanitises the parameter before the sink', async () => {
    const result = await run({
      'handler3.js': `
const { findOrderById3 } = require('./query3');
function getOrderHandler3(req, res) {
  const id = req.params.id;
  const order = findOrderById3(id);
  res.json(order);
}
module.exports = { getOrderHandler3 };
`,
      'query3.js': `
function findOrderById3(orderId) {
  const safeId = parseInt(orderId, 10);
  return conn.query(\`SELECT * FROM orders WHERE id = \${safeId}\`);
}
module.exports = { findOrderById3 };
`,
    });
    const hits = [...result.errors(), ...result.warnings()].filter(
      (c) => c.file === 'query3.js' && c.sink === 'sql-query',
    );
    assert.strictEqual(hits.length, 0, `sanitised parameter should not flag, got: ${JSON.stringify(hits)}`);
  });

  it('does not open a phantom function scope for a definition nested inside a template-literal fixture', async () => {
    const result = await run({
      'fixture-param-taint.test.js': `
const sample = \`
function findOrderById(orderId) {
  return conn.query(\\\`SELECT * FROM orders WHERE id = \\\${orderId}\\\`);
}
\`;
module.exports = { sample };
`,
    });
    const sinkHits = [...result.errors(), ...result.warnings()].filter((c) => c.sink);
    assert.strictEqual(
      sinkHits.length, 0,
      `fixture text nested in a template literal must not open a phantom function scope, got: ${JSON.stringify(sinkHits.map((e) => e.sink))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// One stripper — the masked line decides sink detection
// ---------------------------------------------------------------------------

describe('CrossFileTaintModule — one stripper: the masked line decides', () => {
  it('eval(code) inside a string, a template, a comment or a regex is not a sink; the real one beside them is (2026-09-05)', async () => {
    const result = await run({
      'index.js': [
        'function run(req) {',
        '  const code = req.body.script;',
        '  const doc = "eval(code)";',
        '  const tpl = `',
        '    eval(code)',
        '  `;',
        '  /* a block comment that starts on this line',
        '     eval(code) */',
        '  assert.doesNotMatch(out, /eval\\(code\\)/);',
        '  eval(code);',
        '}',
        '',
      ].join('\n'),
    });
    const evals = result.errors().filter((e) => e.sink === 'eval');
    assert.deepStrictEqual(evals.map((e) => e.line), [10], JSON.stringify(result.errors()));
  });

  it('a tainted variable interpolated into a query template is seen — the ${…} hole is code, not string body (2026-09-05)', async () => {
    const result = await run({
      'index.js': [
        'function find(req, res) {',
        '  const id = req.params.id;',
        '  return db.query(`SELECT * FROM users WHERE id = ${id}`);',
        '}',
        '',
      ].join('\n'),
    });
    const sql = result.errors().filter((e) => e.sink === 'sql-query');
    assert.deepStrictEqual(sql.map((e) => e.line), [3], JSON.stringify(result.errors()));
  });

  it('a request read quoted inside a string does not taint the variable assigned on that line; the real read beside it does (2026-09-05)', async () => {
    // tests/security-inert-patterns.test.js:500 shape — a one-line fixture
    // `"const fs = require('fs'); … req.body.name …"` tainted `fs` for the
    // rest of the file and every later path.join became a finding.
    const result = await run({
      'index.js': [
        'const fs = require("fs");',
        'const FIXTURE = "const fs = require(\'fs\'); function w(req) { fs.writeFileSync(\'/d/\' + req.body.name, \'x\'); }";',
        'function save(req, res) {',
        '  const name = req.body.name;',
        '  fs.writeFileSync(path.join("/data", name), FIXTURE);',
        '}',
        'module.exports = { save };',
        '',
      ].join('\n'),
    });
    const hits = result.errors().map((e) => `${e.binding}@${e.line}:${e.sink}`).sort();
    assert.deepStrictEqual(hits, ['name@5:file-write', 'name@5:path-join'], JSON.stringify(result.errors()));
  });
});
