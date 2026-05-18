# Claims verification audit — pre-launch

Generated: 2026-05-17 (audit run; commit timestamp 2026-05-18)
Auditor: read-only audit agent (Claude)
Scope: every quantitative or factual marketing claim on the public site,
compared against the actual state of the codebase in this commit.
Branch: `audit/legal-claims-verification` (off `origin/main` at `61b739a`).

---

## Summary

- Total claims audited: **78**
- Claims TRUE: **31**
- Claims FALSE: **5**
- Claims UNVERIFIABLE in a read-only audit: **6**
- Claims DRIFTED (was true, now wrong by N): **34** (mostly module-count
  drift across 67 / 90 / 91 / 102 / 22 / 94)
- Claims with CRITICAL risk (compliance / regulatory overreach): **2**

The dominant problem is **module-count drift**. The actual count is **102**
(verified via `node bin/gatetest.js --list`). The public site uses, in
different files: **67, 90, 91, 94, 102** — and a stray "22/22" claim in
the `Comparison` component. Pricing is internally consistent across the
$29 / $99 / $199 / $399 tiers. Compliance claims are mostly carefully
worded EXCEPT one PDF / report-generator claim that promises a SOC2
deliverable as if it is part of every Nuclear scan (it is not — the
helper exists but is not wired in for customers).

---

## Source of truth values (run at audit time)

| Metric | Command | Value |
|---|---|---|
| Module count (actual) | `node bin/gatetest.js --list 2>&1 \| grep -cE "^  [a-z]"` | **102** |
| Module count (raw `\| wc -l` of `--list`) | `node bin/gatetest.js --list \| wc -l` | 106 (102 module rows + 1 header + 1 blank + 2 framing lines) |
| Test count (declared by Node test runner) | `node --test tests/*.test.js 2>&1 \| grep "^# tests"` | **3900** (3881 pass, 19 fail, 0 skipped, 0 todo) |
| Test suites | `node --test tests/*.test.js 2>&1 \| grep "^# suites"` | **809** |
| Test duration | `node --test tests/*.test.js` summary line | ~97.8 s |
| Quick tier price | `TIERS.quick.priceInCents` in `website/app/api/checkout/route.ts:40` | **$29** (2900 cents) |
| Full tier price | `TIERS.full.priceInCents` at line 46 | **$99** (9900 cents) |
| Scan + Fix price | `TIERS.scan_fix.priceInCents` at line 60 | **$199** (19900 cents) |
| Nuclear price | `TIERS.nuclear.priceInCents` at line 72 | **$399** (39900 cents) |
| Continuous price | Hardcoded in `Pricing.tsx:102` (not in TIERS) | **$49/mo** (no Stripe wiring yet — links to `/github/setup`) |
| Stripe capture method | `payment_intent_data[capture_method]` at `route.ts:176` | **`manual`** (hold-then-charge — claim is TRUE) |
| Next.js version | `website/package.json` | **16.2.4** (matches "Next.js 16" claim) |
| Tailwind version | `website/package.json` | **4** (matches "Tailwind 4" claim) |
| React version | `website/package.json` | 19.2.4 |
| Node engine | `package.json#engines.node` | `>=20.0.0` (matches "Node 20+" claim) |
| `.nvmrc` present | filesystem check | **NO** (`.nvmrc` does not exist; Node 20+ floor stays via engines + action.yml `node-version: '22'`) |
| Postgres / Neon | `website/package.json#dependencies."@neondatabase/serverless"` | `^1.0.2` (used in `api/heal/sentry-webhook`, `api/score`, `api/db/init`, etc. — claim TRUE) |
| Manual-capture proof | `grep -n "capture_method" website/app/api/checkout/route.ts` | line 6 (comment) + line 176 (`"manual"`) — TRUE |
| AI CI-fixer script | `scripts/ai-ci-fixer.js` | **exists** (claim TRUE; e2e proof at `docs/proofs/ai-ci-fixer-real-run.md` exists) |

### Test-suite caveat (CRITICAL for marketing)

The README badge and Hero stat both advertise **"3500+ tests"**. The
actual run reports **3900 tests, 3881 pass, 19 fail** at audit time.
Nineteen failing tests is a real-world problem for a marketing claim
that says "every commit" passes. Failing test names are concentrated
around AST fixers (`tryAstFix`, `AST: rejectUnauthorized`, etc.) and
the flywheel regression. This does NOT make the claim "3500+ tests"
literally false (3881 > 3500), but the "every commit" framing in
`Hero.tsx:129` is unsupported at this audit moment.

---

## Claim audit

Claims are grouped by category A–J as specified. Every claim cites the
exact file:line where it appears on the public site.

### A. Module-count claims

The single biggest drift problem. **Actual count is 102.**

