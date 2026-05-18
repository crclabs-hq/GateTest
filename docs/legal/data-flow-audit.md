# Data-flow & privacy audit — pre-launch

Generated: 2026-05-17
Auditor: read-only

## Summary

- Marketing claims verified: 4 of 6 (TRUE with caveats)
- Marketing claims contradicted by code: 1 of 6 ("Repo never leaves CI" is materially false for paid scans)
- Marketing claims partially / "needs nuance": 1 of 6 ("Scans are ephemeral" — workspace yes, derived data no)
- Privacy red-flags: 8 (1 critical, 3 high, 4 medium)
- GDPR / CCPA compliance gaps: 5

The product is materially honest. The biggest exposures are:

1. **Sentry is wired with `sendDefaultPii: true` + `includeLocalVariables: true` + 10% Session Replay**, and is NOT in the privacy policy's sub-processor list.
2. **`fix_recipes` and `dissent` tables persist actual customer code snippets** (`before_snippet TEXT`, `after_snippet TEXT`, up to 2KB each) across customers — the "scans are ephemeral" claim doesn't cover this.
3. **No cookie-consent banner** despite the privacy policy noting "strictly necessary only" as the intended posture — Sentry Replay + Vercel function-level cookies push us past strictly-necessary.

None of these are launch blockers if the privacy policy is updated and the marketing copy on `HomeFaq.tsx` is softened. The integrity of the underlying flows (Stripe manual capture, HMAC fail-closed, GitHub OAuth cookie flags) is solid.

---

## Marketing claim verification

### Claim 1: "Scans are ephemeral"

> "No. Scans are ephemeral. We clone, run the engine, post the report, delete the clone. … For paid scans run from our infra, the working copy lives on a Vercel function for the duration of the scan and is gone when the response returns."
> — `website/app/components/HomeFaq.tsx:39-43`

- **Evidence (filesystem):** `website/app/lib/cli-engine-runner.js:267-273` — `finally { try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { … } }`. The `/tmp/gatetest-scan-*` workspace is created via `mkdtempSync` (line 193) and deleted in the finally block. Verified.
- **Evidence (Vercel `/tmp` is per-invocation):** comment at `website/app/lib/cli-engine-runner.js:268-269` notes the belt-and-braces. Vercel functions don't persist `/tmp` across invocations.
- **Verdict:** TRUE for the in-flight workspace. FALSE for derived data.
- **Caveats:**
  - Scan summary (totalIssues, modulesList, scan_duration, scan_completed timestamp) is written to **Stripe payment-intent metadata** in `website/app/api/scan/run/route.ts:483-493`. That data lives in Stripe forever.
  - Scan summary (hashed repo URL, totalIssues, totalModules, duration, module pass/fail) is written to the `scan_history` table in Neon Postgres — `website/app/lib/scan-history-store.js:59-72`. No retention policy in code.
  - Audit log writes `resourceId: "{owner}/{repo}"` (cleartext repo coords) — `website/app/api/scan/run/route.ts:433, 450`. Retention: 7 years per `website/app/lib/audit-log-store.js:34`.
  - **`fix_recipes` table stores 2KB code snippets** (before_snippet / after_snippet) — `website/app/lib/fix-recipe-store.js:43-56`. Hashed by `before_hash` but the actual snippet text is stored cleartext. Cross-customer reuse is the explicit purpose ("compounding moat" per CLAUDE.md).
  - Anthropic receives the full file contents (see Claim 2).

### Claim 2: "Repo never leaves CI"

> "The repo never leaves your CI environment when you install the GitHub Action — we never see it."
> — `website/app/components/HomeFaq.tsx:40-41`

- **Evidence:** This is true ONLY for the CI-gate path where the customer installs `integrations/github-actions/gatetest-gate.yml` and the gate runs inside their own runner. For the paid scan path (the actual revenue path) this is materially false.
- **Counter-evidence (paid scan path):**
  - `website/app/api/scan/run/route.ts:163` calls `fetchTree(owner, repo, "HEAD", token)` and `:188` calls `fetchBlob(owner, repo, filePath, "HEAD", token)` against the Gluecron/GitHub API — code is pulled into our Vercel function.
  - `website/app/api/scan/fix/route.ts:428-441` POSTs file contents + issue text + path to `https://api.anthropic.com/v1/messages`. Prompt at `:520-541`. The customer's source code is sent to Anthropic.
  - `website/app/api/scan/server-fix/route.ts:343` posts to `api.anthropic.com` for diagnoses.
  - `website/app/api/chat/route.ts:36` posts customer chat text (could include code paste) to Anthropic.
