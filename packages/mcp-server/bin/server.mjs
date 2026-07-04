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
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const serverPath = resolve(__dirname, '../node_modules/@gatetest/cli/bin/gatetest-mcp.mjs');

await import(serverPath);