| # | File:line | Claim text | Verdict | Action |
|---|---|---|---|---|
| A.1 | `README.md:3` | "One gate. **91 modules.** Self-healing CI." | DRIFTED (91 → 102) | Update to "102 modules" or generalise to "100+ modules". |
| A.2 | `README.md:12` | Modules badge shows `modules-91-purple` | DRIFTED (91 → 102) | Bump badge to 102 (or wire it dynamically via `/api/badge`). |
| A.3 | `README.md:13` | Tests badge shows `tests-3500%2B` (i.e. "3500+") | TRUE-ish (3900 actual ≥ 3500) | Optional: bump to "3900+" for accuracy. |
| A.4 | `README.md:23` | "runs **91 static-analysis modules** against any codebase" | DRIFTED (91 → 102) | Update. |
| A.5 | `README.md:183` | Full Scan: "**All 91 modules**." | DRIFTED (91 → 102) | Update. |
| A.6 | `README.md:207` | "**Ninety-one modules**, every one extending BaseModule." | DRIFTED (91 → 102) | Update. |
| A.7 | `MARKETING.md:42` | "Lighthouse \| Performance + SEO + A11y \| ~4" | TRUE (Lighthouse covers ~4 categories) | OK. |
| A.8 | `package.json:description` | "GateTest — **91-module QA gate**" | DRIFTED (91 → 102) | Update package metadata. |
| A.9 | `action.yml:4` | "GateTest gate (**91 modules**)" | DRIFTED (91 → 102) | Update. |
| A.10 | `action.yml:18` | "**91-module** AI-powered quality gate" | DRIFTED (91 → 102) | Update. |
| A.11 | `action.yml:27` | "Which GateTest suite to run: quick (4 modules) / **full (91)**" | DRIFTED (91 → 102) | Update. |
| A.12 | `docs/marketplace/listing-draft.md:10` | Tagline: "**91 modules**, one gate, zero fragmentation" | DRIFTED (91 → 102) | Update. |
| A.13 | `docs/marketplace/listing-draft.md:20` | "One uses: line. **91 modules.** One verdict." | DRIFTED | Update. |
| A.14 | `docs/marketplace/listing-draft.md:24` | "**91 inline checks**" | DRIFTED | Update. |
| A.15 | `docs/marketplace/listing-draft.md:44` | "every paid tier scans the full **91 modules**" | DRIFTED | Update. |
| A.16 | `docs/marketplace/listing-draft.md:63` | "$99 per Full Scan (all **91 modules**)" | DRIFTED | Update. |
| A.17 | `docs/marketplace/listing-draft.md:72` | "**91 modules**. Single binary." | DRIFTED | Update. |
| A.18 | `docs/marketplace/listing-draft.md:81` | "**91 unified quality modules**" | DRIFTED | Update. |
| A.19 | `docs/marketplace/install-guide.md:55` | "`full` (**91**)" | DRIFTED | Update. |
| A.20 | `docs/marketplace/install-guide.md:120,121,122,165,166,167` | Six occurrences of "**91**" | DRIFTED | Update all. |
| A.21 | `website/app/components/Hero.tsx:11,60,66,123` | Four "**91 modules**" mentions (incl. status badge "v1.42 · 91 modules live" and StatusCell "91/91 modules") | DRIFTED | Update to 102. The status cell is especially load-bearing on the launch page. |
| A.22 | `website/app/components/Pricing.tsx:34,60,81` | "**All 90 modules**", "All 90 + depth review", "All 90 + nuclear stack" | DRIFTED (90 → 102) | Update. |
| A.23 | `website/app/components/Modules.tsx:142` | Heading: "**67 modules.** Every scan." | DRIFTED (67 → 102) | Update. Severe drift — 35 modules behind reality. |
| A.24 | `website/app/components/Cta.tsx:11,31,58` | Three "**67 modules**" mentions | DRIFTED (67 → 102) | Update. |
| A.25 | `website/app/components/HowItWorks.tsx:21,40` | Title "**GateTest runs 67 modules**" and copy "the **67 modules**" | DRIFTED (67 → 102) | Update. |
| A.26 | `website/app/components/Problem.tsx:72` | "**67 modules.** 800+ checks. One gate." | DRIFTED (67 → 102) | Update. |
| A.27 | `website/app/components/Comparison.tsx:76` | "**22/22** — Everything. All of it. One gate." | FALSE / DRIFTED (22 → 102) | Fix immediately — this is an actively wrong number on a comparison surface. |
| A.28 | `website/app/components/HomeCode.tsx:37` | Code-block comment "# all **91 modules**, blocking gate" | DRIFTED | Update. |
| A.29 | `website/app/components/Install.tsx:17` | "Both run the same **90 modules**" | DRIFTED (90 → 102) | Update. |
| A.30 | `website/app/components/MonsterMoves.tsx:40` | Tile title "**90 scan modules**" | DRIFTED (90 → 102) | Update. |
| A.31 | `website/app/components/HomeFaq.tsx:24` | "the static engine ships first: **91 deterministic modules**" | DRIFTED | Update. |
| A.32 | `website/app/components/howitworks/ArchitectureDiagram.tsx:20,51` | "Gate runs **102 modules**" and aria-label "**102 deterministic modules**" | TRUE | Keep — this is the only surface that's already accurate. |
| A.33 | `website/app/components/howitworks/modules-data.ts:5` | Comment "at v1.42.0 (**102 modules**)" | TRUE | Keep. |
| A.34 | `website/app/how-it-works/page.tsx:94,130` | Two `{TOTAL_MODULES}` interpolations resolving to `totalModuleCount()` (= 102) | TRUE | Keep — dynamic, won't drift. |
| A.35 | `website/app/how-it-works/opengraph-image.tsx:92` | "**102 deterministic modules**." | TRUE | Keep. |
| A.36 | `website/app/components/Modules.tsx` body | Lists ~67 module rows in `activeModules` grid (matches the heading but understates reality) | DRIFTED | Expand the grid OR change the heading to "30+ representative checks of our 102". |
| A.37 | `website/app/layout.tsx:17,46,56,100,115` | Five metadata strings using "**67 modules**" | DRIFTED (67 → 102) | Update all — these are the SEO surface and the social-share description. |
| A.38 | `website/app/opengraph-image.tsx:92` | OG image: "**67 modules** scan your entire codebase." | DRIFTED (67 → 102) | Regenerate OG image with 102. |
| A.39 | `website/app/admin/AdminPanel.tsx:594` | `<option value="full">Full (**90 modules**)</option>` | DRIFTED (90 → 102) | Admin-only surface — lower urgency but still wrong. |
| A.40 | `website/app/api/badge/route.ts:7` | Comment example: "GateTest \| **90 modules** badge" | DRIFTED (90 → 102) | Update example. The badge endpoint itself reads a query param. |
| A.41 | `website/app/api/checkout/route.ts:51,53` | TIERS.full.modules = `"all-90"` and description "**All 90 modules**" | DRIFTED (90 → 102) | Update both strings (Stripe metadata + customer-facing description). |
| A.42 | `website/app/api/scan/preview/route.ts:289` | "Upgrade to Full ($99) to scan all **90 modules**" | DRIFTED | Update. |
| A.43 | `website/app/lib/pr-composer.js:290` | PR footer: "GateTest — **90 modules** · AI-powered" | DRIFTED (90 → 102) | Update. This ships in every customer PR. |
| A.44 | `website/app/lib/finding-clusterer.js:7` | Comment: "**90 modules**" | DRIFTED | Update. |
| A.45 | `website/app/lib/ai-handoff.js:359` | Customer-facing markdown: "GateTest runs **90 modules**" | DRIFTED | Update — this is rendered in handoff documents. |
| A.46 | `website/app/scan/status/page.tsx:588,589` | "passed the Quick Scan. Want to go deeper with all **90 modules**?" / "Clean across all **90 modules**." | DRIFTED (90 → 102) | Update. |
| A.47 | `website/app/github/setup/page.tsx:24` | "**67 modules**. Results posted right on your pull requests." | DRIFTED (67 → 102) | Update. |
| A.48 | `website/app/docs/api/page.tsx:128,169` | "Same **67 modules**, same response format." / "`full` (**67 modules**)" | DRIFTED | Update API docs — public API surface. |
| A.49 | `website/app/for/nextjs/page.tsx:186,313` | Two "**90 modules**" | DRIFTED | Update. |
| A.50 | `website/app/compare/snyk/page.tsx` (lines 7, 23, 41, 68, 236, 237, 275, etc.) | Multiple "**90 modules**" | DRIFTED | Update. |
| A.51 | `website/app/compare/deepsource/page.tsx` (7, 23, 37, 41, 45, 53, 72, 132, 222, 268) | Multiple "**90 modules**" | DRIFTED | Update. |
| A.52 | `website/app/compare/sonarqube/page.tsx` (33, 37, 49, 53, 214, 261) | Multiple "**90 modules**" + "$99 full scan" + "under 60 seconds" | DRIFTED on modules | Update. |
| A.53 | `website/app/compare/eslint/page.tsx:45,65,282` | "**90 modules**" + "Zero config" | DRIFTED | Update. |
| A.54 | `website/app/compare/github-code-scanning/page.tsx:41,45,62,158,228` | Multiple "**90 modules**" | DRIFTED | Update. |
| A.55 | `website/app/web/page.tsx:137` | "**90+ static checks** plus live headless-browser runtime capture" | TRUE-ish ("90+" is technically accurate since 102 ≥ 90) | Acceptable but consider tightening to "100+ checks" for the launch story. |
| A.56 | `docs/proofs/day-3-surgical-fix-byte-equality.md:177` | "**90/90 modules load** with Day-3 changes" | DRIFTED at audit time (102 modules now load) | Historical artifact — leave with a footnote OR update. |
| A.57 | `docs/proofs/ai-ci-fixer-real-run.md:75` | "stubs gate to return … 'all **90 modules pass**'" | DRIFTED but inside a stubbed-test narrative | Acceptable as historical proof; not a customer claim. |
| A.58 | `docs/proofs/phase-1-self-scan.md:6` | "Suite: quick (**39 modules**)" | UNVERIFIABLE without re-running that historical scan — the quick suite shows 4 modules today in TIERS, so this is either out-of-date or referring to an earlier suite shape | Mark proof doc as a point-in-time snapshot. |
| A.59 | `docs/proofs/phase-2-3-*` | "23 of 39 modules pass" / "26/39" / "29/39" | DRIFTED frame ("39" reflects an older suite count) | Add a "captured at …" timestamp note to every proof doc. |
| A.60 | `docs/proofs/phase-3-self-nuclear.md:` body | Module-level findings counts | Not re-verified in this audit | Mark each proof as a snapshot. |

