'use strict';

// Gluecron src/routes/pr-live.ts (2026-10-02): `softAuth` populates the
// viewer and never denies; the handler enforces inline with
// `if (!c.get("user")) return c.json({ error }, 401)`. Negative control: that
// route is protected. Positive controls: the same route that only READS the
// user, and one that enforces nothing, still fire.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AuthBypass = require('../src/modules/auth-bypass');

async function findings(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-authbypass-hono-'));
  try {
    const full = path.join(root, 'src/routes/pr-live.ts');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    const checks = [];
    await new AuthBypass().run({ addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); } }, { projectRoot: root });
    return checks.filter((c) => !c.passed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const route = (body) => [
  'import { Hono } from "hono";',
  'import { softAuth } from "../middleware/auth";',
  'const app = new Hono();',
  'app.post("/api/v2/pulls/:prId/live/cursor", softAuth, async (c) => {',
  ...body,
  '  return c.json({ ok: true });',
  '});',
  'export default app;',
].join('\n');

describe('authBypass — Hono inline guard', () => {
  it('`if (!c.get("user")) return c.json({…}, 401)` after softAuth is protected', async () => {
    const f = await findings(route([
      '  if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);',
      '  const prId = c.req.param("prId");',
      '  broadcast(prId, await c.req.json());',
    ]));
    assert.deepEqual(f.map((x) => x.id), []);
  });

  it('`c.text("Forbidden", 403)` is enforcement too', async () => {
    const f = await findings(route([
      '  const u = c.get("user");',
      '  if (!u || !u.isAdmin) return c.text("nope", 403);',
      '  broadcast(c.req.param("prId"));',
    ]));
    assert.deepEqual(f.map((x) => x.id), []);
  });

  it('control: a handler that enforces nothing still fires', async () => {
    const f = await findings(route([
      '  const prId = c.req.param("prId");',
      '  broadcast(prId, await c.req.json());',
    ]));
    assert.ok(f.length >= 1, 'unprotected POST must be reported');
  });

  it('control: a 401 status on some OTHER call shape (a log line) is not enforcement', async () => {
    const f = await findings(route([
      '  metrics.count("live", 401);',
      '  broadcast(c.req.param("prId"));',
    ]));
    assert.ok(f.length >= 1);
  });
});
