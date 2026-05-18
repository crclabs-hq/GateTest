# Public copy legal redline — pre-launch audit

Generated: 2026-05-17
Scope: every customer-facing copy surface in this repo
Auditor: read-only audit, no code/copy changes
Reviewer: Craig (final call on every redline)

## Summary

- **Severity 1 (must fix before launch):** 11 findings
- **Severity 2 (should fix before launch):** 18 findings
- **Severity 3 (factual accuracy):** 27 findings
- **Severity 4 (tone/positioning):** 9 findings
- **Severity 5 (informational):** 7 findings

**Top 3 most-urgent items** (read these first):

1. `docs/GITHUB-MARKETPLACE-LISTING.md:88-92` — **three fabricated customer testimonials**. These are pre-launch copy meant for GitHub Marketplace; if submitted as-is they are misleading-advertising bait under FTC Endorsement Guides + GitHub Marketplace ToS.
2. **Module count drift across 9+ public surfaces** (19/20/67/82/90/91/94/101/102) — the actual `bin/gatetest.js --list` count is 102, but `layout.tsx` metadata (the HTML `<title>` / OG / structured-data `SoftwareApplication` Offer block) still says **67 modules** at three places. README and Marketplace draft say 91. Compare pages say 90. Pricing card says 90. Hero says 91. If a customer pays based on the layout metadata and a journalist sees the compare pages, the numbers don't match.
3. `website/app/components/Pricing.tsx:39` + 4 compare pages — unqualified **"WCAG 2.2 AAA"** claim. AAA is the highest WCAG conformance level; claiming a $99 automated scan delivers it could be cited in an ADA complaint as a representation we relied on. Must add "audits against" or downgrade to "WCAG 2.2 AA-equivalent automated checks."

---

## Verified claims

Verification commands run on this branch, 2026-05-17:

```
node bin/gatetest.js --list 2>&1 | grep -E "^  [a-z]" | wc -l   → 102
node --test tests/*.test.js 2>&1 | tail                          → 3900 pass, 0 fail
website/package.json → next 16.2.4, tailwindcss ^4
package.json → version 1.0.0
LICENSE → MIT (not Apache-2.0)
```

| Claim | Where stated | Actual value | Match? |
|---|---|---|---|
| 91 modules | `README.md:3,12,23,183`, `Hero.tsx:60,66,123`, `HomeCode.tsx:37`, `listing-draft.md:11,24,63,72,81`, `install-guide.md:55,121,165`, `phase-1-self-scan.md` | 102 | NO — under by 11 |
| 90 modules | `Pricing.tsx:34,61,81`, all 5 `compare/*` pages, `checkout/route.ts:51`, `scan/preview/route.ts:289`, `Install.tsx:17`, `for/nextjs/page.tsx:186,313`, `scan/status/page.tsx:588-589`, `admin/AdminPanel.tsx:594`, `HomeKills.tsx:23` ("Plus 90 more checks") | 102 | NO — under by 12 |
| 67 modules | `layout.tsx:17,46,56,100,115` (HTML head + OG + structured-data Offer), `opengraph-image.tsx:92`, `Cta.tsx:11,31,58`, `HowItWorks.tsx:21,40`, `Modules.tsx:142`, `Problem.tsx:72`, `GATECODE.md` (root MD), `GITHUB-MARKETPLACE-LISTING.md:21,32,82,83,172` | 102 | NO — under by 35; **THIS IS WHAT GOOGLE / OG-RENDERERS SEE** |
| 20 modules | `MARKETING.md:48,71,124,138-139,213,232-236`, GitHub-App description in `GITHUB-APP-SETUP.md:69` | 102 | NO — under by 82 |
| 19 modules | `GATECODE.md:17,96,129` | 102 | NO |
| 94-module | `wp/page.tsx:165` | 102 | NO — drift |
| 101 modules | `stack/page.tsx:143` | 102 | NO — close, but 1 off |
| 102 modules | `how-it-works/page.tsx` (via dynamic `totalModuleCount()`), `ArchitectureDiagram.tsx`, `modules-data.ts` | 102 | YES |
| 3500+ tests | `README.md:13`, `Hero.tsx:12,127` (rendered as "3,500+"), `listing-draft.md:73` | 3900 | NO — under by 400+. Either bump to "3,900+" or leave 3,500+ as a conservative floor (lawyer-safer). |
| 800+ checks | `Problem.tsx:72` | not measured directly; tests = 3,900, modules = 102 | UNVERIFIED — kept "800+" looks dated, suggest dropping or replacing with "3,900+ unit tests" |
| 200+ checks | `MARKETING.md:213` | as above | UNVERIFIED / stale |
| Next.js 16 | `README.md:209`, `how-it-works/page.tsx:21`, `Pricing.tsx` (implicit) | 16.2.4 | YES |
| Tailwind 4 | `README.md:209`, `how-it-works/page.tsx:21` | ^4 | YES |
| Vercel-native | `README.md:209`, `how-it-works/page.tsx:22` | verified — `vercel.json` present, deploy target | YES |
| Crontech.ai used | `HomeTrust.tsx:70-77`, `README.md:225` (proof doc), `listing-draft.md:74`, `MARKETING.md` indirect | CLAUDE.md PROTECTED PLATFORMS confirms Crontech is Craig-owned and "INTEGRATING" status | YES — Craig-owned, OK to reference as long as language is "we use it" not "customer of ours" |
| Gluecron.com used | `HomeTrust.tsx:80-87`, `README.md:225`, `listing-draft.md:74` | Same — Craig-owned, "INTEGRATING" | YES — same caveat |
| MIT license | `README.md:11,213,252`, `legal/refunds:202`, `legal/terms:249` | LICENSE = MIT | YES |
| Apache-2.0 license | `HomeCode.tsx:118` | LICENSE = MIT | NO — drift |
| "gatetest.io" canonical OG | `layout.tsx:47` (openGraph.url) | site is gatetest.ai | NO — wrong TLD typo |
| "v1.42 · 91 modules live" badge | `Hero.tsx:60` | version in `package.json` = 1.0.0; CLAUDE.md mentions v1.41.0/v1.42.0 | UNVERIFIED — v1.42 string is from CLAUDE.md but `package.json` says 1.0.0 |
| "claude-sonnet-4-20250514" | `CLAUDE.md` (internal — out of scope) | n/a | n/a |
| "GateTestHQ" GitHub App name | `GITHUB-APP-SETUP.md:11` | external check needed | UNVERIFIED |
| `ccantynz-alt/gatetest@v1` resolves | `README.md:45,197`, `listing-draft.md:49`, `install-guide.md:27,39` | git tag `v1.0.1` exists; no `v1` floating tag verified | NEEDS VERIFICATION |