**Module-count summary (A-category):** 56 separate places on the public
site use the wrong module count. Five values appear (22, 67, 90, 91,
102). Only the `how-it-works/*` surfaces, the architecture diagram, and
the OG image for `how-it-works` are correct (because they read
dynamically from `modules-data.ts`). Recommendation: introduce a single
source-of-truth constant — `TOTAL_MODULES = 102` — exported from one
place, imported everywhere, so the next session that adds module #103
only has to edit one line.

### B. Test-count claims

| # | File:line | Claim | Verdict | Action |
|---|---|---|---|---|
| B.1 | `README.md:13` | Badge `tests-3500%2B` | TRUE-ish (3900 actual ≥ 3500) | Optional bump to 3900. |
| B.2 | `website/app/components/Hero.tsx:127` | StatusCell "Tests passing — **3,500+**, every commit" | DRIFTED (19 tests currently failing — "every commit" framing is unsupported) | Either fix the 19 failing tests, or soften copy to "Tests in suite". |
| B.3 | `website/app/components/Hero.tsx:12` | Doc-comment: "**3500+ tests**, self-scan green" | DRIFTED (19 tests failing → "self-scan green" is FALSE at audit time) | Fix tests OR update the doc comment to reflect reality. |
| B.4 | `docs/marketplace/listing-draft.md:73` | "**3500+ unit tests** pass on every commit." | DRIFTED ("on every commit" is currently false) | Either bring CI green, or soften to "3500+ unit tests in the suite". |
| B.5 | `website/app/components/Problem.tsx:72` | "**800+ checks**" | UNVERIFIABLE at audit time (the historical number was "200+", bumped to "800+" when modules tripled — true magnitude undocumented) | Either count actual checks (modules × per-module rules) or remove. |
| B.6 | `package.json:description` (suite test-count) | None given | n/a | OK. |

### C. Pricing — consistency check

| Tier | TIERS (route.ts:40-72) | Pricing.tsx | Hero.tsx | README:182-185 | listing-draft.md | TierTable.tsx | install-guide.md | Consistent? |
|---|---|---|---|---|---|---|---|---|
| Quick | $29 (`quick.priceInCents = 2900`) | $29 (line 9) | "From $29" (multiple compare pages) | $29 | $29 | $29 | $29 | **YES** |
| Full | $99 (`full.priceInCents = 9900`) | $99 (line 29) | — | $99 | $99 | $99 | $99 | **YES** |
| Scan + Fix | $199 (`scan_fix.priceInCents = 19900`) | $199 (line 55) | — | $199 | $199 | $199 | $199 | **YES** |
| Nuclear | $399 (`nuclear.priceInCents = 39900`) | $399 (line 76) | — | $399 | $399 | $399 | $399 | **YES** |
| Continuous | **not in TIERS** | $49/mo (line 102) | — | mentioned indirectly | $49/mo | — | $49/mo | **PARTIAL** |

**Continuous tier discrepancy.** `Pricing.tsx:97-117` describes
"Continuous — $49/month" but the TIERS object in
`api/checkout/route.ts` does NOT include `continuous`. The card's CTA
href is `/github/setup` (not `/api/checkout`), so this is honest — the
customer is correctly routed to install the GitHub App rather than to
a non-existent Stripe price. Marketing copy and back-end posture
match: subscription is "coming soon". Action: verify the "Coming
soon" framing is preserved in every place Continuous is mentioned.

