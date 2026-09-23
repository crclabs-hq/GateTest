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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// `--help` / `--version` must exit before anything below resolves or starts
// the real server: a stdio MCP server that never printed a version or a
// usage line is indistinguishable from a broken one when a human runs it by
// hand (39s of silence, then a silent `exit 0` on EOF — precisely what
// GateTest issue #679 reported). Both print to STDOUT (this is the one
// window where that's correct — the JSON-RPC transport is never attached in
// this branch) and exit 0 without importing @gatetest/cli at all.
const flags = process.argv.slice(2);
if (flags.includes('--version') || flags.includes('-v')) {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
if (flags.includes('--help') || flags.includes('-h')) {
  process.stdout.write(`GateTest MCP server — stdio transport for AI coding agents.

This process speaks JSON-RPC over stdio; it is meant to be launched by an
MCP client, not run interactively. Add it to one with:

  claude mcp add gatetest -- npx -y @gatetest/mcp-server

Or in an MCP client's config file:

  { "mcpServers": { "gatetest": { "command": "npx", "args": ["-y", "@gatetest/mcp-server"] } } }

Usage:
  npx -y @gatetest/mcp-server            Start the server (stdio, no output until a client connects)
  npx -y @gatetest/mcp-server --help     Show this help and exit
  npx -y @gatetest/mcp-server --version  Print the version and exit

Tool list and setup: https://gatetest.io/mcp
`);
  process.exit(0);
}

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