- **Verdict:** TRUE for the self-hosted CI integration. FALSE for any paid scan, fix, server-fix, chat. Marketing copy must distinguish the two paths.
- **Recommended fix to copy:** "If you install the GitHub Action, the repo never leaves your CI — we never see it. If you use a paid scan via gatetest.ai, your code is read by our Vercel function during the scan and individual snippets are sent to Anthropic for AI review. See the Privacy Policy sub-processor list for details."

### Claim 3: "Pay only if we fix it" / "Pay on completion" — manual capture

> "We hold your card via Stripe Payment Intent (manual capture), run the scan, and capture only if the scan delivers a usable report."
> — `website/app/components/HomeFaq.tsx:72-74`

- **Evidence:** `website/app/api/checkout/route.ts:176` — `"payment_intent_data[capture_method]": "manual"`. Confirmed.
- **Evidence (capture is gated on success):** `website/app/api/scan/run/route.ts:496-500` — `if (!result.error) { capture } else { cancel }`. Confirmed.
- **Evidence (idempotency to prevent double-charge):** `website/app/api/scan/run/route.ts:370-413` — fetches PI metadata, returns cached state if `scan_status` already `complete` or `failed`. Confirmed.
- **Verdict:** TRUE.
- **Caveat:** Stripe metadata permanently records the repo URL, tier, totalIssues, totalModules, modulesList — `website/app/api/scan/run/route.ts:483-491`. Customers signing up at gatetest.ai are implicitly consenting to Stripe seeing their repo URL.

### Claim 4: "No signup, no install" — free /web and /wp scans

> Implied by the free-preview tier on `/web` and `/wp`.

- **Evidence:** `website/app/api/web/scan/route.ts:234-275` — no auth check, no cookie check, no rate-limit gate inside the handler (only URL validation + private-IP blocklist at `:51-60`).
- **Evidence:** `website/app/api/wp/scan/route.ts` — same shape (read but not pasted here).
- **Verdict:** TRUE.
- **Caveat:** Rate limiting is per-IP via `lib/rate-limit.js` — `cf-connecting-ip` / `x-forwarded-for` / `x-real-ip` (line 154-157). IPs are not persisted to the DB by the limiter (in-memory only, comment at `:53`).

### Claim 5: HMAC fail-closed on all webhook endpoints

> Bible Forbidden #15 + Known Issue #13 require fail-closed signature verification.

- **Evidence (GitHub webhook):** `website/app/lib/github-events.js:202-211` — `if (!secret) { return 503 'GITHUB_WEBHOOK_SECRET not set' }` and `if (!verifyGitHubSignature(...)) { return 401 'invalid signature' }`. Fail-closed.
- **Evidence (Stripe webhook):** `website/app/api/stripe-webhook/route.ts:31-62` — `verifyStripeSignature` returns `false` if `!STRIPE_WEBHOOK_SECRET` (line 35) or if `!sigHeader` (line 36). Uses `crypto.timingSafeEqual` for the actual compare. Fail-closed.
- **Evidence (Signal Bus / Gluecron emitter):** `website/app/lib/events-push.js:62-67, 148` — same pattern, returns `false` on missing secret. Fail-closed.
- **Evidence (self-scan-status):** `website/app/lib/self-scan-status.js:228-234` — 401 on missing header, 403 on invalid signature, 503 on missing secret. Fail-closed.
- **Evidence (Sentry healing webhook):** see `SENTRY_WEBHOOK_SECRET_HEAL` env, route at `website/app/api/heal/sentry-webhook/route.ts` (not pasted but follows same shape).
- **Verdict:** TRUE.

### Claim 6: Self-scan badge — no customer code in the publish step

- **Evidence:** `scripts/publish-self-scan.js:44-67` — `deriveBadgePayload` extracts ONLY `gateStatus`, `errorCount`, `warningCount`, `modulesPassedCount`, `modulesTotalCount`, `scannedAt`, `commitSha` from the local report. No file contents, no per-finding details, no customer identifiers.
- **Evidence (signing):** `:107-110` HMAC-SHA256 of the canonical body with `GATETEST_INTERNAL_TOKEN`.
- **Verdict:** TRUE. The publish payload is OUR scan results about OUR repo — not customer data.

---

## Customer touchpoint walks

### A. Stripe checkout → scan flow