---

## Severity 1 — must fix

### 1.1 `docs/GITHUB-MARKETPLACE-LISTING.md:88-92` — fabricated customer testimonials

```
> *"We duct-taped ESLint, Snyk, and Lighthouse together for two years. GateTest replaced all three with one config file."*
> *"Caught a hardcoded Stripe key in a junior dev's PR before it hit main. Paid for itself in the first scan."*
> *"The N+1 detector alone found 12 unindexed queries in our first scan. Our p99 latency dropped 40%."*
```

**Risk:** Inventing customer quotes is the textbook FTC Endorsement Guides violation. Reputational risk on HN is even worse — the audience hunts fabricated social proof. `website/app/components/HomeTrust.tsx:9` already commits the team to "No fabricated customer logos. No fake testimonials" — these contradict that pledge.

**Suggested redline:**
> Remove the three quote blocks entirely. Replace with the existing honest "We dog-food this engine on the gatetest, Crontech, and Gluecron repos — see the proof docs at [/docs/proofs](…)." If Craig wants social proof, hold the Marketplace submission until real customers exist and have consented in writing.

**Why this is safer:** No invented endorsement = no FTC liability and no HN backlash.

---

### 1.2 `MARKETING.md:96` — "80-90% ahead of any single competitor"

```
7. **80-90% ahead of any single competitor** — Because we cover 16x the scope.
```

**Risk:** Unsubstantiated comparative claim, false-advertising bait under the Lanham Act (US) and the Misleading Advertising Provisions of the Fair Trading Act (NZ). The "16x" figure is also stale (claim was made when GateTest had 16 modules; now 102).

**Suggested redline:**
> "Broader by design — GateTest covers 90+ scanning dimensions in one tool. The standalone competitors we replace cover one to four each."

**Why this is safer:** Quantifies the scope difference factually, drops the unverifiable percentage.

---

### 1.3 `website/app/components/MonsterMoves.tsx` — entire component is high-risk (currently NOT rendered, but file exists in repo)

```
05: "We're not 10% better than SonarQube. We're not 30% better than Snyk."
40: "SonarQube covers ~10 categories. Snyk covers ~4. GateTest covers 90."
11: "No competitor does this." (cross-finding correlation)
22: "The only QA tool with a detector for its own outputs." (fake-fix detector)
71: "No competitor generates chaos tests."
149: "20 capabilities no competitor has shipped. Not even close."
```

**Risk:** Even though `page.tsx:18-22` explicitly says MonsterMoves is dropped from the current homepage, the file lives in the public repo and the route exists if anyone imports it. The whole component is a cease-and-desist invitation: unverifiable "no competitor does this" claims about named competitors (SonarQube/Snyk). The component also names Datadog and Sentry positively (`MonsterMoves.tsx:47`) without their consent.

**Suggested redline:**
> Delete `website/app/components/MonsterMoves.tsx` before launch. If Craig wants to keep the differentiator messaging, port a soft-language version into `HomeFlywheel.tsx` or a new component with claims tied to specific public docs.

**Why this is safer:** Removes the legal surface entirely. The current `HomeFlywheel.tsx` already covers the differentiator story in a defensible way ("we stack four deterministic layers in front of Claude").

---

### 1.4 `website/app/components/Cta.tsx:58` — "Free forever. All 67 modules."

```html
<p className="text-xs text-muted mt-2">Free forever. All 67 modules.</p>
```

**Risk:** "Free forever" is a breach-of-contract risk if monetisation of the CLI ever happens. Contradicts the rest of the site's paid-tier messaging. The CLI is MIT-licensed so the source is free, but "Free forever" is a stronger commitment than the license. Component is currently NOT rendered on the homepage per `page.tsx:18`, but it exists.

**Suggested redline:**
> If keeping the file: change to "MIT-licensed CLI — run it yourself, no payment required." If not keeping, delete the file.

**Why this is safer:** "MIT-licensed" is a verifiable legal status; "free forever" is a promise.

---

### 1.5 `MARKETING.md:11,15` — "AI writes fast. GateTest keeps it honest." paired with "Nothing ships unless it's pristine."

```
9: ## Tagline
11: **"AI writes fast. GateTest keeps it honest."**
13: ## One-liner
15: GateTest is the advanced QA gate between AI and GitHub. Nothing ships unless it's pristine.
```

**Risk:** "Nothing ships unless it's pristine" is a guarantee about deliverable quality — over-promising. The `legal/terms` page at `:147-200` explicitly disclaims "guarantee that it will detect all issues." Public copy should match the legal copy.

