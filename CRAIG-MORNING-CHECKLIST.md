# Craig's Checklist — 2026-07-30 (domain move)

Written by the session that moved the domain. **The whole code side of
`gatetest.ai` → `gatetest.io` is done, committed and pushed** (`de0027e`, 223
files, 650+ occurrences; tests + build + 120 modules green).

Everything below needs YOUR hands: DNS, registrar, deploys, and external
accounts. Boss Rule #4/#5/#6/#7 — I did not touch any of it.

Full procedure with commands: **`docs/deploy/DOMAIN-FAILOVER-IO.md`**.

---

## 1. Get the site back online (do this first)

`gatetest.ai` is NXDOMAIN (registry redemption since 2026-07-29). The server is
**fine** — it returns HTTP 200 when DNS is bypassed. `gatetest.io` is on the same
Cloudflare account but still points at the retired Vercel project.

- [ ] **Confirm you actually own `gatetest.io`.** Everything below assumes it.
      Registrar is Cloudflare, registered 2026-04-08, expires 2027-04-08. If the
      registrant is not you, stop and redeem `.ai` instead.
- [ ] Cloudflare → `gatetest.io` zone → point `@`, `www`, `mcp` at
      `66.42.121.161`, **grey cloud (DNS only)**. Not orange — Traefik does
      Let's Encrypt on the box and the proxy breaks the HTTP-01 challenge.
- [ ] Delete/overwrite the existing Vercel records, and disconnect `gatetest.io`
      from the Vercel project so two deployments aren't racing.
- [ ] Add the `.io` hostnames to the Traefik routers (exact `sed` in the runbook,
      Step 2 — it ADDS `.io` alongside `.ai` so nothing breaks when `.ai` returns).
- [ ] Rebuild + restart: `cd /opt/gatetest/website && npm run build && systemctl restart gatetest-web`
- [ ] Verify: `curl -sI https://gatetest.io` → 200, and the canonical tag says
      `gatetest.io`.

## 2. Redeem gatetest.ai anyway — this is not optional

- [ ] Redeem it in the Cloudflare registrar dashboard. The window is ~30 days
      from 2026-07-29, then it goes to pendingDelete and becomes publicly
      registrable.
- [ ] **Find out why it happened.** A domain dropping two years before expiry
      means a failed payment or chargeback on that Cloudflare account, not a
      lapse. If you don't fix the cause it recurs.
- [ ] Once redeemed, **301 `.ai` → `.io` permanently. Never retire it.** Badge
      markdown sits in customers' READMEs forever pointing at `.ai`; if someone
      else registers it they control an image URL rendering inside our
      customers' repos.

## 3. The two integrations that fail SILENTLY — change and then TEST

Neither produces an error anyone will see. A customer's push just gets no
status, or a customer pays and no scan starts.

- [ ] **GitHub App settings** → Homepage, Setup URL `/github/setup`,
      Callback URL `/api/github/callback`, Webhook URL `/api/webhook` — all onto
      `gatetest.io`. Then push a commit to a repo with the App installed and
      confirm a commit status appears.
- [ ] **Stripe** → Developers → Webhooks → endpoint URL →
      `https://gatetest.io/api/stripe-webhook`. Then run one test-mode checkout
      (card `4242 4242 4242 4242`) and confirm the scan starts.

## 4. Email — I deliberately did NOT move it

**Every address is still `@gatetest.ai`** (`hello@`, `watchdog@` = the Resend
`From`, bot commit identities). This was a judgement call, not an oversight: an
ESP won't send for a domain it hasn't verified, and that fails *silently* —
rejected or spam-foldered — whereas a wrong URL fails visibly. I couldn't verify
your Resend state, so I left it in a known condition and gated it behind env vars.

- [ ] Resend → add `gatetest.io`, publish the SPF/DKIM records it gives you in
      Cloudflare, wait for **verified**.
- [ ] Set up forwarding for `hello@gatetest.io` (otherwise mail is accepted then
      dropped).
- [ ] Then set `RESEND_FROM='GateTest <watchdog@gatetest.io>'` and
      `GATETEST_SUPPORT_EMAIL=hello@gatetest.io`.
- [ ] `tests/site-url.test.js` asserts the support address is still on `.ai` —
      update that assertion in the same commit so the guard keeps meaning
      something instead of being deleted later as "stale".

## 5. SEO — do this early, it decays

- [ ] Google Search Console: add the `gatetest.io` property, submit the sitemap,
      and file a **Change of Address** from `.ai` (needs `.ai` redeemed and
      301'ing first, so it's gated on item 2).
- [ ] Bing Webmaster + IndexNow: add the site, host the IndexNow key at
      `https://gatetest.io/<key>.txt`. IndexNow rejects any batch whose host
      disagrees with the URLs, so this must match.

## 6. Republish the packages (their metadata + defaults are baked in at publish)

- [ ] `npm publish` — `@gatetest/cli` and `@gatetest/mcp-server`. **Worth
      prioritising:** the MCP server's hosted-API base URL defaulted to the dead
      domain, so paying MCP customers' `scan_url` / `scan_repo` have been
      resolving NXDOMAIN. The fix only reaches them on upgrade.
- [ ] Resubmit `server.json` to the MCP registry.
- [ ] WordPress.org: cut a plugin release (readme + `GATETEST_API_BASE` are
      already updated in-repo).
