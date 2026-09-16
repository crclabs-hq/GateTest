# Distribution channels — where GateTest is listed, and what each still needs

**Written 2026-09-16, the night the VS Code extension went public.** Craig:
*"we need to add it to the github market place now and anywhere else we can."*
This is the honest map: every channel a developer might look for GateTest on,
whether we are there, and the exact step that gets us there. Rows marked
**Craig** need an account, a token, a DNS record or a listing form that only
the owner can touch. Everything else is done or scripted.

The homepage renders only the LIVE rows (`website/app/lib/distribution.ts`,
guarded by `tests/distribution-surfaces.test.js`). A channel moves onto the
homepage the day it is verified, not the day it is planned.

## Live today (verified 2026-09-16)

| Channel | Identifier | Verified by | Notes |
|---|---|---|---|
| **VS Code Marketplace** | `GateTestHQ.gatetest` 1.1.0 → 1.1.1 | gallery API `validated, public`; item page 200 | Publisher `GateTestHQ` under ccantynz@gmail.com. Update = manage page → row ⋮ → Update, or `publish-vscode.yml` once `VSCE_PAT` exists. First upload was refused as "suspicious content" until the metadata lost threat language + competitor keywords (#523). |
| **npm — CLI** | `@gatetest/cli` 1.61.0 | `npm view` | 1.61.1 (bare `npx @gatetest/cli`, `lib/site-url`) ships on the `v1.61.1` tag — blocked on the Trusted Publisher below. |
| **npm — MCP server** | `@gatetest/mcp-server` 1.1.3 | `npm view` | 1.1.3's proxy imports a CLI that lacks `lib/site-url.js` and crashes before `initialize` (fixed in #510, unpublished). Ships with 1.61.1. |
| **GitHub Marketplace — Action** | `gatetest-quality-gate`, `uses: crclabs-hq/GateTest@v1` | listing 200 | `v1` tag moves with releases. |
| **gatetest.io** | `/web`, `/wp`, `/mcp`, `/playground` | 200 | Hosted scans; free preview. |

## Not listed yet — Craig-only steps, in order of payoff

| # | Channel | Why it matters | What blocks it | Craig's step |
|---|---|---|---|---|
| 1 | **npm Trusted Publisher for `@gatetest/mcp-server`** | Unblocks the `v1.61.1` tag, which publishes CLI 1.61.1, MCP 1.2.0, the Docker image and attaches the WordPress zip — four channels in one tag | `publish.yml` fails E404 on the MCP package without it | npmjs.com → `@gatetest/mcp-server` → Settings → Trusted Publisher: GitHub Actions, repo `crclabs-hq/GateTest`, workflow `publish.yml`. Then `git tag v1.61.1 && git push --tags`. |
| 2 | **Open VSX** (the registry **Cursor, Windsurf, VSCodium, Gitpod** read — they do NOT read Microsoft's) | The four AI-editor audiences the site targets cannot install the extension until this exists | No namespace | open-vsx.org → sign in with GitHub → create namespace `GateTestHQ` → Access Tokens → new token → add repo secret `OVSX_PAT`. `publish-vscode.yml` then publishes to both registries on the same run (the step is skipped while the secret is absent). |
| 3 | **GitHub Marketplace — App** (`gatetest-hq`, 3766251) | The "scan every push" product has no public listing page | App is private; 5 preflight blockers | `node scripts/marketplace-preflight.js`, then App settings: contents:write, statuses:write, subscribe `workflow_run` + `issue_comment`, description from `integrations/marketplace/listing.md`, drop `checks:write`; make public; "List in Marketplace". Checklist: `CRAIG-PRE-SUBMIT-CHECKLIST.md`. |
| 4 | **Official MCP registry** (registry.modelcontextprotocol.io) | Every MCP client's built-in browser reads it | The existing entry is **wrong and off-brand**: `ai.gatetest.www/gatetest` v1.0.0, "111-module QA gate for Claude Code … Replaces SonarQube + Snyk" (dead domain namespace, stale count, names an AI vendor and competitors) | Namespace must become `io.gatetest/gatetest`: `mcp-publisher login dns` needs a TXT record on gatetest.io (Boss Rule #4), then `mcp-publisher publish` with the repo's `server.json` (rename it first). Or `io.github.crclabs-hq/gatetest` via `mcp-publisher login github` (interactive OAuth). |
| 5 | **Docker — ghcr.io/crclabs-hq/gatetest** | `docker run` users; the Dockerfile builds green in CI | `docker-publish.yml` pushes only on a release tag | Falls out of #1. |
| 6 | **WordPress.org plugin directory** | The `/wp` audience searches there first | Zip not on a release; directory review required | After #1 attaches the zip: wordpress.org/plugins/developers/add → upload `gatetest-health-check.zip` (readme.txt `Stable tag` must match the plugin version) → review takes days–weeks. |
| 7 | **PulseMCP / Smithery / mcp.so** | Discovery for MCP servers | PulseMCP lists us at the dead `.ai` domain | PulseMCP: submit a correction (form). Smithery: `smithery.ai/new` with the repo URL. mcp.so: submit form. All need a human account. |
| 8 | **JetBrains Marketplace** | IntelliJ / WebStorm users | No plugin exists | Build item, not a listing step. |

## What is scripted already

- `.github/workflows/publish-vscode.yml` — package + publish to the VS Code Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`); dry-run by default.
- `.github/workflows/publish.yml` — on `v*` tags: npm CLI + MCP server, GitHub Release, WordPress zip.
- `.github/workflows/docker-publish.yml` — on release tags: ghcr.io image + semver aliases.
- `scripts/marketplace-preflight.js` — audits the live GitHub App against what the code needs.

## The copy rule for every listing

Vendor-neutral (no AI vendor or model names — `tests/public-copy-vendor-neutral.test.js`), the module count from the engine (`tests/module-count-sync.test.js`), no deferred-payment claims (`tests/pricing-consistency.test.js`), and **no threat language in store metadata** — "security holes", "attack chains", "PII leaks" and competitor names in keywords got the first VS Code upload refused. Sell the outcome: the verdict, the line, the fix.