**Suggested redline:**
> "AI writes fast. GateTest keeps it honest." stays. Replace "Nothing ships unless it's pristine" with "One config, one report, one decision. Block what's broken, ship what's clean."

**Why this is safer:** Reproduces the gate's actual behaviour without making an unconditional quality promise.

---

### 1.6 `website/app/components/HomeKills.tsx:23` — "Plus 90 more checks ESLint never tries to run"

```
{ tool: "ESLint", module: "lint", blurb: "Plus 90 more checks ESLint never tries to run." },
```

**Risk:** "Never tries to run" is a factual claim about ESLint's behaviour. ESLint has thousands of community rules; some overlap with what we describe in those 90. Calling out "never" is the kind of phrasing a competitor's lawyer screenshots.

**Suggested redline:**
> "Plus 90 more checks across security, performance, and runtime safety dimensions ESLint does not cover by default."

**Why this is safer:** Hedges with "by default," softens "never tries to run."

---

### 1.7 `website/app/components/HomeKills.tsx:25` — "no monthly device farm bill" (BrowserStack)

```
{ tool: "BrowserStack", module: "compatibility", blurb: "Cross-browser matrix, no monthly device farm bill." },
```

**Risk:** Direct cost-comparison swipe at a named competitor. BrowserStack is a $4B company with active litigation history. Statement implies their pricing model is bad — interpretation that turns into a defamation question if pushed.

**Suggested redline:**
> "Cross-browser matrix, no separate device-farm subscription required."

**Why this is safer:** Same point, different language. Removes the implicit "their bill is bad" jab.

---

### 1.8 `website/app/components/HomeKills.tsx:32` — "Plus unpinned actions, pwn-request, permissions hygiene" (actionlint)

```
{ tool: "actionlint", module: "ciSecurity", blurb: "Plus unpinned actions, pwn-request, permissions hygiene." },
```

**Risk:** Lower-severity but: actionlint is open-source maintained by rhysd; "plus" implies actionlint lacks these. actionlint actually does catch some. Same legal shape as the ESLint one above.

**Suggested redline:**
> "Adds unpinned-action scanning, pwn-request detection, and `permissions:` hygiene checks on top of action lint coverage."

---

### 1.9 `MARKETING.md:84-85` — "Zero-tolerance enforcement — Not warnings. Not suggestions. Pipeline blocking. One failure in any of the 16 modules = entire build blocked. No overrides."

```
84: Zero-tolerance enforcement — Not warnings. Not suggestions. Pipeline blocking.
85: One failure in any of the 16 modules = entire build blocked. No overrides.
```

**Risk:** "No overrides" contradicts reality — the runner supports warning-only mode (`fail-on-warning: false` is the default per `install-guide.md:60`). A customer who relies on this and ships a bug because their warning-tier check didn't block, has a misrepresentation claim. Also says "16 modules" — stale by 86.

**Suggested redline:**
> "Configurable severity — error-level findings block by default; warning and info levels are reported but don't block. You decide what blocks via `fail-on-warning`."

---

### 1.10 `docs/marketplace/listing-draft.md:61` + `install-guide.md:163` — "Free for OSS"

```
listing-draft.md:61: - Free for public open-source repos via the open-source workflow.
install-guide.md:163: | Free (OSS) | $0 | Full gate, public repos only |
```

**Risk:** This pricing tier is not implemented anywhere in `website/app/api/checkout/route.ts` (the actual TIERS object) and not in `Pricing.tsx`. Publishing this in the Marketplace listing creates a contract obligation that the implementation doesn't honor.

**Suggested redline:**
> Either ship the free-OSS workflow before Marketplace submission, OR drop the "Free for OSS" line and replace with "Open-source maintainers — contact us for a project sponsorship plan." Craig decides.

---

### 1.11 `website/app/components/Pricing.tsx:39` + 4 `compare/*` pages — unqualified WCAG 2.2 AAA

```
Pricing.tsx:39:     "Accessibility (WCAG 2.2 AAA)",
compare/snyk/page.tsx:68: { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
compare/sonarqube/page.tsx:63: { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
compare/eslint/page.tsx:65: { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
compare/github-code-scanning/page.tsx:62: { feature: "Accessibility scanning (WCAG 2.2 AAA)", gatetest: true, competitor: false },
compare/github-code-scanning/page.tsx:159: { label: "Accessibility", items: ["WCAG 2.2 AAA", ...] },
HomeKills.tsx:27: { tool: "axe-core", module: "accessibility", blurb: "WCAG 2.2 AAA — built in, not a separate plugin." },
Modules.tsx:29: description: "WCAG 2.2 AAA — missing alt text, ARIA labels, keyboard traps, heading hierarchy.",
MARKETING.md:60: | accessibility | WCAG 2.2 AAA — alt text, ARIA, focus, contrast |
ContinuousScanning.tsx:11: { name: "WCAG Compliance Audit", ..., description: "Complete WCAG 2.2 AAA accessibility audit" },
HowItWorks.tsx:30: [PASS] accessibility  — WCAG 2.2 AAA
AiNative.tsx:24: GateTest enforces WCAG 2.2 AAA.
```

**Risk:** WCAG 2.2 AAA is the highest accessibility conformance level — most government and enterprise procurement contracts treat unqualified AAA claims as compliance representations. An ADA / California Unruh Act / EU EAA plaintiff cites our marketing claim as their reliance evidence. Automated tools cannot certify WCAG conformance at any level (W3C explicitly says so); they can only audit a subset of rules.

**Suggested redline:**
> Wherever this appears, replace `WCAG 2.2 AAA` with `WCAG 2.2 — automated checks against AA + AAA-mappable rules` OR simply `accessibility (axe-core ruleset)`. The legal pages already disclaim in `legal/terms:147` — public copy should mirror that.

