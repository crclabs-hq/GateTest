# Tallrig → GateTest — signed push events

**Audience:** whoever registers our tenant's push-event target on Tallrig.
**Status:** receiver is built and deployed (issue #672). Registration has
not happened yet — the register-and-fire cross-test runs the moment the
target below is registered.

---

## What this is

Tallrig's tenant push-events feature (our tenant `6bd0832e`) POSTs signed
JSON events at a registered HTTPS target whenever something happens on our
side of the platform: a deploy starts or finishes, a background job fails,
or a secret gets rotated. GateTest receives, verifies, and records them so
an operator can see "what did Tallrig last tell us" without SSHing anywhere,
and so `/api/platform-status` can show the sha of our last deploy.

Events: `deploy.started`, `deploy.finished` (carries a `sha`, or `null`,
plus `shaSource`), `job.failed`, `secret.rotated` (name only — never the
secret's value).

Delivery: three retries, then dead-letter. Targets must be `https` on a
public host.

---

## 1. Target URL

```
https://gatetest.io/api/integrations/tallrig/events
```

Route: `website/app/api/integrations/tallrig/events/route.ts`, `POST` only.

---

## 2. Env vars

| Name | Required | Purpose |
|---|---|---|
| `TALLRIG_PUSH_SECRET` | Yes | HMAC key for verifying `X-Tallrig-Signature`. Unset -> the route fails closed with `503`. |
| `TALLRIG_PUSH_KEY_ID` | No | If set, the route rejects any request whose `X-Tallrig-Key-Id` header doesn't match it, with `401`. Leave unset to accept any key id (still requires a valid signature). |

Both come from the registration call below — Tallrig hands back a key id
and the secret **once**, at registration time. There is no way to retrieve
the secret again later; if it's lost, re-register to get a new one and
rotate `TALLRIG_PUSH_SECRET` at the same time.

---

## 3. Registering the target

Registration is a **tRPC call on the Tallrig tenant**, `pushEvents.register`,
run by whoever holds the tenant token (not something GateTest calls itself —
GateTest is the receiver, not the registrant):

```
tenant.pushEvents.register({
  url: "https://gatetest.io/api/integrations/tallrig/events",
})
```

The response carries the key id and the secret (once). Set:

```
TALLRIG_PUSH_SECRET=<secret from the response>
TALLRIG_PUSH_KEY_ID=<key id from the response>
```

on the GateTest deployment, then Tallrig will fire a `deploy.started` /
`deploy.finished` pair at the target as the cross-test.

---

## 4. Wire contract

Headers on every delivery:

| Header | Value |
|---|---|
| `X-Tallrig-Key-Id` | the key id from registration |
| `X-Tallrig-Timestamp` | unix seconds |
| `X-Tallrig-Signature` | `sha256=<hex>` |

Signature: `hex = HMAC-SHA256(TALLRIG_PUSH_SECRET, "${timestamp}.${rawBody}")`
— note the timestamp is bound *into* the signed string, not just carried
alongside it.

Replay window: the timestamp must be within 300 seconds of "now", in either
direction, or the request is rejected with `409`.

| Failure | Status |
|---|---|
| `TALLRIG_PUSH_SECRET` unset | `503` |
| `X-Tallrig-Key-Id` set and mismatched against `TALLRIG_PUSH_KEY_ID` | `401` |
| missing `X-Tallrig-Timestamp` or `X-Tallrig-Signature` | `400` |
| bad signature | `401` |
| timestamp outside the 300s window | `409` |
| malformed JSON body | `400` |
| accepted | `200`, `{ "ok": true, "stored": true|false }` (`stored: false` means this event id — or body hash, if the payload has none — was already recorded; retries are idempotent) |

Verification: `website/app/lib/tallrig-push-signature.js` (`verifyTallrigPush`).
Storage: `website/app/lib/tallrig-push-event-store.js` — a capped (500
events), deduped, JSON-lines ledger under `website/app/data/`.

---

## 5. Display

- `/api/platform-status` includes `lastTallrigDeploy: { sha, shaSource, at }`
  (or `null` if no `deploy.finished` event with a sha has been received yet).
- `/admin/integrations/tallrig` (admin-gated, reads
  `/api/admin/integrations/tallrig`) lists the last 50 events.

---

## 6. Self-test — computing a signature by hand

```bash
SECRET="<your TALLRIG_PUSH_SECRET>"
KEY_ID="<your TALLRIG_PUSH_KEY_ID>"          # omit -H if TALLRIG_PUSH_KEY_ID is unset server-side
BODY='{"id":"evt_test_1","type":"deploy.finished","sha":"'"$(printf 'a%.0s' {1..40})"'","shaSource":"git"}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"

curl -i -X POST "https://gatetest.io/api/integrations/tallrig/events" \
  -H "Content-Type: application/json" \
  -H "X-Tallrig-Key-Id: $KEY_ID" \
  -H "X-Tallrig-Timestamp: $TS" \
  -H "X-Tallrig-Signature: $SIG" \
  -d "$BODY"
```

Expect `200 {"ok":true,"stored":true}` on the first call, and
`{"ok":true,"stored":false}` if you replay the exact same `$BODY` again
(same event id, deduped).