```
Browser
  → POST /api/checkout (tier, repoUrl)
    → Stripe Checkout Session created with capture_method=manual + metadata {tier, repo_url, modules}
  ← checkoutUrl, sessionId
Browser → Stripe Checkout (out of our control)
  ← redirected back to /checkout/success?session_id=...
Browser → /api/scan/run POST {sessionId, repoUrl, tier}
  → Stripe API: GET /v1/payment_intents/{pi}  (idempotency + paid-tier resolution)
  → Gluecron API: fetchTree + fetchBlob (pulls source code into Vercel function /tmp via cli-engine-runner)
  → cli-engine-runner runs all 90 modules against /tmp workspace
  → fs.rmSync(/tmp/gatetest-scan-*) in finally block
  → Stripe API: POST /v1/payment_intents/{pi} (writes scan summary into metadata)
  → Stripe API: POST /v1/payment_intents/{pi}/capture (or /cancel on failure)
  → Audit log: actor=sessionId, action=scan.completed, resourceId=owner/repo, metadata=tier+totalIssues+moduleCount
  ← JSON {status, modules, totalIssues, ...}
```

**Data persistence:**
- Stripe metadata: tier, repo URL, modules list, totalIssues, scan_duration, scan_completed timestamp. Retained per Stripe's policy (effectively permanent).
- Audit log (Neon): actor (sessionId), action, `resourceId="{owner}/{repo}"` — **cleartext repo coords**. 7-year retention.
- Working filesystem: deleted in finally block. Vercel `/tmp` is per-invocation.

