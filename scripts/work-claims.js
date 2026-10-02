#!/usr/bin/env node
'use strict';

/**
 * Work claims — so the site medic and Claude Code sessions never work on the
 * same thing at once (Craig 2026-10-01: "make sure we don't overlap running
 * code from different ends as in medic and anthropic subscription").
 *
 * One mechanism for every platform: Gluecron agent leases
 * (gluecron.com/ccantynz/Gluecron.com src/lib/agent-multiplayer.ts). A lease is
 * exclusive per (target_type, target_id), enforced by a partial UNIQUE index —
 * two agents cannot both win, and an expired lease frees itself on the next
 * acquire. The leases are taken through Gluecron's MCP endpoint (stateless
 * `tools/call`, Bearer token with `repo` scope).
 *
 * Target keys — the convention every platform's medic and session uses:
 *   repo-path      <host>:<owner>/<repo>:<path>   one lease per file a change touches
 *   repo-main-red  <host>:<owner>/<repo>          "I am fixing red main" (one owner)
 * Leases match on the exact string, so a change claims every file it edits.
 *
 * Acquisition is all-or-nothing and in sorted order: if any target is held,
 * the leases already taken are released and the caller backs off. Three
 * outcomes, never a false "free" (Doctrine 1):
 *   acquired      exit 0   every target is yours; release them when the PR merges/closes
 *   held          exit 3   another agent holds a target — do not start
 *   not_checked   exit 2   no token / no session / API failed — do not start, say why
 *
 * Usage:
 *   node scripts/work-claims.js acquire --repo crclabs-hq/GateTest --files a.js,b.js [--main-red] [--hours 3]
 *   node scripts/work-claims.js release --leases <id>,<id>
 * Env:
 *   GLUECRON_API_TOKEN        Gluecron token with `repo` scope (never printed)
 *   WORK_CLAIM_AGENT_SESSION  the Gluecron agent-session id of THIS actor
 *                             (one for the medic, one for Claude sessions — docs/ops/WORK-CLAIMS.md)
 *   GLUECRON_BASE_URL         default https://gluecron.com
 */

const DEFAULT_HOURS = 3;
const DEFAULT_BASE = 'https://gluecron.com';

/** Canonical lease targets for a change. Pure. */
function targetsFor({ host = 'github', repo, files = [], mainRed = false }) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repo must be owner/name, got ${JSON.stringify(repo)}`);
  const prefix = `${host}:${repo}`;
  const paths = [...new Set(files.map((f) => String(f).trim().replace(/^\.?\/+/, '')).filter(Boolean))].sort();
  const out = paths.map((p) => ({ type: 'repo-path', id: `${prefix}:${p}` }));
  if (mainRed) out.push({ type: 'repo-main-red', id: prefix });
  if (out.length === 0) throw new Error('nothing to claim: pass --files and/or --main-red');
  return out;
}

/**
 * Acquire every target or none. `call(tool, args)` returns the tool's result
 * object or throws. Pure apart from `call`.
 */
async function acquireAll({ sessionId, targets, durationMs, call }) {
  if (!sessionId) return { state: 'not_checked', reason: 'WORK_CLAIM_AGENT_SESSION is not set — this actor has no Gluecron agent session' };
  const taken = [];
  const releaseTaken = async () => {
    for (const l of taken) {
      try { await call('gluecron_release_lease', { lease_id: l.id }); } catch { /* best effort; the lease also expires */ }
    }
  };
  for (const t of targets) {
    let res;
    try {
      res = await call('gluecron_acquire_lease', { agent_session_id: sessionId, target_type: t.type, target_id: t.id, duration_ms: durationMs });
    } catch (err) {
      await releaseTaken();
      return { state: 'not_checked', reason: `lease API failed on ${t.type} ${t.id}: ${err && err.message ? err.message : err}` };
    }
    if (!res || !res.lease || !res.lease.id) {
      await releaseTaken();
      return { state: 'held', target: t };
    }
    taken.push({ id: res.lease.id, type: t.type, target: t.id, expiresAt: res.lease.expiresAt || res.lease.expires_at || null });
  }
  return { state: 'acquired', leases: taken };
}

/** JSON-RPC tools/call against Gluecron's MCP endpoint. */
function mcpCaller({ baseUrl = DEFAULT_BASE, token, fetchImpl = globalThis.fetch }) {
  if (!token) return null;
  let seq = 0;
  return async (name, args) => {
    seq += 1;
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: seq, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Streamable HTTP may answer as SSE; take the last data: line.
    const raw = text.trim().startsWith('{') ? text : (text.split('\n').filter((l) => l.startsWith('data:')).pop() || '').slice(5);
    const msg = JSON.parse(raw);
    if (msg.error) throw new Error(`${msg.error.code}: ${msg.error.message}`);
    const result = msg.result || {};
    if (result.structuredContent) return result.structuredContent;
    const part = (result.content || []).find((c) => c.type === 'text');
    if (result.isError) throw new Error(part ? part.text : 'tool error');
    return part ? JSON.parse(part.text) : result;
  };
}

function parseArgs(argv) {
  const out = { cmd: argv[0], files: [], mainRed: false, hours: DEFAULT_HOURS, leases: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--files') out.files = String(argv[++i] || '').split(',');
    else if (a === '--main-red') out.mainRed = true;
    else if (a === '--hours') out.hours = Number(argv[++i]);
    else if (a === '--leases') out.leases = String(argv[++i] || '').split(',').filter(Boolean);
  }
  return out;
}

const EXIT = { acquired: 0, held: 3, not_checked: 2 };

async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  const call = mcpCaller({ baseUrl: env.GLUECRON_BASE_URL || DEFAULT_BASE, token: env.GLUECRON_API_TOKEN });
  if (args.cmd === 'acquire') {
    let targets;
    try { targets = targetsFor({ host: args.host, repo: args.repo, files: args.files, mainRed: args.mainRed }); }
    catch (err) { process.stdout.write(`${JSON.stringify({ state: 'not_checked', reason: err.message })}\n`); return EXIT.not_checked; }
    const result = call
      ? await acquireAll({ sessionId: env.WORK_CLAIM_AGENT_SESSION, targets, durationMs: Math.max(1, args.hours) * 3600 * 1000, call })
      : { state: 'not_checked', reason: 'GLUECRON_API_TOKEN is not set' };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT[result.state];
  }
  if (args.cmd === 'release') {
    if (!call) { process.stdout.write('{"state":"not_checked","reason":"GLUECRON_API_TOKEN is not set"}\n'); return EXIT.not_checked; }
    const released = [];
    for (const id of args.leases) {
      try { released.push({ id, released: Boolean((await call('gluecron_release_lease', { lease_id: id })).released) }); }
      catch (err) { released.push({ id, released: false, error: err.message }); }
    }
    process.stdout.write(`${JSON.stringify({ released }, null, 2)}\n`);
    return released.every((r) => r.released) ? 0 : 2;
  }
  process.stderr.write('usage: work-claims.js acquire --repo owner/name --files a,b [--main-red] [--hours 3] | release --leases id,id\n');
  return 64;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`work-claims: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 2;
  });
}

module.exports = { targetsFor, acquireAll, mcpCaller, parseArgs, main, EXIT };
