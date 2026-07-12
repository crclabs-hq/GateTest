# Craig's Morning Checklist — 2026-07-13

Written by the overnight session. Everything below needs YOUR hands — it's
Boss-Rule territory (money, DNS, deploys, external accounts) or needs a
login only you have. Full detail of what was done overnight is in the
session summary + `docs/HISTORY.md`.

## 1. Redeploy the website (10 min — HIGHEST VALUE)

The live site at gatetest.ai serves a **stale build**: "118 modules",
"Claude Sonnet 4.6", a broken `npx gatetest` install command, "111-module"
pricing card. All of it is already fixed in `main` — the Coolify box just
hasn't rebuilt.

- [ ] Open Coolify on the box (66.42.121.161:8000) → gatetest app → **Redeploy**
- [ ] Verify: `https://gatetest.ai` hero should say "120 modules" and "Sonnet 5"
- [ ] Verify: `https://gatetest.ai/api/platform-status` should stop saying `"version":"dev"`

(You deferred fixing this hosting path until Vapron ships — one redeploy
doesn't restart that project, it just stops the site lying about the product.)

## 2. Wire the live trust badge (5 min)

CI has been silently skipping the self-scan publish forever — the repo has
no `GATETEST_INTERNAL_TOKEN` secret and no `SELF_SCAN_STATUS_URL` variable.
(The homepage panel no longer shows a dead "STANDBY" box — it now falls back
to a dated measured result — but live is better.)

- [ ] Generate a token: `openssl rand -hex 32`
- [ ] `gh secret set GATETEST_INTERNAL_TOKEN --repo crclabs-hq/gatetest`
- [ ] `gh variable set SELF_SCAN_STATUS_URL --repo crclabs-hq/gatetest --body "https://gatetest.ai/api/internal/self-scan-status"`
- [ ] Set the SAME token as `GATETEST_INTERNAL_TOKEN` in the server env (Coolify app env vars)

## 3. Publish @gatetest/cli 1.59.x to npm (5 min)

npm latest is 1.58.1; the engine is 1.59.0+. Everything shipped overnight
(ignore-file fix, syntax-module fix) only reaches CLI users after a publish.

- [ ] `npm publish` from your logged-in machine (or trigger the release workflow)

## 4. One pricing ruling (2 min of thinking)

The pricing section says "Quick and Full scans are **free** via the
open-source CLI" directly above cards charging **$29/$99** for the same
suites. Both are true (free = local CLI, paid = hosted scan + report), but
the page never explains it and it reads like a bait-and-switch.

- [ ] Decide the framing (suggestion: "Run them free in your own terminal —
      the paid tiers are the hosted scan, shareable report, and support")
      and tell the next session to apply it. Also: the support-chat prompt
      lists a "$19 WordPress Health Check" tier that is NOT in the Bible's
      six tiers — confirm whether it's real or should be removed.

## 5. Vapron side (from the onboarding thread)

- [ ] Rotate the `vpk_live_...` key you pasted into chat (it's in transcripts + shell history)
- [ ] In Vapron: add + DNS-verify a sending domain, or no tenant (including
      yours) can send email. Then the onboarding quickstart needs the
      domain-verification step added — that work lives in the Crontech repo.

## 6. Optional but recommended

- [ ] Flip the Vapron CI gate from advisory to hard once you're happy the
      findings are clean (Bible Forbidden #24 says CI gates must block;
      the advisory mode was your 2026-05-08 call, so it needs your word)
- [ ] Skim the refreshed Hall of Scans (`/scans`) — fresh 2026-07-12 numbers
      from the 120-module engine, honest labels, no fake price tags

---
Delete this file once you've worked through it (`git rm CRAIG-MORNING-CHECKLIST.md`).
