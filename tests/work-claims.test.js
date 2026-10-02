'use strict';

// WORK CLAIMS — the medic and Claude sessions take Gluecron leases before
// working, so they never edit the same files or chase the same red main.
// The fake lease store below mirrors Gluecron's real rule (one active lease
// per exact target; acquire returns {lease:null} when held).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { targetsFor, acquireAll, mcpCaller, EXIT } = require('../scripts/work-claims');

function fakeGluecron({ failOn } = {}) {
  const active = new Map(); // target -> { id, session }
  let n = 0;
  const calls = [];
  const call = async (tool, args) => {
    calls.push([tool, args]);
    if (tool === 'gluecron_acquire_lease') {
      if (failOn && args.target_id === failOn) throw new Error('HTTP 503');
      const key = `${args.target_type}|${args.target_id}`;
      if (active.has(key)) return { lease: null };
      n += 1;
      const lease = { id: `lease-${n}`, expiresAt: 'later' };
      active.set(key, { id: lease.id, session: args.agent_session_id });
      return { lease };
    }
    if (tool === 'gluecron_release_lease') {
      for (const [k, v] of active) if (v.id === args.lease_id) { active.delete(k); return { released: true }; }
      return { released: false };
    }
    throw new Error(`unknown tool ${tool}`);
  };
  return { call, active, calls };
}

const REPO = 'crclabs-hq/GateTest';

describe('target keys', () => {
  it('one lease per file, sorted and de-duplicated, plus the main-red lease', () => {
    assert.deepEqual(targetsFor({ repo: REPO, files: ['./b.js', 'a.js', 'b.js', ''], mainRed: true }), [
      { type: 'repo-path', id: 'github:crclabs-hq/GateTest:a.js' },
      { type: 'repo-path', id: 'github:crclabs-hq/GateTest:b.js' },
      { type: 'repo-main-red', id: 'github:crclabs-hq/GateTest' },
    ]);
  });
  it('a repo on Gluecron uses its host in the key', () => {
    assert.equal(targetsFor({ host: 'gluecron', repo: 'ccantynz/tallrig', files: ['x.ts'] })[0].id, 'gluecron:ccantynz/tallrig:x.ts');
  });
  it('refuses to claim nothing, or a malformed repo', () => {
    assert.throws(() => targetsFor({ repo: REPO }), /nothing to claim/);
    assert.throws(() => targetsFor({ repo: 'not a repo', files: ['a'] }), /owner\/name/);
  });
});

describe('acquire is all-or-nothing and never reports a false "free"', () => {
  it('the medic takes its files; a session wanting one of them is told held and keeps nothing', async () => {
    const g = fakeGluecron();
    const medic = await acquireAll({ sessionId: 'medic', targets: targetsFor({ repo: REPO, files: ['a.js', 'b.js'] }), durationMs: 1, call: g.call });
    assert.equal(medic.state, 'acquired');
    assert.equal(medic.leases.length, 2);

    const session = await acquireAll({ sessionId: 'claude', targets: targetsFor({ repo: REPO, files: ['0-first.js', 'b.js'] }), durationMs: 1, call: g.call });
    assert.equal(session.state, 'held');
    assert.equal(session.target.id, 'github:crclabs-hq/GateTest:b.js');
    // The lease it had already taken on 0-first.js was given back.
    assert.ok(![...g.active.keys()].some((k) => k.endsWith('0-first.js')), 'partial claim released');
    assert.equal(g.active.size, 2, 'only the medic still holds leases');
  });

  it('only one actor can own red main', async () => {
    const g = fakeGluecron();
    const a = await acquireAll({ sessionId: 'medic', targets: targetsFor({ repo: REPO, mainRed: true }), durationMs: 1, call: g.call });
    const b = await acquireAll({ sessionId: 'claude', targets: targetsFor({ repo: REPO, mainRed: true }), durationMs: 1, call: g.call });
    assert.deepEqual([a.state, b.state], ['acquired', 'held']);
  });

  it('released leases free the files again (control: the store really frees)', async () => {
    const g = fakeGluecron();
    const a = await acquireAll({ sessionId: 'medic', targets: targetsFor({ repo: REPO, files: ['a.js'] }), durationMs: 1, call: g.call });
    await g.call('gluecron_release_lease', { lease_id: a.leases[0].id });
    const b = await acquireAll({ sessionId: 'claude', targets: targetsFor({ repo: REPO, files: ['a.js'] }), durationMs: 1, call: g.call });
    assert.equal(b.state, 'acquired');
  });

  it('an API failure is not_checked with the reason — never held, never acquired — and partial leases are returned', async () => {
    const g = fakeGluecron({ failOn: 'github:crclabs-hq/GateTest:b.js' });
    const r = await acquireAll({ sessionId: 'claude', targets: targetsFor({ repo: REPO, files: ['a.js', 'b.js'] }), durationMs: 1, call: g.call });
    assert.equal(r.state, 'not_checked');
    assert.match(r.reason, /HTTP 503/);
    assert.equal(g.active.size, 0);
  });

  it('no agent session is not_checked, without calling Gluecron', async () => {
    const g = fakeGluecron();
    const r = await acquireAll({ sessionId: '', targets: targetsFor({ repo: REPO, files: ['a.js'] }), durationMs: 1, call: g.call });
    assert.equal(r.state, 'not_checked');
    assert.equal(g.calls.length, 0);
  });

  it('exit codes: acquired 0, held 3, not_checked 2', () => {
    assert.deepEqual(EXIT, { acquired: 0, held: 3, not_checked: 2 });
  });
});