**Data shared externally:**
- Stripe: card + billing details + repo URL + scan summary.
- Anthropic: NOT triggered by `/api/scan/run` alone (that's the scan-only path). Triggered by `/api/scan/fix` if the customer paid for the fix tier — sends file content + path + issues.

### B. GitHub App webhook → scan flow

```
GitHub
  → POST /api/webhook (push or pull_request, signed X-Hub-Signature-256)
    → HMAC verify (fail-closed)
    → enqueueScan() into scan_queue (Neon) with host='github'
    → fire-and-forget POST /api/scan/worker/tick (with X-Vercel-Cron-Secret)
  ← 202 processing

Cron worker tick
  → SELECT … FROM scan_queue WHERE status='queued'  (locked-update)
  → runScanJob (similar to /api/scan/run)
  → dispatchCallback: if host='github', postGithubCallback (commit status + PR comment)
                      else postGluecronResult
```

**Data persistence in scan_queue:**
- `repository` (cleartext "owner/repo"), `sha`, `ref`, `pullRequestNumber`, `eventId`, `host`, `status`, `attempts`. No file contents. See `website/app/lib/scan-queue-store.js:33-55`.
- No retention policy in code — rows linger.

**Who has DB access:** Vercel functions via `DATABASE_URL` (Neon connection). Operationally: Craig + anyone with Neon console access.

### C. URL scan (/web, /wp)

```
Browser → POST /api/web/scan {url}
  → parseUrl: blocks localhost/127/10/172.16-31/192.168/169.254
  → no auth, no DB write of input
  → fetch(url) with User-Agent: "GateTest/1.0 Site Scanner (gatetest.ai)"  — website-scanner.ts:130
  → Run static-probe modules (web-headers, tls-security, cookie-security, …) against fetched HTML
  → If Playwright available: runtimeErrors module launches Chromium and visits URL
  → Cluster findings, compute health score
  ← JSON {findings, healthScore, …}
```

**What goes out:**
- An HTTP GET request to the target URL with our user-agent. Headers: `User-Agent: GateTest/1.0 Site Scanner (gatetest.ai)`, `Accept: text/html,application/xhtml+xml`. No customer identification beyond IP.
- No outbound requests to Anthropic for the URL scan path.

**What gets cached/logged:**
- No DB write of the URL or response.
- Console logs may include the URL (per generic logging pattern).
- Sentry instrumentation will capture exceptions during the scan — see Section I below.

### D. AI CI-fixer flow (/api/scan/fix)

```
Browser → POST /api/scan/fix {repoUrl, issues}
  → resolveRepoAuth (Gluecron / GitHub fallback)
  → fetchBlob for each affected file (file content into function memory)
  → For each clustered file: askClaude(fileContent, filePath, issues)
    → POST https://api.anthropic.com/v1/messages
       headers: x-api-key=ANTHROPIC_API_KEY, anthropic-version: 2023-06-01
       body: { model, max_tokens, messages: [{ role:'user', content: prompt }] }
       prompt: "FILE: {filePath}\nISSUES TO FIX:\n…\nCURRENT CODE:\n```\n{fileContent}\n```\n…"
  → Cross-fix syntax gate (in-memory)
  → Cross-file scanner gate (re-runs scan on synthetic post-fix workspace)
  → Test generator askClaudeForTest(prompt) — sends fix diff + file path to Anthropic
  → (scan_fix tier) Pair review askClaudeForReview — sends original/fixed diff to Anthropic
  → (scan_fix tier) Architecture annotator — sends codebase shape + sample files to Anthropic
  → openPullRequest with PR composer body
  → Optionally save fix recipe to fix_recipes table (before/after snippets persisted)
```

**Consent / disclosure:**
- The privacy policy (`website/app/legal/privacy/page.tsx:473-483`) DOES list Anthropic as a sub-processor with the disclosure "only the specific code snippets sent for review (not your whole repository). Anthropic's commercial API Terms prohibit training on your inputs."
- "Specific code snippets" is technically true — the prompt sends one file at a time, not the whole tree. But for a multi-file fix, that's still a lot of source code.
- **NO `anthropic-beta: prompt-caching-2024-07-31` or similar header set on `/api/scan/fix` calls.** A `no-training` header is not specified by Anthropic (zero data retention is governed by your enterprise plan, not a header), so this is informational only.

**Anthropic's data retention:** per Anthropic's Commercial API ToS, prompts are retained for up to 30 days for trust & safety. No customer-identifying metadata is in the prompt (we don't pass `metadata` field on the messages API call) — see `website/app/api/scan/fix/route.ts:548-558`.

**Error logging risk:** If `anthropicCall` throws after a TLS handshake failure, the error message can include URL + status. The prompt body is NOT in the error (verified by reading the catch block at `:478-484`). Sentry server config DOES have `includeLocalVariables: true` — a thrown exception during the Anthropic call will let Sentry inspect `body` (the full prompt JSON) as a local. **This is the largest single PII exposure surface in the codebase.** See Red Flag #1.

### E. Self-scan stats publishing

```
CI job (.github/workflows/ci.yml)
  → node bin/gatetest.js --suite quick --json  →  .gatetest/reports/gatetest-report-latest.json
  → node scripts/publish-self-scan.js
    → reads report, derives badge payload (NO source code, NO file paths, NO customer data)
    → HMAC-signs with GATETEST_INTERNAL_TOKEN
    → POST {gatetest.ai}/api/internal/self-scan-status
      → HMAC verify (fail-closed, 401/403/503)
      → In-memory storage (per the comment in self-scan-status.js)
  ← OK
```

Confirmed clean. Only counts + timestamps + commit SHA travel.

### F. Audit log

- Schema at `website/app/lib/audit-log-store.js:48-64`: id, created_at, actor, action, resource_type, resource_id, metadata (JSONB), prev_hash, row_hash.
- Hash-chained, tamper-evident.
- **Privacy contract:** docstring at `:36-39` says metadata MUST NOT contain raw source code, secrets, or personally-identifying customer data — caller is responsible.
- **Actual usage:** scan/run writes `resourceId="{owner}/{repo}"` — that IS a customer identifier. But the contract says "use IDs and hashes" — repo coords are an ID, so technically compliant.
- Retention: 7 years (SOC2 standard) — `:34`. `purgeExpired()` exists but is not invoked anywhere.

### G. Telemetry

- `website/app/lib/fix-telemetry.js:60-84` — strict whitelist. Records: `ts, layer, success, issueRuleKey, module, durationMs, costUsd, reason, model, fileExt`. No file contents, no repo URLs, no PII.
- Storage: `~/.gatetest/telemetry/fix-attempts.jsonl` (local file, not Neon).
- Verified clean.

### H. Logs

Inventory of `console.log` / `console.error` calls in the scan paths:

- `scan/run/route.ts:245, 259, 294, 385, 412, 424, 503, 523, 545` — error / warn messages with paths, msg.slice(0, 200), `sessionId.slice(0, 12)…` (truncated per Bible Known Issue #17 fix). Safe.
- `scan/run/route.ts:545-547` — `console.log("[GateTest] {summariseShadowResult(shadowSummary)}")` — that's counts only, no PII.
- `scan/fix/route.ts:1634, 1723, 1744` — confidence score, budget snapshot, crash message. No customer code in the log strings.
- `scan-executor.ts:267, 283, 344, 380, 400` — error messages only.
- `cli-engine-runner.js:69, 78, 99, 272` — write-failure messages with the relative file path. `relPath` IS a customer-controlled path string. Low severity (Vercel logs are private to us) but worth noting — a malicious path could be logged.

Stripe ID truncation to 12 chars is in place per Bible Known Issue #17.

### I. Sentry / error tracking

Files: `website/sentry.server.config.ts`, `website/instrumentation-client.ts`, `website/instrumentation.ts`.

- **Server config (`sentry.server.config.ts`):**
  - `sendDefaultPii: true` (line 13)
  - `tracesSampleRate: 0.1` in prod (line 15)
  - `includeLocalVariables: true` (line 22) — **this is the dangerous one**
  - `enableLogs: true` (line 24)
- **Client config (`instrumentation-client.ts`):**
  - `sendDefaultPii: true` (line 19)
  - `tracesSampleRate: 0.1` in prod (line 22)
  - `replaysSessionSampleRate: 0.1` (line 27) — **10% of all visitor sessions are video-replayed**
  - `replaysOnErrorSampleRate: 1.0` (line 28) — **100% of error sessions are video-replayed**

**Impact:** A 500 from `/api/scan/fix` will let Sentry capture:
- The full prompt body (variable `body` in `anthropicCall`, includes file content + path + issue text)
- The original file content (`fileContent` local in `askClaude`)
- The repo URL (`repoUrl` local on the route handler)
- The Anthropic API key (`ANTHROPIC_API_KEY` env var — **not** captured by Sentry unless it's a local variable in a thrown frame; we should double-check the Sentry beforeSend filter doesn't strip authorization-style env vars)

**No `beforeSend` / `beforeBreadcrumb` filter is configured** to scrub source code or API keys.

### J. Fonts / external CDN scripts

Searched `website/app` for `fonts.googleapis`, `cdn.jsdelivr`, `unpkg`, `cdnjs`, external `<Script>` tags. **None found.** Layout.tsx doesn't import `next/font/google`; fonts must be locally hosted in CSS (verified by absence of font imports).

---

## Specific checks

### A. Anthropic API call sites

| Route | What goes in `messages` | Customer code? | Customer ID in metadata? |
|---|---|---|---|
| `/api/scan/fix` `:493-541` | File path + file content + issue text + GateTest critical-rules prompt | Yes (file contents) | No (no `metadata` field passed) |
| `/api/scan/fix` `askClaudeForTest` `:663` | Fix diff + test instructions | Yes (diff snippets) | No |
| `/api/scan/fix` `askClaudeCreate` `:678` | New file path + context | Possibly (file context) | No |
| `/api/scan/server-fix` `askClaudeForDiagnosis` `:333-343` | Finding detail + module + severity + hostname | Hostname is customer-identifying | No |
| `/api/chat` `:36` | Customer's chat messages | If they paste code | No |
| `architecture-annotator` (called from /api/scan/fix) | Codebase shape + N sample files | Yes (sample files) | No |
| `pair-review` (called from /api/scan/fix scan_fix tier) | Original/fixed diff + regression test | Yes (diff) | No |
| `nuclear-diagnoser` (called from /api/scan/server-fix nuclear tier) | Per-finding details + platform context | Hostname is customer-identifying | No |

**No `anthropic-beta` header for prompt-caching or "no-training" is set.** Anthropic's Commercial Terms govern training behavior (they don't train on commercial API inputs by default — confirmed by the privacy policy at `:147`). For an enterprise account with zero data retention, an enterprise contract is required (no per-request header exists).

**Error logging:** the Anthropic call wraps response text in `data.raw` on parse failure (`/api/scan/fix:444`). This includes Anthropic's response body which is the AI completion — that's customer code coming back. If a logger captures `data.raw`, customer code goes to logs.

### B. Stripe metadata review

Per `/api/checkout/route.ts:173-189` and `/api/scan/run/route.ts:483-491` we send to Stripe:

- `metadata[tier]` — internal code
- `metadata[repo_url]` — **customer repo URL** (cleartext)
- `metadata[modules]` — tier-name string
- `metadata[scan_status]`, `[total_issues]`, `[total_modules]`, `[scan_duration]`, `[scan_completed]`, `[modules_list]`
- `metadata[modules_N]` — pipe-joined per-module summaries (name:status:checks:issues:duration)

No file contents in Stripe metadata. The repo URL is the most sensitive item — Stripe sees it permanently. Privacy policy at `:455-456` discloses this ("GateTest scan metadata (scan ID, tier)"). It does NOT explicitly mention the repo URL — should be added.

### C. GitHub API call review

GitHub PAT is `GH_TOKEN` env var (per `.env.example:60`). Scope expected: `repo` (per `src/core/github-bridge.js:438`).

**Local caching:**
- File contents cached in-process during scan execution (`fileContents: RepoFile[]`) — lives for the function lifetime, gone after response.
- No persistent cache of GitHub responses.

**DB storage:** `scan_queue.repository` (cleartext "owner/repo"), `installations.installation_id`, `installations.customer_email`, `installations.customer_login`.

**Risk:** The GitHub PAT (`GH_TOKEN`) is used for ALL customer scans when the App is not installed — so a single token gates everyone. Mass-revoke is the only mitigation. This is documented in `.env.example:60`.

### D. Postgres / Neon database review

Tables found:

| Table | Customer-identifying columns | Notes |
|---|---|---|
| `scans` (`schema.sql:1-25`) | `session_id`, `payment_intent_id`, `customer_email`, `repo_url`, `results JSONB` | Cleartext repo URL. `results JSONB` could hold finding details. No retention policy. |
| `customers` (`schema.sql:27-35`) | `email`, `github_login`, `stripe_customer_id`, `total_spent_usd` | Cleartext. |
| `installations` (`schema.sql:37-47`) | `installation_id`, `customer_email`, `customer_login` | Cleartext. |
| `watches` (`schema.sql:58-72`) | `owner_login`, `target` (URL or owner/repo) | Cleartext. |
| `heal_history` (`schema.sql:75-86`) | `pr_url`, `details JSONB` | Cleartext. |
| `audit_log` (audit-log-store.js:48-64) | `actor`, `resource_id`, `metadata JSONB` | Hash-chained. 7-year retention. resource_id can be "owner/repo" cleartext. |
| `scan_queue` (scan-queue-store.js:33-55) | `repository`, `sha`, `ref`, `eventId` | Cleartext. No retention policy in code. |
| `scan_history` (scan-history-store.js:59-68) | `repo_hash` (HASHED), `module_summary JSONB` | **Hashed** — good. No retention policy. |
| `scan_fingerprint` (scan-fingerprint-store.js:71-91) | `repo_url_hash` (HASHED) | Hashed. Has explicit deletion-by-hash support — `:286`. |
| `dissent` (dissent-store.js:65-84) | `repo_url_hash` (HASHED), `reviewer_hash` (HASHED) | Hashed. |
| `external_integrations` (external-integrations-store.js:94-110) | `repo_url_hash` (HASHED), `vendor`, `org_id`, `project_id` | Hashed; org/project IDs cleartext. |
| `fix_recipes` (fix-recipe-store.js:43-69) | `before_snippet TEXT`, `after_snippet TEXT` (up to 2KB each) | **NOT HASHED — actual code snippets, persisted, cross-customer shared.** Header at `:31` says "Only anonymised code snippets keyed by hash" but the snippet text itself is cleartext. |
| `fixes_log` (fixes-store.js) | not fully audited | Worth a closer look pre-launch. |
| `fix_registry` (fix-registry-store.js:18-) | not fully audited | Worth a closer look. |

**Retention policy in code:** ONLY `audit_log` has retention semantics (`DEFAULT_RETENTION_YEARS = 7` + `purgeExpired()`). No DELETE-by-age logic on `scans`, `scan_queue`, `scan_history`, `fix_recipes`, `dissent`.

### E. Vercel KV / blob storage

Searched for `@vercel/kv`, `@vercel/blob`. Not in `website/package.json` dependencies. **Not used.**

### F. Module-level state on serverless

Searched for module-level mutable state in the website. Beyond the documented `self-scan-status.js` in-memory store, found:

- `lib/rate-limit.js:53` — explicit in-memory limiter. Documented and per-process-warm-instance. Acceptable for a best-effort limiter.
- Sentry SDK maintains a module-level Hub. By design.

No other unexpected module-level state observed in the scan-touching files.

### G. Cookies / session

- `gatetest_admin_session` — admin OAuth session, `HttpOnly`, `SameSite=Lax`, `Secure` in prod (`/api/github/admin-callback/route.ts:157-161`). 7-day TTL.
- `gatetest_customer` — customer OAuth session, `HttpOnly`, `SameSite=Lax`, `Secure` in prod (`/api/auth/callback/route.ts:100-110`). 30-day TTL.
- `gh_oauth_state` — short-lived OAuth state cookie.
- `gt_admin` — admin password-cookie alternative (legacy/parallel path) — `lib/admin-auth.ts` documents HttpOnly + Secure + SameSite=Lax.

No cookies set for anonymous users. **No tracking cookies.** No GA, no Plausible, no PostHog wired.

**However:** Sentry's session-replay (10% of all sessions) places a Sentry session identifier in localStorage and a Sentry transaction trace ID. This is sub-processor-grade data sharing without explicit consent — a real GDPR exposure if hit by an EU user without a consent banner.

### H. Third-party scripts on the homepage

`<script src=...>` searches: none. `next/font/google` searches: none. Sentry SDK is JS-bundled, not a `<script src>` to an external CDN.

### I. Sentry — see Section I above

Critical: `includeLocalVariables: true` + no `beforeSend` filter + `enableLogs: true`.

### J. Fonts from external CDN

None. No `<link href="fonts.googleapis.com">`. No `next/font/google` imports. Confirmed clean.

---

## Privacy red flags ranked

### 1. CRITICAL — Sentry server captures local variables including customer source code and prompt bodies

- **Location:** `website/sentry.server.config.ts:22` — `includeLocalVariables: true`
- **Impact:** When `/api/scan/fix` throws (or any module errors), Sentry receives a stack frame snapshot with locals: `body` (full Anthropic prompt JSON, including the customer's file contents), `fileContent`, `repoUrl`, `prompt`, `issues`, etc.
- **Compounded by:** `sendDefaultPii: true` (line 13), `enableLogs: true` (line 24), and no `beforeSend` filter.
- **Sub-processor:** Sentry IS NOT listed in the privacy policy's sub-processor section (`website/app/legal/privacy/page.tsx:450-527`).
- **Recommended action:**
  1. Either set `includeLocalVariables: false` OR add a `beforeSend` filter that strips locals containing source-like text (heuristic: > 1KB, contains `\n` in known frames).
  2. Add Sentry to the sub-processor list in the privacy policy with: "Sentry, Inc. (United States) — error monitoring. Sees: HTTP request metadata, stack traces from server crashes (may include excerpts of customer code in scope at crash time)."
  3. Confirm Sentry's PII scrubbing setting for the project (Sentry-side dashboard, not code-side) — set "Send PII" to OFF if the Sentry project doesn't already strip authorization headers.

### 2. HIGH — `fix_recipes` table persists 2KB customer code snippets cross-customer

- **Location:** `website/app/lib/fix-recipe-store.js:43-56` — `before_snippet TEXT NOT NULL, after_snippet TEXT NOT NULL`. Capped at 2KB by `MAX_SNIPPET_BYTES = 2048` (line 75).
- **Impact:** Customer A's fix for a bug becomes (after promotion to high confidence) the recipe served to Customer B. Customer A's literal code is in Customer B's PR.
- **Disclosure status:** Not in the privacy policy. Not in HomeFaq's "Is my code stored anywhere?" answer.
- **Recommended action:**
  1. Either:
     - Add a hash-and-template normalisation pass before insert (replace identifiers with `$VAR1`, `$VAR2`, etc.), OR
     - Disclose explicitly in the privacy policy: "Successful fix patterns may be added to our cross-customer recipe library; snippets are limited to 2KB and stored without customer identifiers."
  2. Add a per-customer opt-out flag — recipe-store-remote.js already exists; verify there's a "do not promote" path.

### 3. HIGH — Privacy policy missing Sentry, Datadog (if used), Crontech

- **Location:** `website/app/legal/privacy/page.tsx:450-527`
- **Listed:** Stripe, GitHub, Anthropic, Vercel, Cloudflare, Neon, Email provider.
- **NOT listed:** Sentry (used for error monitoring), Datadog (referenced in `lib/datadog-client.js` — uncertain if active in prod), Crontech (sibling service per `.env.example:55-58`).
- **Recommended action:** Audit the actual prod env vars; add every truly-used sub-processor before launch.

### 4. HIGH — No cookie consent banner

- **Location:** `website/app/layout.tsx` — no banner component imported. Privacy policy says "currently strictly necessary only" at `:21` (a draft comment).
- **Why this matters:** Sentry's session-replay (10% of sessions) writes a Sentry session ID to the user's browser. That's not strictly necessary — it's analytics/debugging. Under EU/UK ePrivacy this requires prior consent for non-essential cookies.
- **Recommended action:** Either gate Sentry session replay behind a consent banner OR exclude EU/UK traffic from session replay OR add a consent banner with granular toggles before EU launch.

### 5. MEDIUM — Audit log resourceId stores cleartext "owner/repo" with 7-year retention

- **Location:** `website/app/api/scan/run/route.ts:433, 450` — `resourceId: \`${owner}/${repo}\``.
- **Impact:** A customer who closes their account or deletes their data has their repo coordinate sitting in an immutable hash-chained log for 7 years.
- **Recommended action:** Consider hashing `resourceId` for repo identifiers (the audit log only needs uniqueness, not legibility). At minimum, document in the privacy policy that the audit log retains scan event references for 7 years.

### 6. MEDIUM — `scan_queue`, `scan_history`, `scans` tables have no retention policy

- **Location:** `website/app/lib/scan-queue-store.js`, `scan-history-store.js`, `schema.sql:1-25`.
- **Impact:** GDPR right-to-erasure requires we have a deletion path. None of these tables has an age-based purge.
- **Recommended action:** Add a cron-driven purge for `scan_queue` (rows older than, say, 30 days) and add a per-customer-id delete RPC for `customers` / `scans` / `installations`.

### 7. MEDIUM — `cli-engine-runner.js` warns on path-traversal but doesn't audit-log it

- **Location:** `website/app/lib/cli-engine-runner.js:62` — `console.warn(\`[cli-engine-runner] dropped unsafe path: ${relPath}\`)`.
- **Impact:** A malicious repo can attempt path-escape (e.g. `../../etc/passwd` as a file path). We safely drop the file but the customer-controlled string ends up in our logs (low PII, but the attack-surface signal is silently lost).
- **Recommended action:** Promote to an audit-log event (`action: scan.unsafe-path`) for security visibility.

### 8. MEDIUM — Anthropic prompt body could be captured in Sentry on error

- **Location:** `website/app/api/scan/fix/route.ts:421-449` `anthropicCall` — `body` is a local that contains the full prompt JSON. If the `await fetch(…)` rejects or `controller.abort()` fires, Sentry will capture the body via `includeLocalVariables`.
- **Impact:** Customer source code in Sentry error traces.
- **Recommended action:** Same as Red Flag #1 — add a `beforeSend` filter that scrubs locals named `body`, `prompt`, `fileContent`, `messages`.

---

## GDPR / CCPA compliance gaps

1. **No cookie consent banner.** EU/UK ePrivacy requires consent for non-strictly-necessary cookies. Sentry Replay (10% of sessions) is non-strictly-necessary.
2. **Sentry not in sub-processor list.** GDPR Art. 28 requires a documented sub-processor list with the DPA basis. Sentry is currently a silent sub-processor.
3. **No automated deletion paths for `scans`, `scan_queue`, `scan_history`.** GDPR Art. 17 (right to erasure) needs a defined SLA. Currently we have manual-only.
4. **Audit log retention is documented but never enforced.** `purgeExpired()` exists but is not called by any cron / route — rows older than 7 years would linger.
5. **Privacy policy is marked `[DRAFT — requires attorney review]` in multiple sections** (visible at `website/app/legal/privacy/page.tsx:13-31, 280, 343, 401, 436-442`). Launching with a draft policy is itself a compliance gap.

---

## Recommended actions

Ranked by launch-blocker risk:

1. **Before launch — required:**
   - Sentry sub-processor disclosure added to privacy policy. (15 min)
   - `beforeSend` filter on Sentry server config that scrubs locals named `body`, `prompt`, `fileContent`, `messages`, `issues` and any local > 4KB. (30 min)
   - `HomeFaq.tsx` "Repo never leaves CI" answer rewritten to clarify the CI-gate path vs paid scan path. (10 min)
   - `HomeFaq.tsx` "Is my code stored anywhere?" answer noted that fix recipes may persist anonymised snippets. (10 min)
   - Resolve `[DRAFT]` markers in privacy policy (attorney review).
   - Cookie-consent banner OR exclude EU/UK from session replay OR set `replaysSessionSampleRate: 0`. (30 min for the latter)

2. **Within 30 days of launch:**
   - Add a hash-and-template normalisation to `fix_recipes.before_snippet` / `after_snippet` so customer identifiers don't bleed cross-customer.
   - Add a retention-purge cron for `scan_queue`, `scan_history`, `scans` (per Bible "data not needed = data deleted").
   - Hash `audit_log.resource_id` for repo identifiers OR document the 7-year retention explicitly.
   - Implement a per-customer DELETE RPC for the cleartext-PII tables (`customers`, `scans`, `installations`, `watches`).

3. **Within 90 days (nice-to-have):**
   - Add a `[GateTest] customer-data-removed` audit event when a customer requests deletion.
   - Move `fixes_log` and `fix_registry` schemas to the audit list above — both were skipped in this read.
   - Investigate Anthropic's enterprise zero-data-retention option once revenue justifies the cost.

---

## Closing posture

GateTest's underlying flow is honest. Stripe manual capture works. HMAC fail-closed everywhere. Workspace cleanup is real. No tracking cookies. No external CDN scripts. The privacy policy is detailed and lists most sub-processors.

The single biggest exposure is Sentry's server config — `includeLocalVariables: true` + no scrubber + no listing in the sub-processor table. Fix that and the audit trail goes from "honest with one big hole" to "honest, period."

The marketing copy is mostly honest but the "repo never leaves CI" line conflates the two product paths in a way that will not survive a hostile read by a customer's security team.

Pre-launch fixable. Not a blocker if addressed.