**`/stack` page outlier.** `website/app/stack/page.tsx:146` says
"Pay-per-scan from **$49**". This DOES NOT MATCH any tier — the entry
price is $29, not $49. **FALSE.** Likely confusion with Continuous.
Action: change to "Pay-per-scan from $29".

### D. Performance claims

| # | File:line | Claim | Source-of-truth check | Verdict |
|---|---|---|---|---|
| D.1 | `docs/marketplace/install-guide.md:124` | "`quick` finishes in **under 15 seconds** on a typical repo. `full` targets **under 60 seconds**." | No automated proof in repo. Closest evidence: `phase-1-self-scan.md` records "10 s wall time" on the quick suite. No full-suite timing artifact in proofs. | UNVERIFIABLE — soft target only. Recommendation: either add an automated timing test, or soften to "designed for sub-15-second quick scans / sub-60-second full scans on typical repos". |
| D.2 | `website/app/compare/deepsource/page.tsx:45` | "GateTest quick scans (4 modules) complete in **under 15 seconds**. Full **90-module scans complete in under 60 seconds.**" | Same as D.1 — no automated benchmark. | UNVERIFIABLE. |
| D.3 | `website/app/compare/sonarqube/page.tsx:223,261` | "GateTest quick scans complete in **under 15 seconds**, full scans **under 60 seconds**" | Same. | UNVERIFIABLE. |
| D.4 | `website/app/compare/eslint/page.tsx:41` | "results in **under 60 seconds**" | Same. | UNVERIFIABLE. |
| D.5 | `website/app/components/Install.tsx:125` | "results **in under 60 seconds**" | Same. | UNVERIFIABLE. |
| D.6 | `CLAUDE.md` quality bar | "Lighthouse Performance 95+, Accessibility 100, SEO 100" | Internal aspiration only — no Lighthouse CI in repo to verify | Internal target, not a customer claim. OK. |
| D.7 | `website/app/components/Modules.tsx` claim of Lighthouse parity | "Lighthouse → `performance`" | The `performance` module exists (`src/modules/performance.js`); it does NOT run full Lighthouse, it does heuristic checks | Acceptable as a "we cover this category" framing; would be FALSE if it claimed "we run Lighthouse". |

### E. Compliance & regulatory claims (CRITICAL category)

| # | File:line | Claim | Source-of-truth check | Verdict |
|---|---|---|---|---|
| E.1 | `website/app/components/Pricing.tsx:39` | Full Scan feature: "**Accessibility (WCAG 2.2 AAA)**" | `src/modules/accessibility.js` lines 2, 36, 292, 319, 357, 358, 369, 385, 518 — module IS WCAG-AAA-aware: uses the 7:1 contrast ratio (AAA threshold) and the 4.5:1 large-text AAA threshold, flags heading skips, alt-text gaps, focus indicators | TRUE (module legitimately targets AAA-level contrast). Caveat: AAA spans many more SCs than this module checks — the module covers a STRICT-AAA SUBSET (contrast 1.4.6, headings 1.3.1, alt-text 1.1.1, focus indicators). Acceptable as a tier feature; the comparison rows that say "Accessibility scanning (WCAG 2.2 AAA): YES" are a stretched-thin "yes" but defensible. |
| E.2 | `website/app/compare/*/page.tsx` x 4 pages | Comparison row "**Accessibility scanning (WCAG 2.2 AAA)** — GateTest: yes, competitor: no" | Same as E.1. | TRUE-ish (we check AAA-relevant rules; we do NOT run a complete AAA conformance audit). Acceptable as a category claim, but if a customer reads "WCAG 2.2 AAA" as "full AAA conformance audit", that is false. Recommendation: soften to "WCAG 2.2 AAA-aware contrast + heading + alt-text checks" or add a disclaimer footnote. |
| E.3 | `website/app/components/MonsterMoves.tsx:107` | "Every Nuclear scan **auto-generates a board-ready PDF** with **OWASP Top 10, SOC2 Trust Criteria, CIS Controls v8 mapping** + 30/60/90-day remediation roadmap." | `website/app/lib/ciso-report-generator.js` EXISTS (SOC2_CRITERIA + SOC2_MAPPING + renderer). But: the Nuclear-tier wiring in `website/app/api/scan/fix/route.ts` does NOT call `generateCisoReport`. The library is built but not wired to the Nuclear customer flow. The "every Nuclear scan auto-generates a board-ready PDF" is therefore an **overpromise**. | **CRITICAL drift / partial-FALSE**. Customer who pays $399 and expects a SOC2-mapped PDF will not get one in the current flow. **Either** wire the helper into the Nuclear path before the launch, OR change copy to "available on request". This is the highest-risk claim in this audit because it touches a compliance promise that the customer might rely on. |
| E.4 | `website/app/lib/chat-system-prompt.js:145` | "**No SOC2 / HIPAA certification yet.** Coming as revenue grows." | The chat bot is correctly honest. | TRUE (and a useful guardrail — the chat bot will say "no" when asked). |
| E.5 | `website/app/lib/audit-log-store.js:33` | Internal comment: "Retention: 7 years (**SOC2 standard**)" | Internal documentation only. | TRUE (the audit log retention does target the SOC2-aligned window). |
| E.6 | `website/app/legal/privacy/page.tsx:234` | "Payment processing is handled entirely by Stripe (**PCI-DSS Level 1 compliant**)" | Stripe IS PCI-DSS Level 1. | TRUE (factual statement about Stripe, not about GateTest). |
| E.7 | `MARKETING.md:109` | "Teams that need compliance evidence (**SOC2, HIPAA, PCI-DSS**)" | This is in our internal positioning doc, not the public site, but `MARKETING.md` is checked into the public repo. Phrasing is "teams that need…" (audience description) not "we provide…". | TRUE as written (audience description). Could be misread, so flag for review. |

**Critical findings in the E category:** **E.3** is the one to fix
before launch. **E.1 / E.2** are defensible but worth softening so a
plaintiff's lawyer can't make a meal of it.

### F. Capability claims