**Why this is safer:** Distinguishes "what our scanner can detect" from "your site is WCAG 2.2 AAA conformant."

---

## Severity 2 — should fix

### 2.1 `website/app/components/Hero.tsx:60` — "Launching today · v1.42 · 91 modules live"

```
60: <span>Launching today &middot; v1.42 &middot; 91 modules live</span>
```

**Risk:** "Launching today" is a rolling-truth claim — accurate the day Craig flips the switch, becomes a lie one week later. "v1.42" doesn't match `package.json` "1.0.0". "91 modules" doesn't match the 102 in `gatetest --list`.

**Suggested redline:**
> "Live · v1.x · 102 modules" — and update via a single config constant so it doesn't drift.

---

### 2.2 `website/app/page.tsx:7` — Section comment header "91 modules"

Inline comment, ships compiled but not visually displayed. Counts as a minor drift cleanup, not a customer-facing risk. Bump to 102 when the rest of the drift is fixed.

---

### 2.3 `README.md:3,12,23,183` — "91 modules"

Per the verification table — actual is 102. Update or pin to a single source. README is the highest-traffic doc; a HN reader will diff this against `--list` output.

---

### 2.4 `website/app/components/HomeFaq.tsx:76` — "scan-finish rate is well above 99% on real repos"

```
76: scan-finish rate is well above 99% on real repos; we eat the cost of
```

**Risk:** Specific availability claim with no measurement methodology disclosed. If a customer's scan fails and they sue for refund of past scans, they cite this. "99% uptime" is one of the most-litigated SaaS marketing claims.

**Suggested redline:**
> "scans complete reliably on real repos; we eat the cost of the few that fail." OR add an asterisk pointing at a public availability page Craig commits to maintain.

---

### 2.5 Compare pages — "under 15 seconds / under 60 seconds" performance claims

```
compare/sonarqube/page.tsx:223:  "GateTest quick scans complete in under 15 seconds, full scans under 60 seconds."
compare/sonarqube/page.tsx:261:  "Paste your repo URL and get a full 90-module scan in under 60 seconds."
compare/deepsource/page.tsx:45:  "GateTest quick scans (4 modules) complete in under 15 seconds. Full 90-module scans complete in under 60 seconds."
compare/eslint/page.tsx:41:  "...results in under 60 seconds."
install-guide.md:124: "`quick` finishes in under 15 seconds on a typical repo. `full` targets under 60 seconds."
```

**Risk:** Specific time guarantees without methodology. The proof docs show `quick` at ~10s on this repo (`phase-1-self-scan.md`) and Crontech at 25.5s — already busting the "15s" claim on a real customer repo. A claim like "under 60 seconds" reads as a service-level commitment.

**Suggested redline:**
> "Quick scans typically complete in 10-30 seconds; full scans in 30-90 seconds. Time scales with repo size."

---

### 2.6 `compare/sonarqube/page.tsx:33,49,53` — comparative absolutes about SonarQube

```
33: "GateTest covers everything SonarQube does — code quality, security patterns, technical debt, and duplication — plus 50+ modules SonarQube doesn't have"
133: "SonarQube was built in 2006 — before AI, before cloud-native CI/CD, before modern security threats."
197 (key differentiator card):  "AI-native, not AI-bolted-on... SonarQube added AI features to a 2006 rule engine."
```

**Risk:** "Covers everything SonarQube does" is the kind of comparative claim SonarSource (the SonarQube vendor, France, EU) will demand evidence for. The "2006" framing is technically true but combined with "before modern security threats" it's a knock at their product.

**Suggested redline:**
> "GateTest covers SonarQube's core dimensions (code quality, technical debt) and adds dimensions SonarQube doesn't address (AI safety, runtime checks, etc.)." Drop the "before modern security threats" line — it's needling, not informative.

---

### 2.7 Compare pages — "no per-seat licensing" / "pay per scan (not per seat)"

```
Appears 5+ times across compare/*/page.tsx feature tables.
```

**Risk:** Implies competitor pricing models are bad. Mostly fine because pricing models are public and not subjective, but the language can come off as needling. Worth a tone pass.

**Suggested redline:**
> "Pricing structure: per scan." Drop the "not per seat" half — let the customer make the comparison.

---

### 2.8 `compare/snyk/page.tsx:33,49` — "Snyk only scans dependencies"

```
metadata.description: "Snyk only scans dependencies."
33: "Snyk focuses on known CVEs in third-party packages."
49 (key card): "Snyk reads package.json and compares against CVE databases."
```

**Risk:** Snyk actually ships Snyk Code (SAST product) and Snyk IaC. The "only scans dependencies" claim is materially incorrect and Snyk is one of the most aggressive litigants in this space — they have a documented history of pursuing competitor false-comparison claims.

**Suggested redline:**
> "GateTest scans dependencies AND application source code in one tool — fewer config files, one bill."

**Why this is safer:** True statement about our product, no false claim about Snyk.

---

### 2.9 `compare/deepsource/page.tsx:33,41` — "AI-Native Code Quality" framed against DeepSource

```
33: "DeepSource finds issues. GateTest finds AND fixes them."
41: "DeepSource Autofix generates fixes for a specific subset of analysis issues. GateTest uses Claude to read your entire codebase context and write fixes for any issue it finds"
```

**Risk:** "for any issue it finds" is over-promising — `legal/terms:169` already disclaims this. Also implies DeepSource's autofix is inferior; DeepSource is funded and US-based, capable of pursuing.

