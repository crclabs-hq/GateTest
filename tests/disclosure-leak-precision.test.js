'use strict';

// error-detail-leak / upstream-error-leak precision (2026-10-03). A full scan
// of a private platform raised 95 of these; 31 were real and 63 were six
// shapes the rules could not tell apart. Each shape below is written from
// the class (the platform's code is private) with the control that must
// still fire beside it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { errorDetailLeak, upstreamErrorLeak, buildDisclosureContext, scanDisclosure } = require('../src/core/disclosure-rules');

const L = (src) => (Array.isArray(src) ? src : src.split('\n'));

describe('error-detail-leak: operator surfaces', () => {
  it('quiet: a route gated by requireAdmin may name the variable', () => {
    const src = L([
      'app.post("/deploy/run", requireAdmin, async (c) => {',
      '  if (!secret) {',
      '    return c.json({ error: "DEPLOY_AGENT_SECRET not configured" }, 503);',
      '  }',
      '});',
    ].join('\n'));
    assert.equal(errorDetailLeak('apps/api/src/deploy/routes.ts', src).length, 0);
  });
  it('control: the same body on a public route fires', () => {
    const src = L([
      'app.post("/hooks/push", async (c) => {',
      '  if (!secret) {',
      '    return c.json({ ok: false, error: "PUSH_WEBHOOK_SECRET not configured" }, 503);',
      '  }',
      '});',
    ].join('\n'));
    assert.equal(errorDetailLeak('apps/api/src/webhooks/push.ts', src).length, 1);
  });
  it('quiet: an adminProcedure; control: a protectedProcedure', () => {
    const body = (proc) => L([
      `  liveModels: ${proc}.query(async () => {`,
      '    if (!key) return { models: [], note: "no ANTHROPIC_API_KEY configured" };',
      '  }),',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', body('adminProcedure')).length, 0);
    assert.equal(errorDetailLeak('a.ts', body('protectedProcedure')).length, 1);
  });
  it('control: an import naming the guard is not a gate, and a helper is not a handler', () => {
    const src = L([
      'import { adminProcedure, protectedProcedure } from "../init";',
      'function unavailable() {',
      '  return { items: [], note: "Search unavailable — SEARCH_API_KEY not configured" };',
      '}',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 1);
  });
  it('quiet: admin-named files and audit jobs', () => {
    const src = L('return c.json({ error: "DEPLOY_AGENT_SECRET not configured" }, 503);');
    assert.equal(errorDetailLeak('apps/api/src/deploy/admin-deploy.ts', src).length, 0);
    assert.equal(errorDetailLeak('apps/api/src/audits/cache/run.ts', src).length, 0);
  });
});

describe('error-detail-leak: internal result objects', () => {
  it('quiet: a boot guard returns { ok: false, reason } to its caller', () => {
    const src = L([
      'if (next === current) {',
      '  return {',
      '    ok: false,',
      '    reason: "SESSION_SECRET_NEXT equals SESSION_SECRET — the rotation would be a no-op",',
      '  };',
      '}',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 0);
  });
  it('quiet: a { status: "failed", note } outcome', () => {
    const src = L(['return {', '  status: "failed",', '  note: "INTERNAL_SERVICE_KEY is not set for the publisher",', '};'].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 0);
  });
  it('control: a door answering { ok: false, status: 503, error } fires', () => {
    const src = L(['return {', '  ok: false,', '  status: 503,', '  error: "door not configured (FLEET_AGENT_TOKEN unset)",', '};'].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 1);
  });
  it('control: a plain returned object without a discriminant still fires (the original defect)', () => {
    const src = L(['return {', '  alternatives: [],', '  note: "AI suggestions unavailable — ANTHROPIC_API_KEY not configured.",', '};'].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 1);
  });
  it('quiet: an e.g. example of a key shape', () => {
    const src = L('return { action: "refuse", reason: "Key must be UPPER_SNAKE_CASE (e.g. RESEND_API_KEY)." };');
    assert.equal(errorDetailLeak('a.ts', src).length, 0);
    const bare = L('return { items: [], reason: "Key must be UPPER_SNAKE_CASE (e.g. RESEND_API_KEY)." };');
    assert.equal(errorDetailLeak('a.ts', bare).length, 0);
  });
  it('quiet: an explicit error-detail-ok marker (a loopback-only service)', () => {
    const src = L([
      '// error-detail-ok — bound to 127.0.0.1, callers are the platform',
      'return c.json({ error: "Service misconfigured: KV_API_KEY not set" }, 500);',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 0);
  });
});

describe('error-detail-leak: err.message flow', () => {
  const thrower = 'function cfg() { if (!id) throw new Error("Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET."); }';
  it('quiet: the message is bound, logged, and the response is a constant redirect', () => {
    const src = L([
      thrower,
      'app.get("/start", (c) => {',
      '  try { return c.redirect(cfg()); } catch (err) {',
      '    const message = err instanceof Error ? err.message : "OAuth configuration error";',
      '    console.error("[oauth] start failed:", message);',
      '    return c.redirect("/login?error=unavailable");',
      '  }',
      '});',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', src).length, 0);
  });
  it('quiet: a typed error the code wrote itself; control: plain Error fires', () => {
    const typed = L([
      thrower,
      'app.get("/graph", (c) => {',
      '  try { return c.json(load()); } catch (err) {',
      '    if (err instanceof ProjectNotFoundError) {',
      '      return c.json({ error: err.message }, 404);',
      '    }',
      '  }',
      '});',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', typed).length, 0);
    const plain = L([
      thrower,
      'app.get("/graph", (c) => {',
      '  try { return c.json(load()); } catch (err) {',
      '    return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);',
      '  }',
      '});',
    ].join('\n'));
    assert.equal(errorDetailLeak('a.ts', plain).length, 1);
  });
});

describe('upstream-error-leak: what is an upstream error', () => {
  it('quiet: .message of a result object the code built', () => {
    const src = L(['const result = await verifyDomain(d);', 'if (!result.ok) {', '  throw new TRPCError({ code: "BAD_REQUEST", message: result.message });', '}'].join('\n'));
    assert.equal(upstreamErrorLeak('a.ts', src).length, 0);
  });
  it('control: a catch binding of any name still fires', () => {
    const src = L(['} catch (failure) {', '  throw new TRPCError({ code: "BAD_GATEWAY", message: failure.message });', '}'].join('\n'));
    assert.equal(upstreamErrorLeak('a.ts', src).length, 1);
  });

  const files = [
    { relPath: 'errors.ts', content: [
      'export class ConferenceError extends Error {',
      '  constructor(public code: string, message: string) { super(message); }',
      '}',
      'export class CarrierError extends Error {',
      '  constructor(message: string, opts: object) { super(message); }',
      '}',
      'throw new ConferenceError("not_found", `Call ${callSid} does not belong to you`);',
      'throw new ConferenceError("missing", "An email needs at least a plain-text or HTML body.");',
      'throw new CarrierError(`Carrier ${res.status}: ${detail.slice(0, 240)}`, { code: "upstream" });',
    ].join('\n') },
  ];
  const ctx = buildDisclosureContext(files);
  const trpcFor = (cls) => L([
    '} catch (err) {',
    `  if (err instanceof ${cls}) {`,
    '    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });',
    '  }',
    '}',
  ].join('\n'));

  it('repo context: a class whose constructions are all the code\'s own sentences is curated', () => {
    assert.ok(ctx.curatedErrors.has('ConferenceError'));
    assert.ok(!ctx.curatedErrors.has('CarrierError'), 'built from the vendor response body');
  });
  it('quiet: a curated class; control: a class built from the vendor body fires', () => {
    assert.equal(upstreamErrorLeak('a.ts', trpcFor('ConferenceError'), ctx).length, 0);
    assert.equal(upstreamErrorLeak('a.ts', trpcFor('CarrierError'), ctx).length, 1);
  });
  it('control: a class not defined in the repo (a vendor SDK error) still fires', () => {
    assert.equal(upstreamErrorLeak('a.ts', trpcFor('StripeError'), ctx).length, 1);
  });
  it('control: without repo context the rule judges the file alone (unchanged)', () => {
    assert.equal(upstreamErrorLeak('a.ts', trpcFor('ConferenceError')).length, 1);
  });
  it('quiet: a curated class in the classified-pick shape', () => {
    const src = L(['  reason = err instanceof ConferenceError ? err.message : "Could not join.";']);
    assert.equal(upstreamErrorLeak('a.ts', src, ctx).length, 0);
    assert.equal(upstreamErrorLeak('a.ts', L(['  reason = err instanceof CarrierError ? err.message : "Could not send.";']), ctx).length, 1);
  });

  it('quiet: INTERNAL_SERVER_ERROR with a cause when the formatter scrubs those; control: without the formatter', () => {
    const formatter = { relPath: 'init.ts', content: [
      'const t = initTRPC.create({',
      '  errorFormatter({ shape, error }) {',
      '    if (error.code === "INTERNAL_SERVER_ERROR" && error.cause != null) {',
      '      return { ...shape, message: "Something went wrong on our side." };',
      '    }',
      '    return shape;',
      '  },',
      '});',
    ].join('\n') };
    const src = L(['} catch (err) {', '  throw new TRPCError({', '    code: "INTERNAL_SERVER_ERROR",', '    message: err.message,', '    cause: err,', '  });', '}'].join('\n'));
    assert.equal(upstreamErrorLeak('a.ts', src, buildDisclosureContext([formatter])).length, 0);
    assert.equal(upstreamErrorLeak('a.ts', src, buildDisclosureContext([])).length, 1);
  });
  it('quiet: an adminProcedure', () => {
    const src = L([
      '  applyLiveSecrets: adminProcedure.mutation(async () => {',
      '    try { await apply(); } catch (err) {',
      '      throw new TRPCError({ code: "BAD_GATEWAY", message: err.message });',
      '    }',
      '  }),',
    ].join('\n'));
    assert.equal(upstreamErrorLeak('a.ts', src).length, 0);
  });
  it('quiet: a picked message passed straight to a sanitiser, and a TRPCError pick', () => {
    const sanitised = L(['const message = err instanceof RegistrarError ? err.message : "lookup failed";', 'return safeText(message, 200);']);
    assert.equal(upstreamErrorLeak('a.ts', sanitised).length, 0);
    assert.equal(upstreamErrorLeak('a.ts', L(['const message = err instanceof TRPCError ? err.message : "failed";'])).length, 0);
  });
  it('scanDisclosure threads the context through', () => {
    assert.equal(scanDisclosure('a.ts', trpcFor('ConferenceError').join('\n'), ctx).filter((f) => f.rule === 'upstream-error-leak').length, 0);
  });
});
