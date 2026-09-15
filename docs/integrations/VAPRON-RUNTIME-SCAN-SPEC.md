# Tallrig ↔ GateTest — runtime browser scan contract

> **Renamed 2026-09-14 — the platform is Tallrig (tallrig.com / api.tallrig.com), formerly Vapron.**
> This file keeps its pre-rename filename so links resolve. The env names below
> are the canonical `TALLRIG_*`; GateTest still reads `VAPRON_*` and `CRONTECH_*`
> as aliases (precedence `TALLRIG_` → `VAPRON_` → `CRONTECH_`), and the JavaScript
> module keeps its `vapron-dispatch.js` filename.

**Audience:** whoever owns the Tallrig platform API.
**Status:** GateTest side is built and deployed. Tallrig side is not implemented yet — `POST /api/platform/api/jobs/web-runtime-scan` currently 404s, which is why this feature has never produced a result in production.

---

## Why this exists

GateTest's hosted `/web` and `/wp` scans run on a serverless-style Node process where Chromium cannot reliably launch. The static and network probes run inline; the **runtime** checks — live JavaScript errors, hydration mismatches, CSP violations, failed network requests — need a real long-running container with Playwright. That's Tallrig's job.

GateTest dispatches a job, Tallrig runs the browser, Tallrig POSTs results back.

Until this exists, GateTest degrades honestly: the customer's report shows `runtime.status: "unavailable"` and a banner saying the browser pass did not run. Nothing breaks — but the `/web` product page advertises "we open your site in a real browser", and that is currently not true on the hosted path.

---

## 1. Shared configuration

Two separate credentials. They are **not** interchangeable.

| Name | Who issues it | Purpose |
|---|---|---|
| `TALLRIG_API_TOKEN` | **Tallrig** issues to GateTest (the `vpk_live_…` key) | Bearer auth on the inbound dispatch |
| `TALLRIG_DISPATCH_SECRET` | **Neither** — a shared secret, generated once, held identically by both sides | HMAC signing in **both** directions |

Generate the shared secret once with `openssl rand -hex 32` and store the same value on both sides. Tallrig does not issue it and GateTest does not issue it.

---

## 2. Inbound — GateTest calls Tallrig

```
POST {TALLRIG_BASE_URL}/api/jobs/web-runtime-scan
```

`TALLRIG_BASE_URL` is currently `https://api.tallrig.com/api/platform`, so the full path is
`https://api.tallrig.com/api/platform/api/jobs/web-runtime-scan`.

### Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer {TALLRIG_API_TOKEN}` |
| `X-GateTest-Signature` | `hex(hmac-sha256(TALLRIG_DISPATCH_SECRET, rawBody))` |
| `X-GateTest-Timestamp` | unix seconds |

### Body

```json
{
  "scanId": "scn_xxx",
  "targetUrl": "https://customer-site.example",
  "suite": "web",
  "callbackUrl": "https://gatetest.io/api/web/scan/runtime-callback",
  "deadlineSec": 60,
  "auth": {
    "headers": { "Cookie": "…" },
    "cookie": "…"
  }
}
```

- `suite` is `"web"` or `"wp"`.
- `deadlineSec` is clamped by GateTest to 10–300.
- **`auth` is optional and omitted entirely when absent.** When present it carries a customer's session so the browser can reach authenticated pages. It rides inside the signed body — never a query parameter, never logged. **Tallrig must apply it same-origin only** (Playwright `context.route` + `addCookies` scoped to the target origin), exactly as GateTest's local crawler does. Leaking a customer's session cookie to a third-party origin loaded by the page would be a serious incident.

### Expected response

| Status | Body | Meaning |
|---|---|---|
| any `2xx` | `{ "jobId": "job-xyz", "queuedAt": "2026-07-29T…" }` | Accepted. GateTest checks `response.ok`, so 200 and 201 are equally fine. **`jobId` must be a string** — a missing or non-string `jobId` is treated as a failed dispatch even on a 2xx. `queuedAt` is optional; GateTest substitutes its own timestamp if absent. |
| `4xx` / `5xx` | `{ "error": "…" }` | Rejected. GateTest logs the status and the first 300 chars of the body, then ships static-only results. |