describe('Gluecron MCP caller', () => {
  it('sends a stateless tools/call with the bearer token and reads JSON or SSE answers', async () => {
    const seen = [];
    const replies = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ lease: { id: 'L1' } }) }] } }),
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { structuredContent: { released: true } } })}\n\n`,
    ];
    const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => replies.shift() }; };
    const call = mcpCaller({ baseUrl: 'https://gluecron.example/', token: 'tok', fetchImpl });
    assert.deepEqual(await call('gluecron_acquire_lease', { a: 1 }), { lease: { id: 'L1' } });
    assert.deepEqual(await call('gluecron_release_lease', { lease_id: 'L1' }), { released: true });
    assert.equal(seen[0].url, 'https://gluecron.example/mcp');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
    assert.equal(JSON.parse(seen[0].init.body).method, 'tools/call');
  });

  it('no token → no caller; an HTTP or JSON-RPC error throws (so acquire reports not_checked)', async () => {
    assert.equal(mcpCaller({ token: '' }), null);
    const http = mcpCaller({ token: 't', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }) });
    await assert.rejects(http('x', {}), /HTTP 401/);
    const rpc = mcpCaller({ token: 't', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } }) }) });
    await assert.rejects(rpc('x', {}), /bad/);
  });
});

describe('PR overlap backstop (scripts/pr-overlap-check.js)', () => {
  const { actorOf, judge } = require('../scripts/pr-overlap-check');
  const fs = require('node:fs');
  const path = require('node:path');

  it('medic/ branches are the medic; everything else is a session', () => {
    assert.equal(actorOf('medic/fix-lint'), 'medic');
    assert.equal(actorOf('fix/medic-wording'), 'session', 'segment prefix, not substring');
    assert.equal(actorOf(undefined), 'session');
  });

  it('a medic PR overlapping open session work fails — the medic yields', () => {
    const r = judge({ number: 2, branch: 'medic/x', files: ['a.js', 'c.js'] }, [{ number: 1, branch: 'fix/y', files: ['a.js', 'b.js'] }]);
    assert.equal(r.verdict, 'fail');
    assert.deepEqual(r.overlaps, [{ number: 1, actor: 'session', files: ['a.js'] }]);
  });

  it('a session PR overlapping a medic PR warns but does not fail', () => {
    assert.equal(judge({ number: 1, branch: 'fix/y', files: ['a.js'] }, [{ number: 2, branch: 'medic/x', files: ['a.js'] }]).verdict, 'warn');
  });

  it('control: no shared file passes, and a PR never overlaps itself', () => {
    assert.equal(judge({ number: 1, branch: 'medic/x', files: ['a.js'] }, [{ number: 1, branch: 'medic/x', files: ['a.js'] }, { number: 3, branch: 'fix/z', files: ['b.js'] }]).verdict, 'pass');
  });

  it('the workflow runs the check read-only on every PR update', () => {
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'work-claims.yml'), 'utf8');
    assert.match(wf, /node scripts\/pr-overlap-check\.js/);
    assert.match(wf, /pull-requests: read/);
    assert.doesNotMatch(wf, /write/);
    assert.doesNotMatch(wf, /continue-on-error/);
  });
});
