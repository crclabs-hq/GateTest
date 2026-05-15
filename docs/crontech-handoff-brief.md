# Crontech-side implementation brief — copy/paste this into the Crontech Claude session

> **Instructions for Craig:** Open a Claude Code session in the Crontech repo, paste everything below (from `## Task` to the end of this file). The Crontech Claude has all the context it needs.

---

## Task

GateTest just shipped its side of a worker-tier integration with Crontech. Crontech is the worker that runs Playwright/Chromium for GateTest's `/api/web/scan` endpoint — GateTest can't launch Chromium on its serverless host. Your job is to implement the Crontech side of the contract.

This is a Craig-owned cross-product integration — Crontech is one of Craig's three products (Crontech, Gluecron, GateTest). The integration proves the three-product stack by having GateTest dogfood Crontech as its compute tier.

---

## The contract you must implement

### 1. Inbound endpoint — receives a job from GateTest

```
POST {CRONTECH_BASE_URL}/api/jobs/web-runtime-scan

Headers:
  Authorization:        Bearer {token-you-issue-to-gatetest}
  X-GateTest-Signature: hex(hmac-sha256(GATETEST_DISPATCH_SECRET, raw_body))
  X-GateTest-Timestamp: <unix-seconds>
  Content-Type:         application/json

Body:
  {
    "scanId":      "scn_xxxxxxxxxxxxxxxxxx",   // 18-hex-char token
    "targetUrl":   "https://customer-site.example",
    "suite":       "web" | "wp",
    "callbackUrl": "https://gatetest.ai/api/web/scan/runtime-callback",
    "deadlineSec": 60
  }

Success response:  201 { "jobId": "crontech-job-...", "queuedAt": "ISO-8601" }
Failure response:  4xx { "error": "..." }
```

**Required behavior:**
- Verify `X-GateTest-Signature` against `GATETEST_DISPATCH_SECRET` BEFORE doing any work (fail-closed — missing/invalid → 401).
- Reject timestamps older than ±5 minutes (replay protection).
- Verify `Authorization` Bearer matches the API token Crontech issued to GateTest.
- Idempotency: a duplicate `scanId` returns 200 with the existing `jobId`.
- Enqueue the job into Crontech's worker pool, return 201 with the job id.

### 2. Worker — runs Playwright, captures runtime events

```
For each queued job, in a Crontech worker container with chromium available:

1. Launch playwright.chromium with { headless: true, timeout: 15000 }
2. Open a new context: { ignoreHTTPSErrors: false, viewport 1280x800, userAgent "GateTest/1.0 (+https://gatetest.ai/bot)" }
3. Attach listeners for:
   - page.on('pageerror')      → "runtime-errors:page-error"   (severity: error)
   - page.on('console')        → "runtime-errors:console-error"/("console-warning"), plus CSP/mixed-content/hydration heuristics
   - page.on('requestfailed')  → "runtime-errors:network"      (severity: error for document/script, warning for asset)
   - page.on('response')       → status >= 400 → "runtime-errors:network"
4. Navigate to body.targetUrl with timeout: body.deadlineSec * 1000, waitUntil: 'networkidle'
5. If navigation throws  → status: "failed", error: err.message
6. If navigation succeeds → collect findings into the callback payload
7. Close the browser
8. POST the result to body.callbackUrl (see section 3)
```

**Heuristic rules (mirror these from GateTest's `src/modules/runtime-errors.js`):**
```js
const CSP_HINT          = /content security policy|csp directive|refused to (?:execute|load|connect|frame)/i;
const MIXED_CONTENT     = /mixed content/i;
const HYDRATION_HINTS   = [
  /hydration mismatch/i,
  /text content does not match/i,
  /hydration failed/i,
  /did not match.*server/i,
  /minified react error/i,
  /uncaught \(in promise\)/i,
  /\[vue warn\]/i,
  /\[nuxt\]/i,
];
```

Console-error text matching `CSP_HINT` also produces a `runtime-errors:csp-violation` finding (in addition to the `console-error`). Same for mixed-content and hydration.

### 3. Outbound callback — POST results back to GateTest

```
POST {body.callbackUrl}          (always https://gatetest.ai/api/web/scan/runtime-callback)

Headers:
  X-GateTest-Signature: hex(hmac-sha256(GATETEST_DISPATCH_SECRET, raw_body))
  X-GateTest-Timestamp: <unix-seconds>
  Content-Type:         application/json

Body (success):
  {
    "scanId":     "<same as inbound>",
    "status":     "completed",
    "durationMs": 4321,
    "findings": [
      { "name": "runtime-errors:page-error",     "severity": "error",   "passed": false, "message": "Uncaught TypeError: foo is not a function" },
      { "name": "runtime-errors:console-error",  "severity": "warning", "passed": false, "message": "console.error during load: ..." },
      { "name": "runtime-errors:network",        "severity": "error",   "passed": false, "message": "GET https://...js → net::ERR_ABORTED (script)" },
      { "name": "runtime-errors:csp-violation",  "severity": "error",   "passed": false, "message": "CSP violation: Refused to execute inline script..." },
      { "name": "runtime-errors:mixed-content",  "severity": "warning", "passed": false, "message": "Mixed content blocked: http://img.example/x.png" },
      { "name": "runtime-errors:hydration",      "severity": "warning", "passed": false, "message": "Possible hydration mismatch: ..." },
      { "name": "runtime-errors:summary",        "severity": "info",    "passed": true,  "message": "runtime checked https://...  → 2 page errors, 5 console errors, 1 network failure, 0 CSP, 0 mixed-content, 0 hydration hints." }
    ]
  }

Body (failure):
  {
    "scanId":     "<same as inbound>",
    "status":     "failed",
    "durationMs": 16000,
    "findings":   [],
    "error":      "Browser navigation timed out after 60s"
  }
```

**Retry policy:** If GateTest's callback returns 5xx, retry up to 3 times with exponential backoff (2s, 4s, 8s). Drop on 4xx (don't retry — GateTest considers it a permanent reject).

