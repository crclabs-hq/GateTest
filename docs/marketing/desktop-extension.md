# Claude Desktop Extension (.mcpb) — GateTest

**Status:** DRAFT for Craig. Building/publishing the bundle is Craig's action.

The Claude Desktop app supports one-click installable extensions packaged as `.mcpb` (MCP Bundle) files. A user double-clicks the file (or installs from a directory) and GateTest's MCP tools appear with zero terminal, zero JSON editing. This is the lowest-friction path for the Desktop audience.

## What's already in the repo

`packages/mcp-server/manifest.json` — the Desktop Extension manifest (manifest_version 0.2). It:
- Declares the server as `npx -y @gatetest/mcp-server` (no bundled node_modules needed — npx fetches at runtime).
- Exposes one optional `user_config` field: `gatetest_api_key` (sensitive, not required) → mapped into the server's `GATETEST_API_KEY` env. Blank key = free tools work.
- Carries display name, description, icon, homepage, and Node ≥20 compatibility.

## Building the bundle

```bash
# install the packaging CLI (one-time)
npm install -g @anthropic-ai/mcpb   # provides the `mcpb` command

cd packages/mcp-server

# validate the manifest
mcpb validate manifest.json

# pack into gatetest.mcpb
mcpb pack . ../../dist/gatetest.mcpb
```

(If the CLI/command name differs at build time, check `mcpb --help` — the flow is validate → pack. The output `.mcpb` is a zip with the manifest at its root.)

## Distributing it
- Attach `gatetest.mcpb` to a GitHub Release on `crclabs-hq/gatetest`.
- Link it from `gatetest.ai/mcp` as a "Claude Desktop — one-click install" button.
- Optionally submit to any Desktop-extension directory Anthropic runs.

## Install experience for the user
1. Download `gatetest.mcpb` (or install from a directory).
2. Claude Desktop prompts for the optional API key (or skip for free tools).
3. GateTest tools are live — no config file, no restart-and-pray.

## Notes
- `.gitignore` already excludes `*.vsix`/build artifacts for the VS Code extension; add `dist/*.mcpb` to the ignore list when the first bundle is built so packaged bundles aren't committed.
- Keep `manifest.json` `version` in sync with `package.json` on each release.