- [ ] VS Code Marketplace / Open VSX + Homebrew tap: republish (cosmetic —
      `homepage` only).
- [ ] GitHub Marketplace listing: the copy in
      `integrations/marketplace/listing.md` is updated; paste the new URLs in.

## 7. Tallrig dashboard env vars (the platform was renamed from Vapron 2026-09-14)

Now belt-and-braces rather than load-bearing — the code already defaults to
`.io` — but set them, because they're what a rollback would flip.

- [ ] `NEXT_PUBLIC_BASE_URL=https://gatetest.io` and
      `GATETEST_PUBLIC_BASE_URL=https://gatetest.io`
      (`NEXT_PUBLIC_*` is inlined at BUILD time — needs a rebuild, not a restart)
- [ ] Leave `GATETEST_BADGE_ORIGIN` unset — it tracks the base URL on purpose.
- [ ] Still outstanding from before: rename `RESENDER_API_KEY` →
      `RESEND_API_KEY`, add `CRON_SECRET`, `GITHUB_WEBHOOK_SECRET`,
      `TALLRIG_BASE_URL`, `TALLRIG_API_TOKEN`, `TALLRIG_DISPATCH_SECRET`
      (the `VAPRON_*` names are still read as aliases — see `docs/ops/tallrig-cutover.md`).

---

## 8. Product decisions only you can make (added later the same day)

None of these block the site coming back up. They are the things I found while
working and deliberately did **not** decide for you, because each one touches
money, public copy, or a design trade-off. Full detail is in `docs/ROADMAP.md`
under the KI number.

- [ ] **KI #95 — the cross-repo prior-art facade has no caller.**
      `fetchPriorArt()` computes "what fires in similar codebases" and nothing
      asks for it. Three options: wire it into the repo fix route, delete it, or
      accept a dead export. It touches **AI spend on the $399 Forensic tier**
      (an extra DB query plus a bigger prompt per scan), and there is already a
      *second*, live prior-art system (`fix-pattern-recall`) on the fix route —
      so "just wire it up" is a product call about what the model should be
      told, not a mechanical fix. The silent-drop bug underneath it is already
      fixed (`09fe694`).
- [ ] **KI #84 — `try-fix.js` is named on `/how-it-works` but never runs.**
      Predates today. Wire it in, retarget the copy, or delete it. The copy half
      is Boss Rule #8, which is why I left it.
- [ ] **KI #96 — no detector exists for that "shipped but unreachable" class.**
      I tried five approaches, measured each, and shipped only the one that
      worked. Four are recorded as rejected *with the measurement*, so nobody
      repeats them. The remaining work needs real import resolution plus a
      dynamic-registry pass; it is pre-authorized, just not started.
- [ ] **`www.gatetest.io` certificate** is expired at Vercel — it resolves to
      the retired project. Folds into item 1 (disconnect Vercel), but it is a
      visible symptom if anyone hits the `www` host.

## 9. What changed in the code since this file was written

The domain work at the top is unchanged and still correct. Since then, working
the "looks wired but isn't" thread turned up four real defects, all fixed,
tested and pushed:

- A cross-repo intelligence parameter was threaded through three layers of the
  **paid Forensic path** and silently discarded (`09fe694`). The anti-template
  guard that stops the model copying other codebases' findings had also been
  deleted from the source; it is restored.
- **`aiReview` reported "code looks clean" for a review that never ran**
  (`d04bd39`) — an outage, a model refusal and genuinely clean code were
  indistinguishable to the customer, and the indistinguishable outcome was the
  reassuring one. This is the one I would most want you to know about.
- Three JSDoc-documented options were phantoms; two were being passed by live
  callers and thrown away (`f13fa76`).
- `crawl:clean` could assert "Site is clean" off zero fetched pages
  (`67dee6c`). Narrower than it sounds — an unreachable site was already caught
  — but a verdict off zero evidence all the same.

Nothing on this list changed as a result. Repo is green: 6983 fast + 323 heavy
tests, website builds, 121 modules load, and the `.io` domain is verified
**emitting** correctly at runtime across 11 surfaces, not just in source.

---

## Carried over from the 2026-07-13 checklist — status NOT verified by me

I did not re-check these; they may already be done.

- [ ] Wire the live trust badge: `GATETEST_INTERNAL_TOKEN` secret +
      `SELF_SCAN_STATUS_URL` variable on the repo, same token in the server env.
- [ ] Rotate the `vpk_live_...` platform key (Tallrig, then Vapron) that was pasted into a chat
      (it's in transcripts and shell history).
- [ ] Tallrig: add + DNS-verify a sending domain, or no tenant can send email.
- [ ] Pricing wording ruling: the page says Quick/Full are "free via the
      open-source CLI" directly above $29/$99 cards. Both are true (free =
      local CLI, paid = hosted scan + report) but the page never says so.
      Also: the support-chat prompt lists a "$19 WordPress Health Check" tier
      that is not one of the Bible's six — confirm real or remove.
- [ ] Optional: flip the Tallrig repo's CI gate from advisory to hard (Bible Forbidden
      #24 wants CI gates blocking; advisory was your 2026-05-08 call).

---
Delete this file once you've worked through it (`git rm CRAIG-MORNING-CHECKLIST.md`).