**Same secret both directions:** the outbound HMAC uses the SAME `GATETEST_DISPATCH_SECRET` value. Symmetric.

---

## Env vars Crontech needs

| Variable                       | Value                                                         |
| ------------------------------ | ------------------------------------------------------------- |
| `GATETEST_DISPATCH_SECRET`     | Shared HMAC secret. Generate with `openssl rand -hex 32`. Must match `CRONTECH_DISPATCH_SECRET` on the GateTest/Vercel side. |
| `GATETEST_API_TOKEN`           | (Future) GateTest's PAT for any reverse calls Crontech makes  |
| `GATETEST_CALLBACK_TIMEOUT_MS` | Default 10000. How long to wait for the GateTest callback to ack. |

---

## Drop-in HMAC code (Node)

Crontech can use this verbatim — same implementation GateTest uses, so the digests match exactly.

```js
const crypto = require('crypto');

function signBody(body, secret) {
  if (typeof body !== 'string') throw new TypeError('signBody: body must be a string');
  if (typeof secret !== 'string' || !secret) throw new Error('signBody: secret is required');
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function verifySignature(body, providedSignature, secret) {
  if (typeof body !== 'string') return false;
  if (typeof providedSignature !== 'string' || !providedSignature) return false;
  if (typeof secret !== 'string' || !secret) return false;
  const expected = signBody(body, secret);
  if (expected.length !== providedSignature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedSignature));
  } catch {
    return false;
  }
}
```

---

## Playwright capture loop (Node) — port verbatim from GateTest

