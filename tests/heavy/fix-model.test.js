'use strict';

// =============================================================================
// User-selectable AI model + BYOK (Craig 2026-07-10) — heavy subprocess tests.
//
// CLI: `gatetest fix --apply --model <bad>` must exit 1 with the allow-list,
//      keyless (model validation runs BEFORE the ANTHROPIC_API_KEY check).
// MCP: fix_issue / explain_finding schemas expose the model enum; check_health
//      reflects GATETEST_FIX_MODEL. (fix_issue itself is behind the $29/mo
//      gate, so the bogus-model handler path is proven via the CLI here and
//      unit tests elsewhere.)
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const CLI_PATH = path.resolve(__dirname, '../../bin/gatetest.js');
const SERVER_PATH = path.resolve(__dirname, '../../bin/gatetest-mcp.mjs');

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.ANTHROPIC_API_KEY;
  if (!('GATETEST_FIX_MODEL' in overrides)) delete env.GATETEST_FIX_MODEL;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runCli(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

function callMcp(method, params = {}, env = process.env, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; proc.kill(); reject(new Error(`MCP call timed out: ${method}`)); }
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n').filter((l) => l.trim())) {
        try {
          const parsed = JSON.parse(line);
          if (!settled) { settled = true; clearTimeout(timer); proc.kill(); resolve(parsed); }
        } catch { /* incomplete line — wait for more */ }
      }
    });
    proc.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    proc.stdin.end();
  });
}

describe('CLI fix --model', () => {
  it('rejects an unknown model keyless, exits 1, and names every allowed id', () => {
    const r = runCli(['fix', '--apply', '--model', 'bogus-model'], cleanEnv());
    assert.strictEqual(r.code, 1);
    const out = r.stderr + r.stdout;
    assert.match(out, /Unknown model/i);
    for (const id of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5']) {
      assert.ok(out.includes(id), `allow-list should name ${id}: ${out.slice(0, 400)}`);
    }
  });

  it('rejects an invalid GATETEST_FIX_MODEL env value the same way', () => {
    const r = runCli(['fix', '--apply'], cleanEnv({ GATETEST_FIX_MODEL: 'gpt-4' }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr + r.stdout, /Unknown model/i);
  });

  it('accepts a valid alias, then fails on the missing key (validation ordering)', () => {
    const r = runCli(['fix', '--apply', '--model', 'fable'], cleanEnv());
    assert.strictEqual(r.code, 1);
    const out = r.stderr + r.stdout;
    assert.doesNotMatch(out, /Unknown model/i);
    assert.match(out, /ANTHROPIC_API_KEY is not set/);
    assert.match(out, /Bring your own key/i);
  });

  it('fix --help documents --model and BYOK', () => {
    const r = runCli(['fix', '--help'], cleanEnv());
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /--model <name>/);
    assert.match(r.stdout, /claude-fable-5/);
    assert.match(r.stdout, /bring-your-own-key/i);
  });
});

describe('MCP model arg wiring', () => {
  it('fix_issue and explain_finding schemas expose the model enum (ids + aliases)', async () => {
    const res = await callMcp('tools/list', {}, cleanEnv());
    const tools = res.result.tools;
    for (const name of ['fix_issue', 'explain_finding']) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `missing tool ${name}`);
      const modelProp = tool.inputSchema?.properties?.model;
      assert.ok(modelProp, `${name} should have a model property`);
      for (const v of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5', 'sonnet', 'opus', 'fable']) {
        assert.ok(modelProp.enum.includes(v), `${name} model enum should include ${v}`);
      }
    }
  });

  it('check_health reports the GATETEST_FIX_MODEL-resolved default model', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'check_health', arguments: {} },
      cleanEnv({ GATETEST_FIX_MODEL: 'fable' }),
    );
    const text = res.result.content[0].text;
    assert.match(text, /Default AI model: claude-fable-5/);
  });

  it('check_health flags an invalid GATETEST_FIX_MODEL instead of crashing', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'check_health', arguments: {} },
      cleanEnv({ GATETEST_FIX_MODEL: 'gpt-4' }),
    );
    const text = res.result.content[0].text;
    assert.match(text, /invalid GATETEST_FIX_MODEL/);
  });
});
