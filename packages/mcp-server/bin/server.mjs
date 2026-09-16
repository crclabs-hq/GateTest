#!/usr/bin/env node
/**
 * GateTest MCP Server — @gatetest/mcp-server
 *
 * Thin proxy to the full MCP server in @gatetest/cli.
 * This keeps @gatetest/mcp-server as the user-facing install target
 * (npx @gatetest/mcp-server) while ensuring the actual server logic
 * is always the current version from @gatetest/cli.
 *
 * Usage in Claude Code:
 *   claude mcp add gatetest -- npx -y @gatetest/mcp-server
 *
 * Or in .claude/settings.json:
 *   { "mcpServers": { "gatetest": { "command": "npx", "args": ["-y", "@gatetest/mcp-server"] } } }
 *
 * stdout is the JSON-RPC stream. Nothing here may write to it; diagnostics
 * go to stderr, which MCP clients surface as server logs.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Use import.meta.resolve so Node's module resolution finds @gatetest/cli
// correctly whether npm hoists it (global install) or nests it (local install).
// This avoids the hardcoded ../node_modules/ path that breaks on hoisting.
const serverUrl = import.meta.resolve('@gatetest/cli/bin/gatetest-mcp.mjs');

// `await import(serverUrl)` on its own does NOT start the server. The cli's
// bin only attaches its stdio transport when it is the process entrypoint
// (argv[1] resolves to its own file), and under this proxy argv[1] is
// server.mjs. @gatetest/mcp-server 1.1.3 shipped exactly that: the import
// resolved, every handler was registered, nothing listened on stdin, and the
// process exited 0 with an empty stdout — which an MCP client experiences as
// `initialize` never being answered. So the import is followed by an
// explicit start.
const cli = await import(serverUrl);

if (typeof cli.startServer === 'function') {
  // In-process: one Node process, one stdio pair, no signal relaying.
  await cli.startServer();
} else {
  // A @gatetest/cli published before startServer existed (≤ 1.61.1). Run its
  // bin as the entrypoint of a child instead: argv[1] is then the real file,
  // its own isMain guard is true, and inherited stdio lets the JSON-RPC
  // stream pass through this process untouched.
  const child = spawn(process.execPath, [fileURLToPath(serverUrl)], { stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { child.kill(sig); });
  }
  child.on('error', (err) => {
    process.stderr.write(`gatetest-mcp-server: could not start @gatetest/cli: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(signal ? 128 + (os.constants.signals[signal] || 0) : (code ?? 1));
  });
}
