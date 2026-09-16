# GateTest — the code quality gate that lives in your Problems panel

**121 analysis modules. One verdict. Every finding on the line that caused it, before you commit.**

GateTest is the engine behind gatetest.io, running entirely inside your editor. No account, no upload, no binary to install. Open a folder, run a scan, and the Problems panel fills with what a senior reviewer would have caught, ranked by what matters, each with the fix.

## Why teams switch

- **Depth other linters do not reach.** Money handled as floating point. Import cycles that only bite in production. Secrets that a regex would miss. Retry loops that swallow the error. Race conditions in async code. N+1 queries. Redirects and requests that trust user input. Cookie and TLS configuration. Dependency risk that is actually reachable from your code, not just present in a lockfile.
- **A verdict, not a wall.** Findings are ranked by severity and confidence, duplicates across modules are folded into one, and low-confidence results are shown but never block. You read five things that matter, not five hundred that do not.
- **It says what it did not check.** A module that could not run reports itself as skipped, never as a pass. An empty scan is reported as empty, never as clean.
- **Fixes, not just flags.** Every finding carries a suggested fix. When you want the work done for you, one click opens the hosted fix engine, which writes the change, re-scans it, and opens a pull request that proves the fix held.
- **The same engine everywhere.** The identical modules run in your terminal, your CI, your AI coding agent and on gatetest.io, so the verdict you see in the editor is the verdict your pipeline will give.

## Commands

| Command | What it does |
|---|---|
| **GateTest: Scan Workspace (Quick)** | The fast pre-commit set. A few seconds on most repositories. |
| **GateTest: Scan Workspace (Full)** | Every module that can run in an editor. Mutation and chaos testing stay in CI, where they belong. |
| **GateTest: Scan This File** | Scopes the scan to the file you have open. |
| **GateTest: Cancel Running Scan** | Stops the engine immediately. |
| **GateTest: Fix Issues with AI** | Opens the hosted fix engine for the current repository. |
| **GateTest: Fix This Finding (your own key)** | Runs the engine's fix orchestrator inside the editor on your own AI provider key: cost shown before and after, the change previewed as a diff, applied only when you click Apply, then re-scanned. See [Fix locally with your own key](#fix-locally-with-your-own-key). |
| **GateTest: Set AI Provider Key (for local fixes)** | Stores or clears that key in VS Code's secret storage. |
| **GateTest: Add MCP Server to this Workspace** | Writes the `@gatetest/mcp-server` entry into `.vscode/mcp.json`, so your AI agent gets the scanner, the test runner and the fix verifier as tools. |
| **GateTest: Configure MCP Server for AI Tools** | The same entry for other AI coding tools' config files. On request only; nothing is written at start-up. |

Turn on `gatetest.autoScanOnSave` and every save runs a quick scan of that file.

## How it runs

The engine is the open-source `@gatetest/cli` library, bundled with the extension and loaded in a worker thread inside the extension host. Nothing is spawned, nothing needs to be on your PATH, and a long scan never freezes the editor. Cancel is instant.

The engine is resolved in this order, so a project can pin its own version:

1. `gatetest.enginePath` — a GateTest checkout or an installed `@gatetest/cli`.
2. The workspace's own `node_modules/@gatetest/cli`.
3. The copy bundled with the extension.

Scans run on your machine. Nothing leaves it unless you choose the hosted fix engine.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `gatetest.suite` | `quick` | Suite used by the save-on-scan hook. |
| `gatetest.autoScanOnSave` | `false` | Run a quick scan of the file you just saved. |
| `gatetest.showInlineHints` | `true` | Show findings as diagnostics. |
| `gatetest.enginePath` | empty | Override where the engine is loaded from. |
| `gatetest.apiBaseUrl` | `https://gatetest.io` | Hosted API, only for self-hosting. |
| `gatetest.fixDepth` | `standard` | `standard` = the engine's default model for fixes; `deep` = the most capable (slower, roughly 3x the cost per token). |
| `gatetest.fixMaxUsd` | `2` | Stop a local fix once its estimated spend passes this many US dollars (0 = no cap). |

## Fix locally with your own key

`GateTest: Fix This Finding (your own key)` runs the same fix path as `gatetest fix`, inside the editor, on a key you bring. Nothing is proxied through GateTest servers; you pay your AI provider directly.

1. Run **Set AI Provider Key** once. The key goes into VS Code's secret storage (`context.secrets`) — never into `settings.json`, never into the workspace. It is the same key the CLI reads from `ANTHROPIC_API_KEY`; get it from your provider's console. Enter an empty value to clear it.
2. Put the cursor on a GateTest diagnostic (or pick one from the list) and run the command.
3. **Before anything is sent**, the extension shows the estimate: dollars per attempt and the worst case over the engine's retry budget, from the engine's own price table and the request shape the orchestrator actually sends, at the price per million tokens of the depth you chose. Confirm or cancel.
4. The engine generates and ranks its repair hypotheses against a temporary copy of the file. Your file is not touched.
5. The proposal opens as a diff. **Apply** writes it and re-scans the file; **Discard** throws it away. The result is reported as *verified* (the finding is gone), *still present*, or *not checked* (the module did not run in the re-scan) — never "fixed" without the re-scan.
6. **After the run**, the actual token counts and cost are printed in the GateTest output channel and in the notification, whether or not the fix succeeded.

Honest limits:

- The estimate counts the file body only; prompt scaffolding and the issue text are not included, so treat it as a floor per attempt.
- `gatetest.fixMaxUsd` is enforced between provider calls, so a run can end one in-flight call over the cap. The output channel says when that happened.
- If the resolved engine is older than the price table (bundled `@gatetest/cli` 1.61.0 and earlier), the command says **estimate unavailable**, still counts tokens from the provider's response, and cannot enforce the cap — it asks before running instead of showing a guessed figure. `deep` also needs an engine that defines the depth table; older engines run `standard` only.
- The editor preview does not run your test suite; the re-scan after Apply is the verification.

## Also available

- **Terminal:** `npx -p @gatetest/cli gatetest --suite quick` — the same engine, MIT licensed.
- **CI:** `uses: crclabs-hq/GateTest@v1` — a gate on every pull request, on the GitHub Marketplace.
- **AI agents:** `@gatetest/mcp-server` on npm — scan, explain, fix, run tests and verify as tools.
- **Any website or WordPress site:** paste a URL at gatetest.io and a real browser reports what your visitors actually hit.

## Development

```bash
npm install
npm run compile
npm test
```

Press F5 in VS Code to launch the Extension Development Host. Inside the GateTest repository the extension picks up `../src/index.js`, so engine changes are live on the next scan.