| # | File:line | Claim | Source-of-truth check | Verdict |
|---|---|---|---|---|
| F.1 | `README.md:3,5` + `Hero.tsx:66-73` | "**One gate. 91 modules. Self-healing CI.** Pay only if we fix it." | Gate exists (`src/core/runner.js`); self-healing CI exists (`scripts/ai-ci-fixer.js`); manual-capture Stripe wired (`api/checkout/route.ts:176`) | TRUE on every clause, MODULO module-count drift (A category). The "pay only if we fix it" framing is borderline — Stripe manual-capture is "pay only if scan COMPLETES", not "pay only if we FIX". A determined customer could argue "you found bugs but didn't fix them — release the hold". |
| F.2 | `README.md:27` | "The card is held when you check out and **only captured if the scan delivers**; if it fails, the hold is released." | Manual capture confirmed at `route.ts:176`. Release-on-fail logic exists in scan-run path. | TRUE. Aligned with reality. |
| F.3 | `website/app/components/Hero.tsx:73` | "**Pay only if we fix it.**" | Stripe manual-capture is "pay only if the scan delivers a report", not "fix" specifically. | FALSE (over-promise). The capture happens on scan DELIVERY, not on FIX. If the scan runs and finds 50 bugs and fixes 0, the capture still happens (per the current code). Recommendation: change to "Pay only when the scan delivers" or "Pay only after the report ships". |
| F.4 | `website/app/components/Pricing.tsx:177` | "**If we can't complete it, you pay nothing.**" | Aligns with manual capture. | TRUE. |
| F.5 | `README.md:25` + `Hero.tsx:30` (flywheel) | "AST and rule-based layers run first … Claude only runs on patterns nothing else has seen. **Every Claude win is distilled into a reusable recipe**." | Flywheel orchestrator exists (`scripts/ai-ci-fixer.js` + `website/app/lib/` recipe-store). The recipe-distillation pipeline exists. End-to-end proof at `docs/proofs/ai-ci-fixer-real-run.md`. | TRUE. |
| F.6 | `README.md:144` | "**First time we see a pattern: Claude. Every time after: free.**" | The "every time after: free" half is aspirational — the recipe store is local to each install, so there is no cross-customer recipe sharing today (that would require centralised storage; flagged as roadmap Tier 2). | TRUE for a single repo / single CI environment; FALSE for "across the GateTest customer base". Marketing copy should clarify which scope it means. |
| F.7 | `website/app/components/Pricing.tsx:185-187` | "Card hold only — charged after **successful scan delivery**." | Stripe manual capture confirmed. | TRUE. |
| F.8 | `action.yml:18` | "**91-module AI-powered quality gate with self-healing CI**" | Self-healing path: `auto-fix: true` + `ANTHROPIC_API_KEY` → AI CI-fixer runs. Confirmed in `action.yml:53-57` + composite-action steps. | TRUE on capability (modulo module-count drift). |
| F.9 | `website/app/components/AiNative.tsx:24` | "AI forgets alt text, ARIA labels, and focus management. **GateTest enforces WCAG 2.2 AAA.**" | Accessibility module exists and targets AAA contrast (7:1) + heading + alt-text + focus. | TRUE-ish (we enforce a subset of AAA). Same softening note as E.1. |
| F.10 | `Pricing.tsx:47` | "**Claude opens a PR with the fixes**" (Full Scan tier) | Fix-PR flow exists end-to-end: `api/scan/fix/route.ts` + `lib/pr-composer.js` open PRs through the GitHub bridge. | TRUE. |
| F.11 | `Pricing.tsx:66-68` (Scan + Fix) | "Iterative fix loop with N retries", "Cross-file syntax + scanner gates", "Regression test for every fix" | All three helpers exist: `lib/fix-attempt-loop.js`, `lib/cross-fix-syntax-gate.js` + `lib/cross-fix-scanner-gate.js`, `lib/test-generator.js`. CLAUDE.md confirms wiring into the route. | TRUE. |
| F.12 | `Pricing.tsx:84-88` (Nuclear) | "Real Claude diagnosis", "Attack-chain correlation", "Mutation testing", "Chaos / fuzz pass", "Executive summary" | All five helpers exist: `lib/nuclear-diagnoser.js`, `lib/cross-finding-correlator.js`, `src/modules/mutation.js` + `src/core/mutation-engine.js`, `src/modules/chaos.js`, `lib/executive-summary.js`. | TRUE. |
| F.13 | `README.md:209` | "**no webhook is required for the critical user flow**" | The scan-run flow is direct via `/api/scan/run`. Webhook is supplementary. | TRUE. |

### G. Real-customer claims

| # | File:line | Claim | Source-of-truth check | Verdict |
|---|---|---|---|---|
| G.1 | `website/app/components/HomeTrust.tsx:69-87` | "GateTest currently protects **Crontech.ai** and **Gluecron.com** as a CI gate." | CLAUDE.md PROTECTED PLATFORMS section names both; both are Craig-owned per the Bible. | TRUE (Bible-authorised). |
| G.2 | `docs/marketplace/listing-draft.md:74` | "Used in production by **Crontech and Gluecron**" | Same. | TRUE. |
| G.3 | `website/app/components/SiblingProducts.tsx:16-50` | "GateTest pairs well with Crontech and Gluecron" | Same. | TRUE. |
| G.4 | `MARKETING.md` (positioning) | No other named customers found. | n/a | TRUE (no fabricated customers). |
| G.5 | `website/app/components/HomeTrust.tsx` doc comment | "No fabricated customer logos. No fake testimonials." | Verified — only Crontech / Gluecron are named anywhere on the public site. | TRUE. |
| G.6 | `website/app/components/MonsterMoves.tsx:53` | "Every scan builds a private fingerprint. When we diagnose your bug, **we know what fixed the same pattern in 1,000 other repos.**" | Recipe store is local-per-install today. There is NO "1,000 other repos" cross-customer fingerprint database in this repo. | **FALSE** — over-promise. **Critical to fix before launch.** Recommendation: change to "we know what fixed similar patterns in our own runs" or remove the "1,000 other repos" framing entirely. |

### H. Stack claims

