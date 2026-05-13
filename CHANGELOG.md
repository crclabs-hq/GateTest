# Changelog

All notable changes to GateTest are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.41.0] — 2026-05-13

### Added

- **MCP server** (Model Context Protocol stdio server, protocol 2024-11-05).
  Lets Claude Code, Cursor, Cline, Windsurf, Continue and any MCP-capable
  agent invoke GateTest natively. Zero dependencies — hand-rolled JSON-RPC
  2.0 over stdin/stdout. Three v1 tools:
  - `gatetest_version` — capability discovery
  - `gatetest_list_modules` — full catalog of 67 modules
  - `gatetest_scan` — run a suite or explicit modules, returns the structured
    summary (gateStatus, per-module results, error/warning counts)
- `gatetest_explain_check` MCP tool — given a module + check ID, returns
  what it means, why it matters, and exact fix steps. Turns agents from
  scanner-callers into fixers.
- 67 modules total (was 53 in 1.40.0).
- `bin/gatetest-mcp` standalone entry — what MCP clients spawn.
- `gatetest mcp` subcommand on the main CLI for the same.
- `docs/MCP.md` — setup guide for every major AI client.

### Security

- **Stripe webhook replay defence** — added 5-minute timestamp tolerance to
  `verifyStripeSignature`. Closes the gap where a captured
  `checkout.session.completed` could be replayed indefinitely. Extracted
  to `website/app/lib/stripe-webhook-verify.js` with 21 contract tests.
- **Admin-auth password-length leak fix** — `safeEqual` no longer
  short-circuits on length mismatch. Both inputs are hashed to fixed
  32-byte digests before `timingSafeEqual`. Length is no longer observable
  via response timing. Ported to `website/app/lib/admin-auth-verify.js`
  with 26 contract tests.

### Changed

- Dogfooded GateTest against its own codebase. Net result against the
  security suite: `envVars` 16→0 errors, `hardcodedUrl` 8→0, `logPii`
  1→0, `errorSwallow` 39→0 (all 39 marked with `// error-swallow-ok` +
  rationale).
- `hardcodedUrl`, `errorSwallow` modules gained `// <name>-ok` suppression
  markers matching the vocabulary of sibling modules (`// log-safe`,
  `// tls-ok`, `// cookie-ok`, `// redos-ok`).
- `envVars` module: `app/docs/` paths are now skipped — `process.env.*`
  references rendered inside docs templates are the customer's env vars,
  not ours.
- `GLUECRON_API_URL` / `GLUECRON_TOKEN` legacy aliases removed from
  `integrations/gluecron/client.ts`. Use `GLUECRON_BASE_URL` /
  `GLUECRON_API_TOKEN` exclusively.
- Resolved month-old `TODO(gluecron)` in `src/index.js` — `GluecronBridge`
  is now required, registered in the bridge registry, and exported
  alongside `GitHubBridge`.

### Fixed

- `.env.example` drift from `gatetest.io` → `gatetest.ai` post-domain
  migration.
- 16 referenced-but-undeclared env vars now documented across both
  `.env.example` files (`GATETEST_APP_ID`, `GATETEST_WEBHOOK_SECRET`,
  `GATETEST_PRIVATE_KEY`, `GATETEST_GITHUB_TOKEN`,
  `GATETEST_ADMIN_PASSWORD`, `GATETEST_SSH_*`, `APP_VERSION`,
  `GIT_COMMIT`, `GIT_HOST`).

## [1.40.0] — 2026-04-17

Initial public-ready release. 67 modules across security, hygiene,
reliability, and language coverage (Python, Go, Rust, Java, Ruby, PHP,
C#, Kotlin, Swift). 5 reporters (Console, JSON, HTML, SARIF, JUnit).
HostBridge abstraction (GitHub + Gluecron). Stripe pay-on-completion.
