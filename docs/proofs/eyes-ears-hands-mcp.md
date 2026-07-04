# Proof — Eyes, Ears & Hands of AI Coding (MCP build, 2026-07-04)

**Thesis proven:** AI coding agents are sensorily limited — they write UI
blind, never hear the app fail, and claim "fixed" without proof. This
build removed those limitations through the GateTest MCP server
(13 → 18 tools). Every proof below ran against real targets this session,
through the REAL shipped handlers (dynamic-imported, not re-implemented).

## Competitive context

Compared against SonarQube, Snyk, CodeQL, Semgrep (static — no eyes, no
ears, no hands) and Sentry, Datadog, Rollbar (ears-only — hear prod fail,
can't see UI, can't fix). **Nobody connects hearing → fixing → proving.**
GateTest now does all three over MCP.

## Proof 1 — HANDS: `verify_fix` (❌ before, ✅ after)

Seeded a hardcoded AWS-shaped key in a scratch project
(`src/payment-config.js`), called `verify_fix {path, files:["src/payment-config.js"]}`:

- Before the fix: `❌ NOT VERIFIED — 1 error-severity finding remain on your changed files`
- After replacing with `process.env.AWS_SECRET_ACCESS_KEY`: `✅ FIX VERIFIED — 0 error-severity findings remain`
- Scoping proof: re-seeding the bug but claiming only `src/add.js` changed →
  ✅ verdict on the changed file, while the project-wide delta line still
  reports the repo is not clean. Windows separators (`src\payment-config.js`)
  scope correctly.

Automated in `tests/mcp-verify-fix.test.js` (runs the real engine on the
fixture every suite run) + spawn smoke in `tests/mcp-server.test.js`.

## Proof 2 — EYES: `capture_screenshot` on vapron.ai

`capture_screenshot {url:"https://vapron.ai", width:1280, height:900}` →
**77 KB JPEG image content block** (base64 105,512 chars), rendered and
verified by the operating model actually looking at it: nav, hero
("The developer platform for the next decade."), CTAs, dashboard mock —
including the small stat-card labels that `mobileRendering` flagged at
9.92px in the v1.53.4 session. Payload well under the 700 KB cap.

## Proof 3 — FACTS: screenshot → code digest

`extractDiffRegions` clusters diff pixels into bounding boxes (14 unit
tests incl. multi-region separation, noise floor, region cap);
`harvestFactsInPage` maps a region to
`div.stat-card.dark > span.label.muted` with `font-size: 9.92px` in the
stubbed-DOM tests — the exact "fix THIS selector, THIS property" output.
Wired into `visualRegression` (live-page harvest on failing diffs, opt-out
`collectFacts:false`) and `get_visual_diff {includeFacts:true}`.
Honest limitation: `sourceHint` is a PascalCase-class heuristic; source-map
resolution is out of scope in v1.

## Proof 4 — EARS: `run_live_checks` on vapron.ai

Real run, 446s, verdict ❌ BLOCKED:

- `apiHealth`: **1 broken endpoint + 16 slow (5 critical)** across 19
  checked — independently corroborates the Tools 2/3 sessions' findings
  via a different code path.
- `runtimeErrors`: networkidle timeout on `/` (the page holds connections
  open — consistent with earlier sessions).
- `consoleErrors`: **passed** — honest note: the CSP/Google-Fonts bug this
  module found in the Tools 5-10 session was FIXED and pushed to vapron
  (v1.55.0); a clean pass is the correct current result, not a miss.
- `earsDigest` JSON block round-trips machine-readable
  {module, name, severity, message, file?, line?}.

## Proof 5 — PRODUCTION EARS: `get_production_errors`

- No tokens configured → helpful env-var setup text (SENTRY_AUTH_TOKEN /
  DATADOG_API_KEY / ROLLBAR_READ_TOKEN), not an error.
- Mocked-Sentry path through the real handler → markdown table:
  `TypeError: cart is undefined | src/api/checkout.ts:44 | 412 | sentry`
  with the fix-first tip.
- Live-token proof pending Craig wiring a real Sentry/Rollbar project
  token (30-second setup per the tool's own instructions).

## Proof 6 — LOOP: 🔥 LIVE-first fix queue

`correlateFindingsWithRuntime` is production-consumed for the first time:
`/api/scan/fix` accepts `runtimeEvents[]`, flags matching findings live
(keyed map, survives the correlator's re-sort), `rankClusters` puts LIVE
clusters FIRST (deliberately ahead of root-cause), response carries
`livePriority`, PR body leads with the previously-dead
`renderLiveBadgeSection`. Zero-regression asserted: without live flags the
pre-LIVE ordering is byte-identical. Rollbar event at `checkout.ts:44`
flips a finding at `:42` LIVE (±10 tolerance) in `tests/rollbar-client.test.js`.

## Also fixed while proving (Always-On)

1. **`tests/mcp-server.test.js` had been silently skipped everywhere** —
   its guard resolved the bare SDK package name, which the SDK's exports
   map doesn't expose. The whole MCP server suite never ran (stale
   "exactly 9 tools" vs 13 shipped survived unnoticed). Guard fixed,
   count tripwire live at 18.
2. **Engine exitCode poisoning** — `process.exitCode = 1` on BLOCKED scans
   leaked into the MCP server process; wrapped with `runPreservingExitCode`.
3. **Stale local node_modules** — pixelmatch/pngjs/acorn declared but not
   installed; visual-diff tests and acorn AST parsing were broken locally.
4. **`tests/universal-checker.test.js` recurring deletion** — reproduced
   live during a full sweep (watcher timestamped 14:23:57), hunt narrowed
   to the concurrent window after `gate-workflow-doctor`; see the session
   log / follow-up Known Issue for the closure state.