**Suggested redline:**
> "GateTest writes fixes for most finding classes — security misconfigurations, code quality issues, and config drift. See `docs/proofs/` for representative diffs."

---

### 2.10 `website/app/wp/page.tsx:199-200` — "WCAG complaints can become $5K-$100K legal exposure"

```
title: "Accessibility / ADA compliance",
pain: "WCAG complaints can become $5K-$100K legal exposure. Every month brings new ADA-compliance lawsuits against e-commerce sites."
```

**Risk:** Specific dollar amounts framed as customer-facing pain. If a customer reads this, doesn't get fixed, and gets sued for $X — they cite this as our representation. The $5K-$100K range is actually accurate-ish for ADA settlements but the framing presents us as having scared them into buying.

**Suggested redline:**
> "ADA-style accessibility complaints are now a regular cost-of-doing-business for e-commerce sites. We surface the issues an automated audit can catch."

---

### 2.11 `MARKETING.md:108-110` — "Teams that need compliance evidence (SOC2, HIPAA, PCI-DSS)"

```
108-110: "Teams that need compliance evidence (SOC2, HIPAA, PCI-DSS)
Teams shipping to regulated industries"
```

**Risk:** Marketing toward customers who need SOC2/HIPAA/PCI-DSS evidence, without actually being able to deliver compliance certification. If a customer relies on our report for SOC2 audit, fails, and traces back to us — exposure.

**Suggested redline:**
> "Teams that need engineering-quality evidence in their compliance binder — alongside (not replacing) formal audits."

---

### 2.12 `website/app/wp/page.tsx:74-79,105-107` — "Pre-launch, every scan is free during the soft-launch window"

```
105-107: "Pricing structure pending Stripe setup — see your developer if you need
         immediate access. Pre-launch, every scan is free during the soft-launch
         window."
```

**Risk:** Implies a free-trial window with no defined end date. If customers come in expecting "free for life" because the soft-launch never officially closes, that's a contract claim.

**Suggested redline:**
> Add a specific cutoff: "Free during 2026 soft-launch — paid tiers activate when banner is removed." Or remove the "soft launch is free" line entirely.

---

### 2.13 `website/app/components/MonsterMoves.tsx:5,11,22,71` — multiple "no competitor" claims (component is unrendered but still a risk)

Already covered under 1.3 — listing here for completeness. Each of the 4 "no competitor" lines is its own Lanham Act risk if the file were ever imported.

---

### 2.14 `docs/marketplace/listing-draft.md:74` — "Used in production by Crontech and Gluecron"

```
74: - Used in production by Crontech and Gluecron (Craig-owned platforms protected via the same engine).
```

**Risk:** Crontech.ai and Gluecron.com are still listed as "INTEGRATING" in CLAUDE.md PROTECTED PLATFORMS table (not "INTEGRATED"). Saying "used in production" is forward-leaning. The status field literally says INTEGRATING in CLAUDE.md.

**Suggested redline:**
> "Integrated into Crontech.ai and Gluecron.com CI pipelines as a CI gate (both Craig-owned platforms)."

---

### 2.15 `README.md:229` — "100x+ margin" claim in proof section

```
229: Total Anthropic spend across the four external real-repo Nuclear proofs: roughly three to four US dollars. At the $399 Nuclear tier that is a hundred-times-plus margin
```

**Risk:** "100x+ margin" is a marketing-flavoured claim in a "proofs" section that's otherwise factual. Margin claims invite "where are your unit economics?" questions from investors-as-readers, and "100x" is unverifiable without P&L. Fine for a HN comment, not for committed-to-repo marketing.

**Suggested redline:**
> Drop the entire "At the $399 Nuclear tier that is a hundred-times-plus margin, before recipe distillation reduces it further on repeat scans." sentence.

---

### 2.16 `compare/snyk/page.tsx:154` — "What Snyk can't scan" callout

```
154: <h2>What Snyk can't scan</h2>
155: <p>Snyk scans your package.json for known CVEs. It has zero visibility into your application code.</p>
```

**Risk:** "Zero visibility into your application code" is materially incorrect — Snyk Code is an SAST that explicitly analyses application source. This is the lawsuit-shape claim.

**Suggested redline:**
> Reframe the section to "What you might want to scan beyond dependencies" — list the patterns (SSRF, N+1, etc.) as things GateTest catches, without making a competing-product-cant-see claim.

---

### 2.17 `compare/github-code-scanning/page.tsx:131-135` — "covers exactly one of them"

```
131-135: "...security is one of 90 quality dimensions your code needs — and GitHub Code Scanning covers exactly one of them."
```

**Risk:** "Exactly one of them" is comparative; CodeQL/GitHub Code Scanning has a wide rule pack that touches code quality and some logic patterns, not strictly one dimension. GitHub is the platform we'll be listed on — picking this fight is dumb.

**Suggested redline:**
> "GitHub Code Scanning focuses on security vulnerability detection. GateTest covers security AND 80+ other quality dimensions in the same gate."

---

### 2.18 `website/app/components/Pricing.tsx:106` — "Stripe wiring for the subscription product is pending Craig"

```
96-99 (code comment) + UI: the Continuous tier CTA points at `/github/setup` rather than a Stripe URL because Stripe wiring isn't done.
```

**Risk:** Pricing card displays "$49 / month" but checkout flow doesn't take payment for it. A customer who clicks "Install GitHub App" thinking they're subscribing has a misrepresentation claim if they're billed later, or a "I expected the subscription" claim if they're not.

**Suggested redline:**
> Either ship the Stripe subscription or change the "Continuous" card label to "Continuous (coming soon)" with a no-cost waitlist signup until Stripe ships.

---