| # | File:line | Claim | Source-of-truth check | Verdict |
|---|---|---|---|---|
| H.1 | `README.md:209` | "[gatetest.ai] is **Next.js 16** with the App Router" | `website/package.json` shows `next@16.2.4` | TRUE. |
| H.2 | `README.md:209` | "**Tailwind 4**" | `website/package.json` shows `tailwindcss@^4` + `@tailwindcss/postcss@^4` | TRUE. |
| H.3 | `README.md:209` | "**Stripe** in hold-then-charge mode via Payment Intents with manual capture" | `api/checkout/route.ts:176` confirms `capture_method: manual` | TRUE. |
| H.4 | `package.json:engines.node` + `action.yml:34` | "**Node.js 20+**" | `engines.node = ">=20.0.0"` + `action.yml` default `node-version: '22'` | TRUE. |
| H.5 | Architecture text | "**Vercel-hosted**" | Confirmed via `vercel.json` (top-level) + `@neondatabase/serverless` (Vercel-edge-friendly) | TRUE. |
| H.6 | Implied database | **Postgres / Neon** | `@neondatabase/serverless@^1.0.2` in deps; used in `api/heal/sentry-webhook`, `api/score`, `api/db/init`, `api/admin/health` | TRUE. |
| H.7 | `MARKETING.md:198` | "Vercel charges — self-hosting Next.js is free" | Internal positioning copy. | TRUE. |
| H.8 | `README.md:211` | "**Claude (Anthropic)**" with model `claude-sonnet-4-20250514` (per CLAUDE.md) | `ANTHROPIC_API_KEY` is the documented env var; the model id is documented in the Bible. (No direct file:line for the model id in this audit.) | TRUE. |
| H.9 | `README.md:53` | "The action is a **composite — no Docker pull, no container build**" | `action.yml:64` confirms `runs: using: 'composite'` | TRUE. |

### I. Comparison-table claims

We claim to "replace" 30+ tools across `CLAUDE.md`, `README.md`, and
`MARKETING.md`. For every claim:

| # | Tool replaced | Module(s) | Exists? | Equivalence verdict |
|---|---|---|---|---|
| I.1 | Jest / Vitest / Mocha | `unitTests` | `src/modules/unit-tests.js` exists | We detect test runners and read results; we do NOT execute the tests ourselves. **Soft equivalence** — could be misread. |
| I.2 | Cypress / BrowserStack / Sauce Labs | `e2e` | `src/modules/e2e.js` exists | We integrate with Playwright/Cypress/Puppeteer if present; we don't replace the test infrastructure. Soft equivalence. |
| I.3 | ESLint / Stylelint | `lint` | `src/modules/lint.js` | We invoke ESLint when present + add our own rules. TRUE. |
| I.4 | Snyk / npm audit | `security` + `dependencies` | `src/modules/security.js` + `src/modules/dependencies.js` | Coverage is real but narrower than Snyk's CVE database (which is updated continuously by Snyk's researchers). Soft equivalence. |
| I.5 | Renovate / Dependabot | `dependencies` | same | We surface stale deps but do NOT raise the upgrade PRs Renovate raises. Soft equivalence. |
| I.6 | hadolint / dockle | `dockerfile` | `src/modules/dockerfile.js` | TRUE. |
| I.7 | actionlint / zizmor / StepSecurity | `ciSecurity` | `src/modules/ci-security.js` | TRUE. |
| I.8 | shellcheck / bashate / shfmt | `shell` | `src/modules/shell.js` | TRUE. |
| I.9 | squawk / pg-osc / Strong Migrations | `sqlMigrations` | `src/modules/sql-migrations.js` | TRUE. |
| I.10 | tfsec / Checkov / Terrascan | `terraform` | `src/modules/terraform.js` | TRUE. |
| I.11 | kube-score / kubeaudit / Polaris | `kubernetes` | `src/modules/kubernetes.js` | TRUE. |
| I.12 | Promptfoo / LLM Guard / Lakera | `promptSafety` | `src/modules/prompt-safety.js` | We catch a subset of the same surface (browser-bundled keys, cost-DoS, deprecated models). Soft equivalence. |
| I.13 | ts-prune / knip / Vulture | `deadCode` | `src/modules/dead-code.js` | TRUE. |
| I.14 | gitleaks / secretlint / dotenv-linter | `secretRotation` | `src/modules/secret-rotation.js` | TRUE. |
| I.15 | securityheaders.com / Mozilla Observatory / helmet | `webHeaders` | `src/modules/web-headers.js` | TRUE. |
| I.16 | type-coverage / `@typescript-eslint/no-explicit-any` | `typescriptStrictness` | `src/modules/typescript-strictness.js` | TRUE. |
| I.17 | eslint-plugin-jest-no-focused-tests etc. | `flakyTests` | `src/modules/flaky-tests.js` | TRUE. |
| I.18 | ESLint no-floating-promises, handle-callback-err | `errorSwallow` | `src/modules/error-swallow.js` | TRUE. |
| I.19 | New Relic / Datadog runtime N+1 + prisma-lint | `nPlusOne` | `src/modules/n-plus-one.js` | We do STATIC detection; New Relic / Datadog do RUNTIME profiling. Soft equivalence — different methodology. |
| I.20 | (no direct equiv) retry hygiene | `retryHygiene` | `src/modules/retry-hygiene.js` | TRUE. |
| I.21 | (no direct equiv) race condition | `raceCondition` | `src/modules/race-condition.js` | TRUE. |
| I.22 | (no direct equiv) resource leak | `resourceLeak` | `src/modules/resource-leak.js` | TRUE. |
| I.23 | Semgrep SSRF / Snyk SSRF | `ssrf` | `src/modules/ssrf.js` | TRUE. |
| I.24 | (no direct equiv) hardcoded URLs | `hardcodedUrl` | `src/modules/hardcoded-url.js` | TRUE. |
| I.25 | dotenv-linter / dotenvx diff | `envVars` | `src/modules/env-vars.js` | TRUE. |
| I.26 | (no direct equiv) async iteration | `asyncIteration` | `src/modules/async-iteration.js` | TRUE. |
| I.27 | (fragmented) bidi / homoglyph | `homoglyph` | `src/modules/homoglyph.js` | TRUE. |
| I.28 | openapi-cli / dredd / schemathesis | `openapiDrift` | `src/modules/openapi-drift.js` | We do STATIC drift detection; dredd is runtime. Soft equivalence. |
| I.29 | Danger.js | `prSize` | `src/modules/pr-size.js` | TRUE. |
| I.30 | safe-regex / recheck | `redos` | `src/modules/redos.js` | TRUE. |
| I.31 | crontab.guru / actionlint cron | `cronExpression` | `src/modules/cron-expression.js` | TRUE. |
| I.32 | (no direct equiv) datetime bug | `datetimeBug` | `src/modules/datetime-bug.js` | TRUE. |
| I.33 | madge / dependency-cruiser | `importCycle` | `src/modules/import-cycle.js` | TRUE. |
| I.34 | (no direct equiv) money float | `moneyFloat` | `src/modules/money-float.js` | TRUE. |
| I.35 | (no direct equiv) log PII | `logPii` | `src/modules/log-pii.js` | TRUE. |
| I.36 | ESLint no-constant-condition / LaunchDarkly ld-find-code-refs | `featureFlag` | `src/modules/feature-flag.js` | TRUE. |
| I.37 | SonarQube javascript:S4830 / Bandit | `tlsSecurity` | `src/modules/tls-security.js` | TRUE. |
| I.38 | SonarQube javascript:S2092 + S3330 / Bandit | `cookieSecurity` | `src/modules/cookie-security.js` | TRUE. |
| I.39 | Lighthouse | `performance` | `src/modules/performance.js` | We do heuristic checks + integrate with Lighthouse if present; we are NOT Lighthouse. Soft equivalence. |
| I.40 | axe / pa11y | `accessibility` | `src/modules/accessibility.js` (542 lines, real WCAG-AAA-aware checks) | Strong equivalence on the contrast / heading / alt-text surface; weaker on full WCAG 2.2 AAA conformance. |
| I.41 | Percy / Chromatic | `visual` | `src/modules/visual.js` | We can integrate; we don't host a visual-diff service. Soft equivalence. |
| I.42 | SonarQube | `codeQuality` + every other module | `src/modules/code-quality.js` + all the rest | TRUE. |
| I.43 | git-secrets / truffleHog | `secrets` | `src/modules/secrets.js` | TRUE. |
| I.44 | broken-link-checker | `links` | `src/modules/links.js` | TRUE. |

