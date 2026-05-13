#!/usr/bin/env node

/**
 * gatetest-mcp — MCP stdio server entry point.
 *
 * Spawned by MCP-capable clients (Claude Code, Cursor, Cline, Windsurf,
 * Continue, etc.). The client writes JSON-RPC requests to this process's
 * stdin and reads responses from stdout. All diagnostics go to stderr.
 *
 * See docs/MCP.md for setup instructions.
 */

const { start } = require('../src/mcp/server');

start();
