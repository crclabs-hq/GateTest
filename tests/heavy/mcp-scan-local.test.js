// =============================================================================
// MCP — scan_local must return a scan, not a ReferenceError
// =============================================================================
// Commit aaf95ea2 rewrote the MCP result formatter to use the shared finding
// registry. It deleted
//
//     const passed = allResults.filter(r => (r.errors||0)===0 && (r.warnings||0)===0);
//
// and left three usages of `passed` behind. The line that reads it is not
// guarded by anything, so EVERY scan through MCP that produced results threw
// `ReferenceError: passed is not defined` and came back as
// `Scan failed: passed is not defined`.
//
// That is the free `scan_local` tool and the $29/mo hosted MCP surface, both
// dead, shipped. Nothing caught it: the fast suite never starts the server,
// and a tools/list smoke test passes fine because the crash is in the result
// formatter, not the handler registration. ESLint DID catch it (no-undef) and
// the finding sat in a 260-warning wall nobody read.
//
// So this test drives the real binary over real stdio JSON-RPC and asserts a
// scan comes back. Heavy suite because it spawns a subprocess and runs the
// engine.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'bin', 'gatetest-mcp.mjs');

/** Minimal stdio MCP client: initialize, then one tools/call. */
function callTool(name, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let buf = '';
    let id = 1;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* error-ok — already gone */ }
      resolve(value);
    };

    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) {
          const done = pending.get(msg.id);
          pending.delete(msg.id);
          done(msg);
        }
      }
    });

    const rpc = (method, params) => new Promise((res) => {
      const myId = id++;
      pending.set(myId, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });

    (async () => {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gatetest-test', version: '1.0.0' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const res = await rpc('tools/call', { name, arguments: args });
      clearTimeout(timer);
      finish({ res });
    })();
  });
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-mcp-'));
  // Deliberately contains a real defect, so the scan produces findings AND
  // at least one module passes — the exact combination that reached the
  // broken line. A clean fixture would return early and prove nothing.
  fs.writeFileSync(
    path.join(dir, 'app.js'),
    'function render(req, el) {\n'
    + '  el.innerHTML = "<div>" + req.query.name + "</div>";\n'
    + '}\n'
    + 'module.exports = { render };\n',
  );
  return dir;
}

describe('MCP scan_local — the formatter must not throw', () => {
  it('returns a scan result rather than "Scan failed"', async () => {
    const dir = makeFixture();
    try {
      const { res, timedOut } = await callTool('scan_local', { path: dir });
      assert.ok(!timedOut, 'scan_local did not respond within the timeout');

      const text = String(res?.result?.content?.[0]?.text ?? '');

      // The precise regression. Asserting on isError alone would let a
      // different crash pass as "some error, fine".
      assert.ok(
        !/passed is not defined/.test(text),
        `the deleted \`passed\` binding is back:\n${text.slice(0, 400)}`,
      );
      assert.ok(
        !/^Scan failed/.test(text),
        `scan_local returned a failure:\n${text.slice(0, 400)}`,
      );
      // MCP leaves isError absent on success and sets it true on failure —
      // so assert "not true", not "=== false".
      assert.notStrictEqual(res?.result?.isError, true, 'scan_local reported isError');

      // And it must actually be a scan, not an empty success.
      assert.match(text, /GateTest Scan/, 'result does not look like a scan report');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reaches the passed-modules branch specifically', async () => {
    // The crash was on `if (passed.length > 0)`. A fixture with findings AND
    // clean modules is what walks that line, so assert the branch rendered.
    const dir = makeFixture();
    try {
      const { res, timedOut } = await callTool('scan_local', { path: dir });
      assert.ok(!timedOut, 'scan_local did not respond within the timeout');
      const text = String(res?.result?.content?.[0]?.text ?? '');
      assert.match(
        text,
        /### Passed \(\d+ modules?\)/,
        `the passed-modules section did not render:\n${text.slice(0, 600)}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