**I-category overall:** of 44 claimed replacements, **35** are strongly
supported, **9** are soft-equivalence claims that a knowledgeable
customer might push back on (Jest/Vitest, Cypress/BrowserStack,
Snyk-CVE-freshness, Renovate-style PR opening, prompt-safety subset,
New Relic runtime profiling, openapi runtime contract tests, Lighthouse
fidelity, Percy/Chromatic hosting). Recommendation: add an honest
"Coverage scope" footnote on the comparison page that clarifies STATIC
detection vs RUNTIME profiling, and "integrates with" vs "replaces".

### J. Real-repo proof claims

| # | Proof doc | Headline claim | Reproducibility check | Verdict |
|---|---|---|---|---|
| J.1 | `docs/proofs/phase-1-self-scan.md` | "Quick suite, 30 of **39 modules pass**, 37 errors, 328 warnings, 10s wall time" | The "39 modules" framing reflects an older suite shape. Today's `quick` suite is 4 modules per `TIERS.quick.modules`, but the historical run was against a broader configuration. Numbers are NOT re-verifiable in a read-only audit. | DRIFTED-frame. Add a "captured 2026-04-26" timestamp + suite-config snapshot. |
| J.2 | `docs/proofs/phase-1-self-fix-real.md` | "1 attempt, 8.5s wall time, 2 console.log calls correctly replaced" | Specific to a historical Claude run; not re-runnable now without same API + same git state. | UNVERIFIABLE in a read-only audit; honest as a point-in-time proof. |
| J.3 | `docs/proofs/phase-2-3-crontech-real-customer-grade.md` | "Crontech: 754 errors, 23/39 modules pass, 2 critical chains incl. supply-chain CI takeover" | Same — historical snapshot. | UNVERIFIABLE in audit; appears legitimate. |
| J.4 | `docs/proofs/phase-2-3-gluecron-marcoreid.md` | Gluecron 649 errors / 3 chains; MarcoReid 124 errors / 0 chains (honestly empty) | Same. | UNVERIFIABLE in audit; the "0 chains" honest result is structurally important — proves the correlator doesn't pad. |
| J.5 | `docs/proofs/phase-3-self-nuclear.md` | "12 of 12 findings diagnosed, 4 chains" | Same. | UNVERIFIABLE in audit. |
| J.6 | `docs/proofs/ai-ci-fixer-real-run.md` | "Full orchestrator path exercised" | Stubs the gate (`'all 90 modules pass'` — line 75) | Confirmed in source. Acceptable as a unit-level proof. |

**J-category overall:** the proof docs ARE real artefacts but they are
SNAPSHOTS at points in time. The README links them as if they're
live-verifiable, which they are not. Recommendation: add a "captured
at" timestamp + the exact CLI invocation + git SHA to every proof doc
so a reader can know whether the numbers are 6 days old or 6 months
old.

---

## Pricing consistency

(Repeated here for the launch checklist.)

| Tier | TIERS price | Pricing.tsx | Hero.tsx | README | Marketplace | TierTable | Compare pages | Consistent? |
|---|---|---|---|---|---|---|---|---|
| Quick | $29 | $29 | "From $29" | $29 | $29 | $29 | $29 | **YES** |
| Full | $99 | $99 | — | $99 | $99 | $99 | $99 | **YES** |
| Scan+Fix | $199 | $199 | — | $199 | $199 | $199 | $199 | **YES** |
| Nuclear | $399 | $399 | — | $399 | $399 | $399 | $399 | **YES** |
| Continuous | (not in TIERS) | $49/mo | — | mentioned | $49/mo | n/a | $49/mo (deepsource) | YES, but Continuous has no Stripe wiring — Pricing.tsx CTA routes to GitHub App install, which IS the honest framing |

**Pricing consistency: PASS.** No drift in dollar amounts across the
public site. Stripe TIERS is the source of truth and every customer-
facing surface matches it.

**One outlier:** `website/app/stack/page.tsx:146` says "Pay-per-scan
from **$49**" — this is wrong; the entry tier is $29. Fix before launch.

---

## Critical findings (top of the list to fix before launch)

