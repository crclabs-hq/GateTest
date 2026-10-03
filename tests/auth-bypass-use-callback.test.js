'use strict';

// Tallrig (2026-10-03): eight Hono services guard every route with an inline
// `app.use("/prefix/*", async (c, next) => { …authenticateX… })`. The use()
// argument list was read up to the FIRST `)`, so the auth inside the callback
// was never seen. Also: `authenticateFleetAgent`-style helpers and Gluecron's
// per-row `resolveRepoAccess` filter are access checks. Positive controls: an
// inline use() that does no auth, and a route with nothing, still fire.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AuthBypass = require('../src/modules/auth-bypass');

async function blocking(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-authbypass-use-'));
  try {
    const full = path.join(root, 'src/agents/app.ts');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    const checks = [];
    await new AuthBypass().run({ addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); } }, { projectRoot: root });
    return checks.filter((c) => !c.passed && (c.meta.severity || 'error') === 'error');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const app = (useBody, handler = 'return c.json({ ok: true });') => [
  'import { Hono } from "hono";',
  'const app = new Hono();',
  'app.use("/agents/v1/*", async (c, next) => {',
  useBody,
  '  await next();',
  '});',
  'app.post("/agents/v1/tools/:name", async (c) => {',
  `  ${handler}`,
  '});',
  'export default app;',
].join('\n');

describe('authBypass — auth inside an inline use() callback', () => {
  it('NEGATIVE: authenticateFleetAgent inside the callback guards the route', async () => {
    const f = await blocking(app('  const agent = await authenticateFleetAgent(c.req.header("authorization"));\n  if (!agent) return c.json({ error: "unauthorized" }, 401);'));
    assert.deepEqual(f.map((x) => x.id), []);
  });

  it('POSITIVE: an inline use() that only logs still leaves the route open', async () => {
    const f = await blocking(app('  console.log(c.req.path);'));
    assert.equal(f.length, 1, f.map((x) => x.id).join());
  });
});

describe('authBypass — per-row access filter', () => {
  const listing = (filter) => [
    'import { Hono } from "hono";',
    'const api = new Hono();',
    'api.get("/users/:username/repos", async (c) => {',
    '  const rows = await db.select().from(repositories);',
    `  ${filter}`,
    '  return c.json(rows);',
    '});',
    'export default api;',
  ].join('\n');

  it('NEGATIVE: rows filtered through resolveRepoAccess', async () => {
    const f = await blocking(listing('const visible = await Promise.all(rows.map((r) => resolveRepoAccess({ repoId: r.id, userId: c.get("user")?.id })));'));
    assert.deepEqual(f.map((x) => x.id), []);
  });

  it('POSITIVE: the same listing with no filter fires', async () => {
    const f = await blocking(listing('const visible = rows;'));
    assert.equal(f.length, 1, f.map((x) => x.id).join());
  });
});