```js
// Crontech worker script. Receives the job from the inbound dispatcher.
const playwright = require('playwright');

async function runJob(job) {
  const captured = {
    pageErrors: [],
    consoleErrors: [],
    consoleWarnings: [],
    requestFailures: [],
    cspViolations: [],
    mixedContent: [],
    hydration: [],
    deprecations: [],
    navigationFailure: null,
    status: null,
  };

  const browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: false,
    viewport: { width: 1280, height: 800 },
    userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot)',
  });
  const page = await ctx.newPage();

  page.on('pageerror', (err) => {
    captured.pageErrors.push({
      message: err && err.message ? String(err.message) : String(err),
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 5).join('\n') : null,
    });
  });

  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    const CSP_HINT = /content security policy|csp directive|refused to (?:execute|load|connect|frame)/i;
    const MIXED   = /mixed content/i;
    const HYDRATION = [
      /hydration mismatch/i,
      /text content does not match/i,
      /hydration failed/i,
      /did not match.*server/i,
      /minified react error/i,
      /uncaught \(in promise\)/i,
      /\[vue warn\]/i,
      /\[nuxt\]/i,
    ];
    if (type === 'error') {
      captured.consoleErrors.push({ text: text.slice(0, 500) });
      if (CSP_HINT.test(text)) captured.cspViolations.push({ text: text.slice(0, 500) });
      if (MIXED.test(text)) captured.mixedContent.push({ text: text.slice(0, 500) });
      if (HYDRATION.some((re) => re.test(text))) captured.hydration.push({ text: text.slice(0, 500) });
    } else if (type === 'warning') {
      captured.consoleWarnings.push({ text: text.slice(0, 500) });
      if (CSP_HINT.test(text)) captured.cspViolations.push({ text: text.slice(0, 500) });
      if (MIXED.test(text)) captured.mixedContent.push({ text: text.slice(0, 500) });
      if (/deprecated/i.test(text)) captured.deprecations.push({ text: text.slice(0, 500) });
    }
  });

  page.on('requestfailed', (req) => {
    const failure = req.failure();
    captured.requestFailures.push({
      url: req.url().slice(0, 300),
      method: req.method(),
      reason: failure ? failure.errorText : 'unknown',
      resourceType: req.resourceType(),
    });
  });

  page.on('response', (resp) => {
    const status = resp.status();
    const url2 = resp.url();
    if (status >= 400 && url2 !== job.targetUrl) {
      captured.requestFailures.push({
        url: url2.slice(0, 300),
        method: resp.request().method(),
        reason: `HTTP ${status}`,
        resourceType: resp.request().resourceType(),
      });
    }
  });

  try {
    const resp = await page.goto(job.targetUrl, {
      timeout: (job.deadlineSec || 60) * 1000,
      waitUntil: 'networkidle',
    });
    captured.status = resp ? resp.status() : null;
  } catch (err) {
    captured.navigationFailure = err && err.message ? String(err.message) : String(err);
  }

  try { await ctx.close(); } catch { /* ignore */ }
  try { await browser.close(); } catch { /* ignore */ }

  return captured;
}

function capturedToFindings(captured, targetUrl) {
  const findings = [];
  if (captured.navigationFailure) {
    findings.push({
      name: 'runtime-errors:navigation',
      severity: 'error',
      passed: false,
      message: `Page failed to load: ${captured.navigationFailure}`,
    });
    return findings;
  }
  if (captured.status !== null && captured.status >= 400) {
    findings.push({
      name: 'runtime-errors:initial-status',
      severity: 'error',
      passed: false,
      message: `Initial page load returned HTTP ${captured.status}.`,
    });
  }
  for (const e of captured.pageErrors.slice(0, 10)) {
    findings.push({ name: 'runtime-errors:page-error', severity: 'error', passed: false, message: `Uncaught JS error: ${e.message}` });
  }
  for (const e of captured.consoleErrors.slice(0, 10)) {
    findings.push({ name: 'runtime-errors:console-error', severity: 'warning', passed: false, message: `console.error during load: ${e.text}` });
  }
  for (const f of captured.requestFailures.slice(0, 15)) {
    findings.push({
      name: 'runtime-errors:network',
      severity: f.resourceType === 'document' || f.resourceType === 'script' ? 'error' : 'warning',
      passed: false,
      message: `${f.method} ${f.url} → ${f.reason} (${f.resourceType})`,
    });
  }
  for (const v of captured.cspViolations.slice(0, 5)) {
    findings.push({ name: 'runtime-errors:csp-violation', severity: 'error', passed: false, message: `CSP violation: ${v.text}` });
  }
  for (const m of captured.mixedContent.slice(0, 5)) {
    findings.push({ name: 'runtime-errors:mixed-content', severity: 'warning', passed: false, message: `Mixed content blocked: ${m.text}` });
  }
  for (const h of captured.hydration.slice(0, 5)) {
    findings.push({ name: 'runtime-errors:hydration', severity: 'warning', passed: false, message: `Possible hydration mismatch: ${h.text}` });
  }
  for (const d of captured.deprecations.slice(0, 5)) {
    findings.push({ name: 'runtime-errors:deprecation', severity: 'info', passed: false, message: `Browser deprecation: ${d.text}` });
  }
  findings.push({
    name: 'runtime-errors:summary',
    severity: 'info',
    passed: true,
    message:
      `runtime checked ${targetUrl} → ` +
      `${captured.pageErrors.length} page error(s), ` +
      `${captured.consoleErrors.length} console error(s), ` +
      `${captured.requestFailures.length} network failure(s), ` +
      `${captured.cspViolations.length} CSP violation(s), ` +
      `${captured.mixedContent.length} mixed-content event(s), ` +
      `${captured.hydration.length} hydration hint(s).`,
  });
  return findings;
}
```

---

## Deliverables — what Crontech Claude should produce

1. The two endpoints (`/api/jobs/web-runtime-scan` inbound + the outbound callback POST) in whatever framework Crontech uses.
2. A small worker pool that pulls queued jobs, runs the Playwright capture, POSTs the callback.
3. Unit tests for the signature verification + payload shape.
4. Docs on the Crontech side documenting the new env vars and the GateTest integration.
5. A migration path / DB row for queued jobs so retries survive worker restarts.

## What Crontech Claude should NOT do

- Don't store any of the customer's runtime data beyond what's needed to retry the callback. After GateTest acks the callback, drop the local copy.
- Don't expose the runtime payload publicly — it gets POSTed only to the GateTest callback URL.
- Don't add any external API integrations (no third-party analytics, no Sentry, no Datadog) without Craig's authorization.
- Don't change Crontech's pricing / billing model to bill GateTest — that's a Boss Rule item for Craig.

## Status checking (sanity)

After implementation, this is the smoke test that should pass:

```bash
# From the GateTest side, hit /api/web/scan with a real URL
curl -X POST https://gatetest.ai/api/web/scan \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

# Response should include `runtime: { status: "queued", jobId: "...", pollUrl: "..." }`
# Within 30 seconds, polling pollUrl should show `runtime: { status: "completed", payload: { findings: [...] } }`
```

When that round-trips successfully, the integration is wired.

---

## Reference

The contract spec, dispatcher implementation, callback handler, and tests already shipped on the GateTest side in PR #80 (branch `feat/crontech-headless-worker`). Full files:
- `website/app/lib/crontech-dispatch.js`
- `website/app/api/web/scan/runtime-callback/route.ts`
- `website/app/api/web/scan/runtime-status/route.ts`
- `docs/crontech-worker-contract.md`
- `tests/crontech-dispatch.test.js`
