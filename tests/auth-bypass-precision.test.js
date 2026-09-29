'use strict';

// AUTH-BYPASS PRECISION — the false-positive classes measured 2026-08-18
// (≈0 precision on real code: express core, OWASP NodeGoat, this repo) each
// get a NEGATIVE control (must be silent) next to a POSITIVE control (must
// still fire), so precision cannot be bought by muting the rule.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AuthBypass = require('../src/modules/auth-bypass');

function makeResult() {
  const checks = [];
  return {
    checks,
    addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); },
    get errors() { return checks.filter((c) => !c.passed && (c.meta.severity || 'error') === 'error'); },
    /** every finding regardless of severity — anonymous GETs of non-sensitive paths are warnings by design */
    get findings() { return checks.filter((c) => !c.passed); },
  };
}
async function scan(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-authbypass-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const result = makeResult();
    await new AuthBypass().run(result, { projectRoot: root });
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('authBypass — positive controls (must still fire)', () => {
  it('flags an Express route with no middleware and no auth read in the handler', async () => {
    const r = await scan({ 'src/routes.js': `
const router = require('express').Router();
router.post('/orders', (req, res) => { res.json(db.orders.create(req.body)); });
module.exports = router;
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.checks));
    assert.match(r.errors[0].meta.message, /POST \/orders/);
  });

  it('flags a Next.js route handler with no session check', async () => {
    const r = await scan({ 'app/api/users/route.ts': `
export async function DELETE(req) { await db.user.deleteMany(); return Response.json({ ok: true }); }
` });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].meta.message, /DELETE \/api\/users/);
  });
});

describe('authBypass — severity follows risk', () => {
  it('an unauthenticated WRITE blocks; an anonymous GET of a non-sensitive path warns; a GET of an admin path blocks', async () => {
    const r = await scan({
      'src/a.js': `router.post('/comments', (req, res) => res.json(save(req.body)));`,
      'src/b.js': `router.get('/pokemon', (req, res) => res.json(list()));`,
      'src/c.js': `router.get('/admin/report', (req, res) => res.json(report()));`,
    });
    const sev = (file) => r.findings.find((f) => f.meta.message.includes(file)).meta.severity;
    assert.equal(sev('src/a.js'), 'error');
    assert.equal(sev('src/b.js'), 'warning');
    assert.equal(sev('src/c.js'), 'error');
  });
});

describe('authBypass — negative controls (measured false positives, must be silent)', () => {
  it("Express SETTINGS getter `app.get('trust proxy fn')` is not a route (express core)", async () => {
    const r = await scan({ 'lib/application.js': `
app.get = function get(setting) { return this.set(setting); };
var fn = app.get('trust proxy fn');
var etag = app.get('etag fn');
app.get('/health', (req, res) => res.end('ok'));
` });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors.map((e) => e.meta.message)));
  });

  it('a route guarded by a middleware ARGUMENT (`isLoggedIn`) is protected even without a brace on that line (NodeGoat)', async () => {
    const r = await scan({ 'app/routes/index.js': `
module.exports = function(app) {
  app.get("/dashboard", isLoggedIn, dashboardHandler.displayDashboard);
  app.get("/profile", isLoggedIn, profileHandler.displayProfile);
  app.post("/profile", isLoggedIn, profileHandler.handleProfileUpdate);
  app.get("/nothing", function (req, res) { res.render("x", { csrftoken: "" }); });
};
` });
    // exactly ONE finding for the genuinely unguarded /nothing route (a
    // warning: anonymous GET of a non-sensitive path)
    assert.equal(r.findings.length, 1, JSON.stringify(r.findings.map((e) => e.meta.message)));
    assert.match(r.findings[0].meta.message, /1 unprotected route/);
    assert.match(r.findings[0].meta.message, /GET \/nothing/);
    assert.doesNotMatch(r.findings[0].meta.message, /dashboard|profile/);
    assert.equal(r.findings[0].meta.severity, 'warning');
  });

  it('a naming-convention guard the fixed list does not know (`isAdminRequest`, `verifyApiKey`) counts as auth', async () => {
    const r = await scan({
      'website/app/api/admin/users/route.ts': `
import { isAdminRequest } from "@/app/lib/admin-auth";
export async function GET(req) { if (!isAdminRequest(req)) return new Response("nope", { status: 401 }); return Response.json([]); }
`,
      'src/api.js': `
router.delete('/keys/:id', verifyApiKey, (req, res) => res.json(revoke(req.params.id)));
`,
    });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors.map((e) => e.meta.message)));
  });

  it('routes registered after a router-level `.use(requireAuth)` are protected', async () => {
    const r = await scan({ 'src/admin.js': `
const router = express.Router();
router.use(requireAuth);
router.get('/reports', (req, res) => res.json(reports()));
router.post('/reports', (req, res) => res.json(create(req.body)));
` });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors.map((e) => e.meta.message)));
  });

  it('a route is listed once, not once per framework regex, and nested app dirs give a clean path', async () => {
    const r = await scan({
      'src/x.js': `router.get('/things', (req, res) => res.json([]));`,
      'website/app/api/things/route.ts': `export async function GET() { return Response.json([]); }`,
    });
    const msgs = r.findings.map((e) => e.meta.message);
    const expressMsg = msgs.find((m) => m.includes('src/x.js'));
    assert.ok(expressMsg && /1 unprotected route in/.test(expressMsg), expressMsg);
    assert.equal((expressMsg.match(/GET \/things/g) || []).length, 1, 'listed exactly once');
    const nextMsg = msgs.find((m) => m.includes('website/app/api/things/route.ts'));
    assert.ok(nextMsg && /GET \/api\/things/.test(nextMsg), `expected clean /api/things path, got: ${nextMsg}`);
    assert.doesNotMatch(nextMsg, /website\/app\/api\/things`/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-31 audit — the four false-positive classes behind GateTest's own 16
// blocking authBypass findings. Each module change gets a NEGATIVE control (the
// false positive goes quiet) AND a POSITIVE control (a genuinely unauthenticated
// sensitive route still fires), because "quieter" and "broken" are otherwise
// indistinguishable.
// ─────────────────────────────────────────────────────────────────────────────

describe('authBypass — a route inside a string, a template or a comment is not a route', () => {
  it('a route inside a string, a template or a comment is not an endpoint; the real one beside them is (2026-09-05)', async () => {
    // Control pair for the one-stripper migration: the match START is judged
    // against BaseModule._maskedLines, which sees a template literal and a
    // block comment that span lines — the per-line quote counter it replaced
    // could not, and the block-comment line below was a live ERROR.
    const r = await scan({ 'src/routes.js': [
      "const doc = \"app.post('/in-string', (req, res) => res.json(db.save(req.body)))\";",
      'const tpl = `',
      "  app.post('/in-template', (req, res) => res.json(db.save(req.body)))",
      '`;',
      '/* example:',
      "   app.post('/in-comment', (req, res) => res.json(db.save(req.body)))",
      '*/',
      "app.post('/real', (req, res) => res.json(db.save(req.body)));",
      '',
    ].join('\n') });
    assert.deepStrictEqual(r.findings.map((c) => c.meta.line), [8], JSON.stringify(r.findings));
    assert.match(r.findings[0].meta.message, /POST \/real/);
  });
});

describe('authBypass — 405 method-not-allowed stubs are not endpoints', () => {
  it('NEGATIVE: a handler whose only behaviour is returning 405 is silent', async () => {
    const r = await scan({ 'website/app/api/admin/recipes/route.ts': `
export async function POST() {
  return Response.json({ ok: false, reason: "method-not-allowed", hint: "Use PUT" }, { status: 405 });
}
export async function DELETE() {
  return Response.json({ ok: false, reason: "method-not-allowed" }, { status: 405 });
}
` });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings.map((e) => e.meta.message)));
  });

  it('POSITIVE: a handler that does real work before returning 405 still fires', async () => {
    const r = await scan({ 'website/app/api/admin/purge/route.ts': `
export async function DELETE() {
  await db.reports.deleteMany();
  return Response.json({ ok: true }, { status: 405 });
}
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings.map((e) => e.meta.message)));
    assert.match(r.errors[0].meta.message, /DELETE \/api\/admin\/purge/);
  });

  it('POSITIVE: a handler with a non-405 branch is a real endpoint and still fires', async () => {
    const r = await scan({ 'website/app/api/admin/keys/route.ts': `
export async function POST(req) {
  if (!req) return Response.json({ error: "bad" }, { status: 500 });
  return Response.json({ key: mintKey() }, { status: 405 });
}
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings.map((e) => e.meta.message)));
  });
});

describe('authBypass — auth one hop away in the same file', () => {
  it('NEGATIVE: a GET that forwards to an authenticated POST inherits its check', async () => {
    const r = await scan({ 'website/app/api/worker/tick/route.ts': `
import { isAdminRequest } from "@/app/lib/admin-auth";
export async function POST(req) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorised" }, { status: 401 });
  return Response.json(await runTick());
}
export async function GET(req) { return POST(req); }
` });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings.map((e) => e.meta.message)));
  });

  it('NEGATIVE: a thin export delegating to a private _postImpl in the same file', async () => {
    const r = await scan({ 'website/app/api/scan/run/route.ts': `
import { isAdminRequest } from "@/app/lib/admin-auth";
export async function POST(req) {
  try { return await _postImpl(req); }
  catch (e) { return Response.json({ status: "failed" }, { status: 500 }); }
}
async function _postImpl(req) {
  const isAdmin = isAdminRequest(req);
  return Response.json({ isAdmin });
}
` });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings.map((e) => e.meta.message)));
  });

  it('POSITIVE: delegation to an UNAUTHENTICATED sibling flags both methods', async () => {
    const r = await scan({ 'website/app/api/admin/purge/route.ts': `
export async function POST(req) { await db.purge(req); return Response.json({ ok: true }); }
export async function GET(req) { return POST(req); }
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings.map((e) => e.meta.message)));
    assert.equal(r.errors[0].meta.details.length, 2, 'both POST and GET are reported');
  });

  it('POSITIVE: a local helper that never receives the request confers no auth', async () => {
    // `render(body)` is not `render(req)` — the handler is not delegating, and
    // must not borrow the helper's "Unauthorized" vocabulary.
    const r = await scan({ 'website/app/api/admin/notes/route.ts': `
export async function POST(req) {
  const body = await req.json();
  return Response.json(render(body));
}
function render(data) {
  if (!data) return { error: "Unauthorized" };
  return data;
}
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings.map((e) => e.meta.message)));
    assert.match(r.errors[0].meta.message, /POST \/api\/admin\/notes/);
  });
});

describe('authBypass — vendor-shaped signature headers are auth', () => {
  it('NEGATIVE: an HMAC receiver reading x-signal-signature is protected', async () => {
    const r = await scan({ 'website/app/api/events/ingest/route.ts': `
export async function POST(req) {
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("x-signal-signature");
  return Response.json(verifyAndStore({ rawBody, signatureHeader, env: process.env }));
}
` });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings.map((e) => e.meta.message)));
  });

  it('NEGATIVE: x-internal-signature too — the list must not be three vendors long', async () => {
    const r = await scan({ 'website/app/api/internal/publish/route.ts': `
export async function POST(req) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-internal-signature");
  return Response.json(store({ rawBody, sig }));
}
` });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings.map((e) => e.meta.message)));
  });

  it('POSITIVE: the same ingest route WITHOUT a signature read still fires', async () => {
    const r = await scan({ 'website/app/api/events/ingest/route.ts': `
export async function POST(req) {
  const rawBody = await req.text();
  return Response.json(store({ rawBody }));
}
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings.map((e) => e.meta.message)));
    assert.match(r.errors[0].meta.message, /POST \/api\/events\/ingest/);
  });
});

describe('authBypass — auth-public is read from the attached comment block', () => {
  it('NEGATIVE: a marker that explains itself over 8 lines still suppresses', async () => {
    const r = await scan({ 'website/app/api/scan/guidance/route.ts': `
// auth-public — reached credential-free on purpose: the hosted MCP core proxies
// here server-to-server and forwards no caller key, and the admin panels call it
// from the browser. The deliberate control for the Claude spend is the rate
// limiter above, chosen over auth in the 2026-08-18 audit.
// KNOWN GAP: the paid MCP gate sits in the MCP layer, not here.
// Closing it means threading an internal service token through the MCP core —
// a paid-tier change, so Boss Rule, not a unilateral fix.
export async function POST(req) { return Response.json(await guide(req)); }
` });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings.map((e) => e.meta.message)));
  });

  it('POSITIVE: the marker does NOT leak onto the next handler in the file', async () => {
    const r = await scan({ 'website/app/api/admin/reports/route.ts': `
// auth-public — public aggregate counts, no per-customer data.
// (filler so the block is longer than the old five-line window)
// (filler)
// (filler)
// (filler)
// (filler)
export async function GET() { return Response.json(publicStats()); }

export async function DELETE() {
  await db.reports.deleteMany();
  return Response.json({ ok: true });
}
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings.map((e) => e.meta.message)));
    assert.equal(r.errors[0].meta.details.length, 1, 'only the unmarked DELETE is reported');
    assert.equal(r.errors[0].meta.details[0].method, 'DELETE');
  });
});