GateTest's dispatch times out after **5 seconds** and never throws — a slow or dead Tallrig degrades the scan, it does not break it. So returning `201` quickly and doing the browser work asynchronously is the right shape.

---

## 3. Outbound — Tallrig calls GateTest back

```
POST https://gatetest.io/api/web/scan/runtime-callback
```

Send this on **success and failure alike**. A job that dies silently leaves the customer's report showing "runtime checks pending" forever.

### Headers

| Header | Value |
|---|---|
| `X-GateTest-Signature` | `hex(hmac-sha256(TALLRIG_DISPATCH_SECRET, rawBody))` |
| `X-GateTest-Timestamp` | unix seconds |

### Body

```json
{
  "scanId": "scn_xxx",
  "status": "completed",
  "durationMs": 4321,
  "findings": [
    {
      "name": "runtime-errors:page-error",
      "severity": "error",
      "passed": false,
      "message": "Uncaught TypeError: x is not a function at /app.js:42"
    }
  ],
  "error": null
}
```

- `status` must be exactly `"completed"` or `"failed"`.
- `findings` is `[]` when `status` is `"failed"`.
- `error` is only meaningful when `status` is `"failed"`.
- `scanId` must be echoed back exactly as sent — it keys the result onto the right scan row.

### Responses GateTest returns

| Status | Cause |
|---|---|
| `200 { "received": true, "persisted": true, "scanId": "…" }` | Accepted **and stored** |
| `200 { "received": true, "persisted": false, "reason": "scanId not found in queue" }` | Signature was valid, but the `scanId` matched no scan row — **the result was dropped.** See the warning below. |
| `401 Invalid signature` | Missing or wrong `X-GateTest-Signature` |
| `401 Missing or invalid timestamp` | `X-GateTest-Timestamp` absent or unparseable |
| `401 Timestamp outside replay window` | More than **300 seconds** skew — see below |
| `400` | Malformed JSON, missing `scanId`, or a `status` other than the two allowed values |
| `503 Callback verification not configured` | GateTest has no `TALLRIG_DISPATCH_SECRET` set. Not your bug — tell us. |

> **A 200 does not always mean the result was stored.** GateTest deliberately returns 200 with `persisted: false` when the `scanId` matches nothing — retrying would never help, so a non-2xx would just cause a pointless retry loop on your side. **Check the `persisted` field, not just the status code.** If you see `persisted: false` repeatedly, the `scanId` is being altered in transit or the scan expired before the browser finished.

---

## 4. Signature details — the part that usually goes wrong

```js
crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
```

Three things that will silently produce a `401`:

1. **Sign the exact bytes you send.** GateTest reads the raw request body and verifies before parsing. If you serialise, sign, then re-serialise (different key order, different whitespace), the digest will not match.
2. **Hex, lowercase, not base64.** Comparison is constant-time and length-sensitive; a base64 digest fails on length before content.
3. **Clock skew.** The replay window is **±300 seconds**. If Tallrig's container clock drifts, callbacks start failing with `Timestamp outside replay window` and nothing else looks wrong. Worth an NTP check if you see intermittent 401s.

---

## 5. Minimum viable implementation

If you want the smallest thing that makes this real:

1. Accept `POST /api/jobs/web-runtime-scan`, verify the bearer token and the HMAC, return `201 { jobId }` immediately.
2. Queue the job. Open `targetUrl` in Playwright with a 60s cap.
3. Collect: uncaught page errors, console errors, failed network requests, CSP violations.
4. POST the results to `callbackUrl`, signed, whether it succeeded or not.

Steps 1 and 4 alone — even returning zero findings — are enough for GateTest to stop reporting "runtime checks unavailable" and to prove the wiring end to end.

---

## 6. Reference implementation

The GateTest side is the authority for anything ambiguous here:

- `website/app/lib/vapron-dispatch.js` — outbound dispatch, `signBody`, `verifySignature`
- `website/app/api/web/scan/runtime-callback/route.ts` — inbound verification, replay window, body validation
- `tests/vapron-dispatch.test.js` — the contract as executable tests

`signBody` and `verifySignature` are exported and dependency-free. If Tallrig is also Node, importing them directly removes any chance of the two sides disagreeing about the digest.
