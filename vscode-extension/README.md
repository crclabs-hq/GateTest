# GateTest for VS Code

Runs the GateTest code quality engine inside your editor and shows every finding as an inline diagnostic in the Problems panel.

- **Scan Workspace (Quick)** — the fast subset, a few seconds on most repos.
- **Scan Workspace (Full)** — every module that can run in an editor. Mutation and chaos testing stay in CI.
- **Scan This File** — scopes the scan to the file you have open.
- **Cancel Running Scan** — stops the engine immediately.
- **Fix Issues with AI** — opens the hosted fix engine, which opens a verified PR.
- **Add MCP Server to this Workspace** — writes the `@gatetest/mcp-server` entry into `.vscode/mcp.json`.
- **Configure MCP Server for AI Tools** — the same entry for other AI coding tools' config files, on request only; nothing is written at start-up.

## How it runs

The engine is the `@gatetest/cli` library, loaded in a worker thread inside the extension host. Nothing is spawned and nothing needs to be on your PATH. The engine is resolved in this order:

1. `gatetest.enginePath` — a GateTest checkout or an installed `@gatetest/cli`.
2. The workspace's own `node_modules/@gatetest/cli`, so a project pinned to a version scans with that version.
3. The copy bundled with the extension.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `gatetest.suite` | `quick` | Suite used by the save-on-scan hook. |
| `gatetest.autoScanOnSave` | `false` | Run a quick scan of the saved file. |
| `gatetest.showInlineHints` | `true` | Show findings as diagnostics. |
| `gatetest.enginePath` | empty | Override where the engine is loaded from. |
| `gatetest.apiBaseUrl` | `https://gatetest.io` | Hosted API, only for self-hosting. |

## Development

```bash
npm install
npm run compile
npm test
```

Press F5 in VS Code to launch the Extension Development Host. Inside the GateTest repository the extension picks up `../src/index.js`, so engine changes are live on the next scan.