## Severity 3 — factual accuracy

### 3.1 `website/app/layout.tsx:17,46,56,100,115` — five places say "67 modules"

This is the highest-impact factual drift because `layout.tsx` controls:

- HTML `<title>` and `<meta description>` (Google + browser tab)
- OpenGraph metadata (Twitter card, link previews on every social platform)
- JSON-LD `SoftwareApplication` structured data with `Offer.description`

When a journalist or HN crawler reads the OG card on a link share, they see "67 modules" — even though the live page renders Hero at "91 modules" and the actual count is 102. **Three different numbers visible from one URL.**

**Suggested redline:**
> Update all five places to the actual count (currently 102). Better: extract `MODULE_COUNT` to a single source-of-truth constant (perhaps from `modules-data.ts:totalModuleCount()`) and reference it everywhere.

---

### 3.2 `website/app/layout.tsx:47` — `openGraph.url: "https://gatetest.io"`

```
47: url: "https://gatetest.io",
```

**Risk:** Wrong TLD — site is `gatetest.ai`. OG renderers will resolve the wrong URL, potentially exposing a typosquat opportunity. If `gatetest.io` exists and shows different content, we're inadvertently driving share-link traffic to it.

**Suggested redline:**
> Change to `"https://gatetest.ai"`.

---

### 3.3 `website/app/opengraph-image.tsx:92` — "67 modules scan your entire codebase"

```
92: 67 modules scan your entire codebase. Security, supply chain, auth flaws, CI hardening, and AI code review. Pay only when delivered.
```

**Risk:** Same as 3.1 — appears on the OG image users share on social.

**Suggested redline:** Update to 102.

---

### 3.4 `website/app/components/Cta.tsx:11,31,58` — "67 modules" three times

Per earlier: this component is currently not rendered on `page.tsx`, but the file exists.

**Suggested redline:** Either delete the file or update to 102.

---

### 3.5 `website/app/components/HowItWorks.tsx:21,40` — "67 modules"

Same — component dropped from homepage but file exists.

---

### 3.6 `website/app/components/Modules.tsx:142` — "67 modules. Every scan."

Same.

---

### 3.7 `website/app/components/Problem.tsx:72` — "67 modules. 800+ checks. One gate."

Same plus "800+ checks" is an unverified count.

---

### 3.8 `MARKETING.md:48,71,124,138-139,213,232-236` — "16 modules" / "20 modules" repeatedly

**Risk:** MARKETING.md is in the repo root and a savvy reader will find it. Numbers are massively stale (16/20 vs 102).

**Suggested redline:**
> MARKETING.md is internal-flavoured; either update with current numbers OR add a header "INTERNAL DRAFT — see /website for live copy" OR move it to `docs/internal/`.

---

### 3.9 `GATECODE.md` (root, public-visible) — describes a "GateCode" product that no longer matches reality

```
17: GateTest (19 modules, live crawl, explorer, chaos)
32: | **Cost** | Free forever | Free tier + paid plans |
96: GateTest Engine (19 modules, crawler, loop)
129: ✅ GateTest engine (DONE — 19 modules, crawler, AI loop)
```

**Risk:** Stale strategy doc in root says 19 modules and "GateCode" as a separate product. Anyone browsing the repo (HN, journalists, customers) sees this and concludes either we don't know our own product, or "GateCode" is an actual offering they should research.

**Suggested redline:**
> Move `GATECODE.md` to `docs/archive/`, OR delete it, OR add a banner at top: "Historical brainstorm document — superseded by current product. See README.md for live state."

---

### 3.10 `GITHUB-APP-SETUP.md:69` — "20 test modules" in marketplace short description

```
69: - **Short description**: "20 test modules scan your code on every push. Security, accessibility, performance, and more."
```

**Risk:** Marketplace short-description text caches into GitHub Marketplace search index. If Craig copies this when submitting, the listing carries an 80-module drift.

**Suggested redline:**
> Update to current count and trim to 140 chars per Marketplace limit.

---

### 3.11 `docs/marketplace/listing-draft.md:11,24,63,72,81` — "91 modules" (5 places)

Should be 102 if we're truly counting all loaded modules. Or keep 91 if Craig wants to advertise only the customer-facing modules and exclude the internal-only ones (deployContract, deployReadiness, etc.).

**Suggested redline:**
> Decide the number to advertise. Document the decision so future sessions don't redrift.

---

### 3.12 `docs/marketplace/install-guide.md:55,121,165` — "91 modules"

Same as 3.11.

---

### 3.13 `website/app/components/HomeCode.tsx:118` — "Apache-2.0" but LICENSE is MIT

```
118: <a ...>on GitHub</a> — Apache-2.0. The CLI itself is free; the auto-fix tiers are paid.
```

**Risk:** LICENSE file at repo root is MIT. Saying Apache-2.0 to a customer who relies on the license terms (e.g. a corporate buyer doing legal review) is a misrepresentation.

**Suggested redline:**
> Change "Apache-2.0" → "MIT".

---

### 3.14 `website/app/components/Hero.tsx:60` — "v1.42" but package.json says "1.0.0"

```
60: <span>Launching today &middot; v1.42 &middot; 91 modules live</span>
package.json:3: "version": "1.0.0",
```

**Suggested redline:**
> Pick a version policy. If CLAUDE.md's "v1.42.0" is the public version, bump `package.json` to match. If 1.0.0 is the public ship version, change the Hero badge.

---

### 3.15 `README.md:13` + `Hero.tsx:127` + `listing-draft.md:73` — "3500+ tests" while actual is 3,900

