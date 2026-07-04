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
 */

// Use import.meta.resolve so Node's module resolution finds @gatetest/cli
// correctly whether npm hoists it (global install) or nests it (local install).
// This avoids the hardcoded ../node_modules/ path that breaks on hoisting.
const serverUrl = import.meta.resolve('@gatetest/cli/bin/gatetest-mcp.mjs');
await import(serverUrl);