// ── framework adapter forwarding a handler PARAMETER (nestjs/nest, 2026-09-05) ──
//
// packages/platform-express/adapters/express-adapter.ts:167-172 registers
// `router.all('*path', handler as any)` where `handler` is the PARAMETER of
// `setNotFoundHandler`. The adapter ships no endpoint — whoever passes the
// handler in decides whether it is guarded — and was reported as an
// unauthenticated ALL route at error severity.
describe('authBypass — a handler forwarded from the enclosing function\'s parameters is plumbing', () => {
  const NEST_ADAPTER = `
import express from 'express';
export class ExpressAdapter {
  public setNotFoundHandler(handler: Function, prefix?: string) {
    if (prefix) {
      this.registeredPrefixes.add(prefix);
      const router = express.Router();
      router.all('*path', handler as any);
      return this.use(prefix, router);
    }
    return this.use(handler);
  }
}
`;

  it('NEGATIVE: nest\'s express adapter (verbatim) produces no auth-bypass finding', async () => {
    const r = await scan({ 'packages/platform-express/adapters/express-adapter.ts': NEST_ADAPTER });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('POSITIVE: an inline handler on the same registration still fires', async () => {
    const r = await scan({ 'src/adapter.ts': `
const router = require('express').Router();
export function setNotFoundHandler(handler) {
  router.all('/admin', (req, res) => res.json(db.dump()));
}
` });
    assert.ok(r.errors.some((c) => c.id === 'auth-bypass:src/adapter.ts'), JSON.stringify(r.findings));
  });

  it('POSITIVE: a bare identifier that is a module-level const, not a parameter, still fires', async () => {
    const r = await scan({ 'src/routes.ts': `
const router = require('express').Router();
const handler = (req, res) => res.json(db.dump());
export function mount(app) {
  router.all('/admin', handler);
}
` });
    assert.ok(r.errors.some((c) => c.id === 'auth-bypass:src/routes.ts'), JSON.stringify(r.findings));
  });

  it('POSITIVE: a member-expression handler (the NodeGoat shape) still fires', async () => {
    const r = await scan({ 'src/routes.ts': `
module.exports = function (app, adminHandler) {
  app.get('/admin', adminHandler.displayAdmin);
};
` });
    assert.ok(r.errors.some((c) => c.id === 'auth-bypass:src/routes.ts'), JSON.stringify(r.findings));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GT-11 (#771, AlecRae.com crawl): public-by-design discovery endpoints —
// the customer's apps/api/src/server.ts registers `GET /` and `GET /v1`
// (a capability index), `GET /openapi.yaml` and `ROUTE /v1/uptime`, and the
// rule reported the file as "4 unprotected routes" at error severity. These
// answer without a session by convention (load balancers, crawlers, API
// clients probing a schema or version, a human discovering the API by
// hand), not by oversight. The canonical list lives in
// src/core/public-discovery-routes.js and is WHOLE-PATH matched, so a path
// that merely contains one of these words as part of something bigger
// (`/api/admin/users`, `/api/versions/1`, `/v1/users`) is not exempted.
// ─────────────────────────────────────────────────────────────────────────────

describe('authBypass — public discovery endpoints are not unprotected routes (GT-11)', () => {
  it('NEGATIVE: the customer line — GET /, GET /v1, GET /openapi.yaml, ROUTE /v1/uptime produce no finding', async () => {
    const r = await scan({ 'src/server.ts': `
const app = new Hono();
app.get("/health", liveness);
app.get("/", capabilityIndex);
app.get("/v1", capabilityIndex);
app.get("/openapi.yaml", (c) => c.text(openapiYaml, 200, { "content-type": "application/yaml" }));
app.route("/v1/uptime", uptimeRoutes);
export default app;
` });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('NEGATIVE: /.well-known/security.txt, /healthz, /status, /robots.txt, /openapi.json, /api/version produce no finding', async () => {
    const r = await scan({ 'src/routes.js': `
const router = require('express').Router();
router.get('/.well-known/security.txt', (req, res) => res.send('...'));
router.get('/healthz', (req, res) => res.json({ ok: true }));
router.get('/status', (req, res) => res.json({ ok: true }));
router.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *'));
router.get('/openapi.json', (req, res) => res.json(spec));
router.get('/api/version', (req, res) => res.json({ version: '1.0.0' }));
module.exports = router;
` });
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('POSITIVE: GET /v1/users beside the public front door still fires (sensitive path under the same prefix)', async () => {
    const r = await scan({ 'src/server.ts': `
const app = new Hono();
app.get("/", capabilityIndex);
app.get("/v1", capabilityIndex);
app.get("/v1/users", (c) => c.json(listUsers()));
export default app;
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings));
    assert.match(r.errors[0].meta.message, /1 unprotected route/);
    assert.match(r.errors[0].meta.message, /GET \/v1\/users/);
  });

  it('POSITIVE: /api/admin/users without an auth middleware still fires', async () => {
    const r = await scan({ 'src/routes.js': `
const router = require('express').Router();
router.get('/api/admin/users', (req, res) => res.json(db.users.all()));
module.exports = router;
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings));
    assert.match(r.errors[0].meta.message, /GET \/api\/admin\/users/);
  });

  it('POSITIVE: a path that merely CONTAINS "version" or "status" as part of a bigger segment still fires', async () => {
    const r = await scan({ 'src/routes.js': `
const router = require('express').Router();
router.post('/api/versions/1/publish', (req, res) => res.json(publish(req.body)));
module.exports = router;
` });
    assert.equal(r.errors.length, 1, JSON.stringify(r.findings));
    assert.match(r.errors[0].meta.message, /POST \/api\/versions\/1\/publish/);
  });
});