```
README.md:13: [![Tests](https://img.shields.io/badge/tests-3500%2B-brightgreen.svg)](#real-repo-proofs)
Hero.tsx:127: value="3,500+"
listing-draft.md:73: - 3500+ unit tests pass on every commit.
```

**Risk:** Conservatively claiming 3500+ is actually legally safer than claiming the current 3900. But the README badge feels stale if HN reader compares against `node --test tests/*.test.js`.

**Suggested redline:**
> Bump to "3,900+" once Craig is ready to commit to a number that may need re-bumping in 2 months. Otherwise leave 3,500+ as a conservative floor.

---

### 3.16 `website/app/wp/page.tsx:165` — "94-module"

```
165: — the same 94-module QA gate developers use on their codebases.
```

**Risk:** Yet another drift number. Mathematically there's been a 67 → 90 → 91 → 94 → 101 → 102 number drift on the same website.

**Suggested redline:**
> Update to current count or pin to constant.

---

### 3.17 `website/app/stack/page.tsx:143` — "101 modules covering"

```
143: "QA + security audit for your codebase OR your live website. 101 modules covering security..."
```

**Risk:** Close to 102 but still off-by-1.

**Suggested redline:**
> 102.

---

### 3.18 `website/app/components/Pricing.tsx:34,61,81` — "All 90 modules"

```
34: modules: "All 90 modules",
61: modules: "All 90 + depth review",
81: modules: "All 90 + nuclear stack",
```

This is what Stripe checkout shows the buyer immediately before they pay. The number must match what they actually receive.

**Suggested redline:**
> Update to 102 (or whatever Craig picks as the advertised count).

---

### 3.19 `website/app/api/checkout/route.ts:51` — "All 90 modules" in Stripe metadata description

```
51: "All 90 modules — security, supply chain, auth, CI hardening, AI review, and more. AI auto-fix PR included."
```

**Risk:** This text flows into Stripe receipt + invoice. The number a customer sees on their Stripe receipt should match what they paid for. Receipt-drift is the easiest false-advertising fact pattern.

**Suggested redline:**
> Update to current count.

---

### 3.20 `website/app/api/scan/preview/route.ts:289` — "Upgrade to Full ($99) to scan all 90 modules"

Same — customer-facing API response, must match.

---

### 3.21 `website/app/admin/AdminPanel.tsx:594` — "Full (90 modules)" dropdown

Internal admin panel, lower stakes — but the admin sees what they sell to customers.

---

### 3.22 `website/app/api/badge/route.ts:7` — comment says `"GateTest | 90 modules" badge`

Customer-facing SVG badge if embedded in customer READMEs. Badge text in code matches the doc comment.

---

### 3.23 `website/app/scan/status/page.tsx:588-589` — "Passed the Quick Scan. Want to go deeper with all 90 modules?"

Renders mid-scan-flow. Update to actual count.

---

### 3.24 `website/app/for/nextjs/page.tsx:186,313` — "90 modules"

Update.

---

### 3.25 `website/app/components/Install.tsx:17` — "the same 90 modules"

Unrendered file but ships in repo.

---

### 3.26 `docs/proofs/phase-1-self-scan.md` — `quick` suite is "39 modules" claim

```
docs/proofs/phase-1-self-scan.md:6: **Suite:** `quick` (39 modules)
```

**Risk:** Actual `quick` suite content needs verification — CLAUDE.md mentions the quick suite is 4 modules, but the self-scan ran 39. This means either (a) the quick suite is bigger than advertised, or (b) the proof doc's "39 modules" is the universal-checker fanout count, not the suite count. Either way, "Quick Scan = 4 modules" in `Pricing.tsx` is mathematically inconsistent with the proof doc.

**Suggested redline:**
> Reconcile: either change Pricing.tsx Quick description to "core 4 modules plus universal-checker fanout (39 effective scanners)", OR clarify the proof doc.

---

### 3.27 README.md license badge color

```
README.md:11: [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
```

Matches LICENSE — verified.

---

## Severity 4 — tone / positioning

### 4.1 `MARKETING.md:11` — "AI writes fast. GateTest keeps it honest."

Tagline appears in 6+ places. "Keeps it honest" is a value-of-the-product claim that lawyers usually let through — but a B2B buyer in a banking / health / government vertical will read "honest" as a representation the product can certify. Soft pass; consider for enterprise tracks.

---

### 4.2 `website/app/components/HomeKills.tsx:41` — Section heading "What it kills"

```
41: What it kills
```

**Risk:** Bible internal voice ("GateTest kills SonarQube") translated to public copy in a softer form. "What it kills" is still aggressive — works on HN, less well on a CFO's procurement screen.

**Suggested redline:**
> "What it replaces." Same point, calmer register.

---

### 4.3 `website/app/components/HomeKills.tsx:43-46` — "Twelve tools. One config. One bill."

```
44: Twelve tools. <span className="gradient-text">One config.</span>
46: One bill.
```

Functional, low-risk. Tone OK.

---

### 4.4 `MARKETING.md:96` — "80-90% ahead of any single competitor"

Already covered in Sev 1.2.

---

### 4.5 `MARKETING.md:243-247` — Brand voice ("zero-bullshit", "short sentences", "direct")

```
243: - Confident but not arrogant
244: - Technical but accessible
245: - Zero-bullshit — say what it does, not what it "empowers" or "leverages"
```

Reflects internal voice. "Zero-bullshit" risks being seen as immature on a Fortune-500 sales call. Soft pass.

---

### 4.6 `website/app/components/HomeFaq.tsx:34` — "5% of fixes" claim

```
34: Claude only enters when the deterministic layers can't resolve a finding (roughly 5% of fixes).
```

