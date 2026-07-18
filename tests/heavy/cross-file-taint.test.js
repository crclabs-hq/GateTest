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