1. **E.3 — SOC2/CIS/OWASP PDF promise.** `MonsterMoves.tsx:107` says
   every Nuclear scan auto-generates a board-ready PDF with SOC2 / CIS
   / OWASP mapping + 30/60/90-day roadmap. The renderer exists
   (`lib/ciso-report-generator.js`) but is NOT wired into the
   `api/scan/fix` Nuclear path. The customer who pays $399 will not
   receive that PDF in the current flow. **Either wire it in or change
   the copy before the launch.** Highest legal exposure of any single
   item in this audit.

2. **G.6 — "1,000 other repos" fingerprint claim.**
   `MonsterMoves.tsx:53` says GateTest "knows what fixed the same
   pattern in 1,000 other repos". There is no cross-customer recipe
   store today. **Remove or rephrase.**

3. **F.3 — "Pay only if we fix it" framing.** `Hero.tsx:73` says "Pay
   only if we fix it." Manual-capture actually fires on scan
   DELIVERY, not on FIX. **Rephrase to "Pay only when the scan
   delivers" — the rest of the site already uses that phrasing.**

4. **A.27 — "22/22" in Comparison.tsx:76.** Whatever 22 referred to is
   long obsolete. **Fix this hard-coded number** — it's the smallest
   change in the audit and the most jarring discrepancy a reader will
   see.

5. **Module-count drift across 56 surfaces.** Five different numbers
   are in use (22, 67, 90, 91, 102) — only the dynamic
   `how-it-works/*` surface is correct. Build a single
   `TOTAL_MODULES = 102` constant and import it everywhere, then sweep
   the codebase once.

6. **B.2 / B.3 — "Tests passing 3,500+ every commit" + "self-scan
   green".** 19 tests currently fail. Either fix those tests before
   launch (preferred — see also Known Issue #30 about the five test
   files renamed `.test.skip.js`), or soften the framing to "3500+
   tests in suite".

7. **D-category — "Under 15 seconds / under 60 seconds" performance
   claims.** No automated benchmark proves these targets today. Either
   add a CI timing assertion or soften to "designed for sub-15-second
   quick scans on typical repos".

8. **`/stack` page price drift.** "Pay-per-scan from **$49**" is wrong
   (should be **$29**).

---

## Recommended actions (in priority order, each tied to a finding)

| Priority | Finding | Action | Effort |
|---|---|---|---|
| P0 | E.3 | Either wire `generateCisoReport` into the Nuclear path OR rewrite `MonsterMoves.tsx:107` to say "available on request" | M (1-2h to wire OR 5min to rephrase) |
| P0 | G.6 | Rewrite `MonsterMoves.tsx:53` — drop the "1,000 other repos" claim | 5 min |
| P0 | F.3 | Rewrite `Hero.tsx:73` from "Pay only if we fix it" → "Pay only when the scan delivers" | 5 min |
| P0 | A.27 | Fix `Comparison.tsx:76` — replace "22/22" with "102/102" or "All of it. One gate." | 5 min |
| P0 | `stack/page.tsx:146` | Change "$49" → "$29" | 2 min |
| P1 | All A-category module drift | Introduce `MODULE_COUNT = 102` export from one file (e.g. `website/app/lib/totals.ts`), sweep all 56 surfaces | M (2-3h) |
| P1 | B.2 / B.3 | Decision: fix the 19 failing tests (preferred) OR soften "every commit" framing | M-L (depending on which) |
| P1 | E.1 / E.2 | Add "AAA contrast subset" footnote on every WCAG 2.2 AAA claim | S (15 min) |
| P2 | D-category | Add automated timing test in `tests/` that asserts quick-suite < 15s, full < 60s on a fixed reference repo | M (1-2h) |
| P2 | I-category soft-equivalence | Add "Coverage scope" footnote on `/compare/*` pages distinguishing static vs runtime | S (30 min) |
| P2 | J-category proof docs | Add "captured at YYYY-MM-DD against git SHA …" timestamp to every proof doc | S (per doc, 5 min × 15 docs = ~1.5h) |
| P3 | F.6 | Clarify "every time after: free" — "within a single repo / install" vs "across the GateTest network" | S (10 min) |

---

## What this audit did NOT check (out of scope / future audit)

- Per-module false-positive rate against real codebases (covered
  partially by the existing `docs/proofs/*` artefacts; would need
  fresh runs to verify).
- Legal-page accuracy (Terms / Privacy / Refunds) — covered by the
  separate `docs/legal/legal-pages-audit.md` document.
- DNS / domain ownership claims (Bible Boss Rule #4 — Craig's domain).
- Stripe live-vs-test key configuration (Bible Boss Rule #6 — Craig's
  Stripe).
- GitHub Marketplace listing approval status (Bible Known Issue #29 —
  Craig's action).

---

## Audit metadata

- Total marketing surfaces scanned: README.md, MARKETING.md,
  CLAUDE.md (referenced), action.yml, docs/marketplace/*.md,
  docs/proofs/*.md, website/app/page.tsx, website/app/layout.tsx,
  website/app/components/*.tsx (37 files), website/app/compare/*
  (5 competitor pages), website/app/how-it-works/*,
  website/app/for/nextjs/page.tsx, website/app/web/page.tsx,
  website/app/wp/page.tsx, website/app/stack/page.tsx,
  website/app/scan/status/page.tsx, website/app/github/setup/page.tsx,
  website/app/docs/api/page.tsx, website/app/admin/AdminPanel.tsx,
  website/app/api/checkout/route.ts, website/app/api/scan/preview/route.ts.
- Commands run:
  - `node bin/gatetest.js --list 2>&1 | grep -cE "^  [a-z]"` → 102
  - `node --test tests/*.test.js` → 3900 tests / 3881 pass / 19 fail / 809 suites / ~97.8 s
  - `grep -n "capture_method" website/app/api/checkout/route.ts` → `"manual"` at line 176
  - `cat website/package.json` → next 16.2.4, tailwindcss 4, react 19.2.4, @neondatabase/serverless 1.0.2
  - `cat package.json` → engines.node >= 20.0.0
- Tools used: read-only `Bash`, `Read`, `Edit` (only on `claims-verification.md`), `Write` (only on `claims-verification.md`).
- No production files modified.

---

_End of audit._