**Risk:** Specific number — if a customer's experience is 50%, they cite this. The number isn't substantiated in `docs/proofs/`.

**Suggested redline:**
> "Claude only enters when the deterministic layers can't resolve a finding — typically a small minority of fixes on a mature codebase."

---

### 4.7 `HomeFlywheel.tsx:33,42,50,62` — specific layer percentages (47% / 22% / 16% / 5%)

```
33: share: "~47%",  (AST)
42: share: "~22%",  (Rule)
50: share: "~16%",  (Recipe)
62: share: "~5%",   (Claude)
```

**Risk:** Specific percentages displayed on the homepage. Same concern as 4.6 but four times over. Footnote at line 185 says "derived from our own self-scan + the four real-repo proofs" — but the proof docs don't break down by layer percentage.

**Suggested redline:**
> Either ship the methodology that derives 47/22/16/5, OR replace with directional claims ("AST handles most simple fixes, Claude handles the novel ones").

---

### 4.8 `website/app/web/page.tsx:158` — "kills features silently"

```
158: pain: "A 404 on a critical script kills features silently."
```

Use of "kills" here is metaphorical and customer-facing about THEIR site's behaviour. Low risk.

---

### 4.9 `website/app/wp/page.tsx:116` — "nothing kills trust faster"

Metaphor only, low risk.

---

## Severity 5 — informational

### 5.1 Trademark symbols on competitor names

```
SonarQube — appears 50+ times across copy with no ®
Snyk — appears 30+ times with no ™ / ®
ESLint — appears 20+ times with no ™
Cypress — appears 5+ times with no ®
Lighthouse, axe, pa11y, Percy, Chromatic — appear with no symbols
DeepSource — appears 15+ times with no ™
SonarQube® and Snyk® are registered marks.
```

**Risk:** Most jurisdictions don't require ® on every mention. The conservative practice is "first mention on a page gets ®, subsequent don't." Modern web copy often skips this entirely. Flagging for attorney review only.

**Suggested redline:**
> Defer to attorney. If they want belt-and-suspenders: add `®` on first mention per page for SonarQube, Snyk, DeepSource, BrowserStack. Cypress is a registered trademark too.

---

### 5.2 Email addresses

`hello@gatetest.ai` referenced 20+ times. Verify Craig has email forwarding configured before launch — a marketplace listing with an unanswered support email is reputation damage. CLAUDE.md "Pre-Launch" checklist mentions "Email forwarding set up for hello@gatetest.ai" — confirm done.

---

### 5.3 `docs/marketplace/listing-draft.md:113` — "Live chat at https://gatetest.ai. No email support intake (per Craig's directive)."

```
113: Live chat at https://gatetest.ai. No email support intake (per Craig's directive).
```

Conflicts with the 20+ `hello@gatetest.ai` mentions elsewhere. Pick one model and apply it consistently.

---

### 5.4 `website/app/page.tsx:18-22` — dropped components list

The comment lists components that are "intentionally dropped" but left in the codebase: Problem / AiNative / HowItWorks / Modules / Install / Comparison / Integrations / ContinuousScanning / GateRules / Cta. These all carry stale numbers + risky claims. Worth a sweep to delete or move to `_archive/`.

---

### 5.5 `MARKETING.md` ships in repo root and is public-visible

This file's voice is "internal investor pitch" (revenue math, $5K MRR targets, "killer feature" language). Visitors browsing the repo will read it as customer-facing. Either move to `docs/internal/` or relabel.

---

### 5.6 README.md mentions "gatetest.ai/web" and "gatetest.ai/wp" — verify both routes work

Both routes exist at `website/app/web/page.tsx` and `website/app/wp/page.tsx` — verified. Good.

---

### 5.7 README badges include "Modules: 91" and "Tests: 3500+"

shields.io badge URLs encode the values directly in the URL. When Craig bumps the numbers, update both.

---

## Notes for Craig

1. **Module-count drift is the single biggest cleanup item.** A user landing from a Google snippet, clicking through a Twitter card, and reading the Hero badge will see three different numbers from one product visit. Worse: the Stripe receipt description will say "All 90 modules" while the live `gatetest --list` shows 102. Pin a single source of truth — `modules-data.ts:totalModuleCount()` already exists — and reference it everywhere.

2. **`docs/GITHUB-MARKETPLACE-LISTING.md:88-92` (fabricated testimonials) is the highest legal risk in the repo.** Delete before publishing to Marketplace. This is non-negotiable.

3. **Compare pages are well-structured but make specific claims about competitors that competitors can challenge.** The Snyk page in particular is exposed — "Snyk only scans dependencies" is factually wrong (Snyk Code is SAST). Recommend a comparative-claims audit by an IP attorney before flipping Marketplace.

4. **WCAG 2.2 AAA is over-claimed in 10+ places.** Automated tools cannot certify WCAG conformance at any level — this is a settled W3C position. The current copy creates customer expectations our scanner cannot meet and a plaintiff's reliance evidence for ADA / Unruh / EAA suits.

5. **`MonsterMoves.tsx` and `GATECODE.md` are stale unrendered/unrelated files in the repo.** Delete them before launch — they're easy ammunition for any "let's audit their repo for inconsistencies" tour.

6. **Aggressive language from the Bible ("kills") has bled into one section header.** Most of the public copy has already been softened (compare to MARKETING.md which still says "GateTest kills SonarQube"). One more pass to bring the public-facing voice in line with B2B-buyer expectations is worth doing.

7. **Honest limits sections in `README.md:191-201`, `how-it-works/page.tsx:11-18`, and the legal pages are excellent.** This is the kind of voice we should match across all public copy. The compare pages stray from it — bring them back.

---

End of redline.
