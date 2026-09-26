# Cross-platform copy inventory — Gluecron / Tallrig / Vapron (2026-09-26)

Issue: crclabs-hq/GateTest#715. **This is a draft. Nothing here ships without
Craig's approval (Boss Rule #8), and any sentence naming Gluecron or Tallrig
still needs that platform's own agreement before merge.**

Scope searched: `website/app/**` (pages, components, blog, docs, legal),
`README.md`, `integrations/**/README*`, `integrations/marketplace/listing.md`,
`wordpress/**`, `editors/**`, npm package `description` fields. No
`wordpress/` or `editors/` directory exists in this repo.

Excluded per the brief: `tests/**`, internal `docs/**`, code identifiers,
env-var names, `website/app/legal/_facts.js` (sub-processor disclosure).
Also excluded here as **not customer-visible**: `website/app/admin/**`
(Craig/staff-only dashboard, behind `AdminLogin`), `website/app/lib/**` and
`website/app/api/**/route.ts` (implementation code — the ~700 remaining raw
hits from the grep sweep live here: variable/function names like
`gluecron-client.ts`, `tallrig-push-signature.js`, env var branches, etc.),
and source-code comments that never render to a user (flagged individually
below where a comment was the only hit in an otherwise-relevant file).

PR #720 (merged, 2026-09-23) already rewrote `/stack` and `HomeStack.tsx`'s
per-product cards to "sell each product alone, then better together" — this
pass does **not** redo that work. It found one leftover inconsistency inside
that same rewrite (item 1 below) plus three other components that carry the
identical old phrasing and were never brought in line with it.

---

## Changes applied

### 1. `website/app/components/HomeStack.tsx` (line 59)
**Rule: stands alone.**
The Gluecron card's own bullet three lines down already says *"Its own CI
gate runs on every push — nothing external required"* (written by #720's
rewrite) — but the tagline directly above it was never updated and still
carries the old, ambiguous phrasing that reads as GateTest's gate sitting on
Gluecron, exactly the pattern issue #715 exists to remove.

| Current | Proposed |
|---|---|
| `tagline: "Git hosting with the gate on every push."` | `tagline: "A git host, with its own CI gate."` |

### 2. `website/app/components/StackBar.tsx` (line 27)
**Rule: stands alone.**
Same ambiguous "the gate" phrasing as #1, in the footer cross-promo bar
component. The file's own header comment says *"Boss Rule #8 — brand copy.
All taglines are pending Craig's final sign-off; placeholders here are
conservative drafts"* — this brings the placeholder in line with the fix
already made elsewhere.

| Current | Proposed |
|---|---|
| `tagline: "Git hosting with the gate on every push."` | `tagline: "A git host, with its own CI gate."` |

### 3. `website/app/components/Footer.tsx` (line 71)
**Rule: stands alone.**

| Current | Proposed |
|---|---|
| `Gluecron — git hosting, gate built in` | `Gluecron — git hosting, with its own CI gate` |

### 4. `website/app/components/site-nav.ts` (lines 31 and 41)
**Rule: stands alone.**
Two entries, "Solutions" and "Ecosystem" nav groups, both with the same
ambiguity; "Solutions" also dropped the possessive "Our" (GateTest isn't
Gluecron's owner, they're sibling products sold separately).

| Location | Current | Proposed |
|---|---|---|
| Solutions > Gluecron | `"Our git host, with the gate built in."` | `"A git host, with its own CI gate."` |
| Ecosystem > Gluecron | `"Git hosting where every push is gated."` | `"A git host, with its own CI gate."` |

No test pins the old strings (`grep` of `tests/**` for the old phrasing
returned nothing), and `tests/public-copy-siblings.test.js` (added by #720)
does not cover these four files — it only guards `/stack` and `HomeStack`.
Worth a follow-up to widen that test's file list; not done here since it's a
test change, not a copy change, and out of this issue's stated scope.

---

## Found, flagged, no change made (owner discretion)

### `website/app/stack/page.tsx` — H1 title and `STEPS` array (lines 15, 27–31, 275–278)
`GateTest gates it. Gluecron hosts it. {PLATFORM_NAME} runs it.` and the
matching `STEPS` labels (`"GateTest gates it"`, `"Gluecron hosts it"`,
`"{PLATFORM_NAME} runs it"`).

This reads two ways: (a) three parallel, independent claims — GateTest gates
*your code*, Gluecron hosts *your git*, Tallrig runs *your jobs* — which is
consistent with "stands alone"; or (b) a chained claim that could be
misread the way the issue's original complaint was. Because PR #720 already
reviewed and shipped this exact page under Craig's eye three days ago and
chose to keep this line, I did not overwrite it unilaterally — flagging it
instead so Craig can confirm the phrasing was a deliberate keep, not a miss.
`website/app/components/site-nav.ts` line 43 ("How the stack fits" nav
description) repeats the same triad and carries the same flag.

### `website/app/components/SiblingProducts.tsx`
"GateTest pairs well with {PLATFORM_NAME} and Gluecron" / "Three small tools,
one loose family — use whichever you need." Already compliant — no "needs"
framing, explicit "use whichever you need." Not touched. One inconsistency
worth a owner decision: its Gluecron description ("Git hosting built for
small teams. No tickets, no politics.") differs from the placeholder used on
`/stack` and `HomeStack` (`[GLUECRON: pending their words]`) — this component
predates the #140 placeholder convention. Left as-is rather than guessing
new Gluecron copy.

### `website/app/components/HomeTrust.tsx`
"GateTest currently protects {PLATFORM_NAME} and Gluecron.com as a CI gate."
This is a dogfooding proof point, verified true per `CLAUDE.md` PROTECTED
PLATFORMS (Gluecron's real integration is a bespoke webhook that does call
GateTest as its gate) — it says what GateTest does *for* them, not that they
need it to function. Left as compliant.

### Legal pages — Terms, DPA, Privacy
(`website/app/legal/terms/terms-content.ts`, `terms-content-2.ts`,
`terms-facts.ts`, `legal/dpa/dpa-content.ts`, `dpa-content-2.ts`,
`legal/privacy/privacy-content.ts`, `privacy-content-2.ts`,
`privacy-vendors.ts`)
All mentions are factual/technical descriptions of how the Gluecron
integration works for data-processing and contract purposes ("Git Host — a
service that hosts your repositories... currently GitHub and Gluecron",
"Gluecron sends us push events, we read the repository to scan it..."). No
dependency or "needs" framing. Legal accuracy outranks brand styling here;
left unchanged.

### Compare pages
(`website/app/compare/github-code-scanning/page.tsx`,
`website/app/compare/codeql/page.tsx`)
"It supports GitHub natively and Gluecron via the Signal Bus", "works with
any GitHub repository... as well as Gluecron-hosted repos." These describe
GateTest's own multi-host support, not a claim about Gluecron. Compliant,
left unchanged.

### `website/app/how-it-works/page.tsx`, `how-it-works/layout.tsx`, `page.tsx` (homepage), `Pricing.tsx`, `HeroScanTabs.tsx`, `UsageMeter.tsx`, `components/howitworks/ArchitectureDiagram.tsx`
All factual/functional copy ("Dual-host: GitHub App webhook and Gluecron
Signal Bus", "GitHub or Gluecron. Public repos scan free.", an SEO keyword
"Gluecron integration", a form placeholder "Enter a public GitHub or Gluecron
repo URL."). No dependency framing. Left unchanged.

### `website/app/data/changelog.json`
Generated, dated commit history mentioning Gluecron/Tallrig in PR titles
(e.g. "fix(secrets): four false positives from a real customer scan
(Gluecron)"). This is dated evidence — the Sync Rule's own carve-out
("Never rewrite dated evidence") applies. Left unchanged.

### `integrations/gluecron/README.md`, `integrations/README.md`, root `README.md`
Developer-facing technical documentation for the bridge/adapter (env vars,
endpoints, host-selection precedence) and one forensic-scan citation
("Forensic scan of Gluecron.com — 649 errors..."). Host-neutral where it
matters ("How it picks between GitHub & Gluecron"), no "needs" framing, no
Vapron. Left unchanged.

### `integrations/github-actions/gatetest-gate.yml`
Comments reference "Vapron's copy of this workflow (found during the
2026-07-20 audit)" and an example org name `vapron-ai`. These are dated
historical comments describing what was true at audit time (before the
2026-09-14 rename) — rewriting them falsifies the record, per the same
"never rewrite dated evidence" principle. Not customer-facing prose either
way (YAML comments). Left unchanged.

### Code comments only (no rendered copy)
`website/app/components/url-scan-flow-cards.tsx` ("Tallrig correction"),
`website/app/badge/[owner]/[repo]/route.ts`, `website/app/api/mcp/route.ts`,
`website/app/api/watches/tick/route.ts`, `website/app/testing/arena-fetch.ts`
— each has exactly one hit and it is a source comment, not user-visible text.
No change.

### npm package descriptions
`package.json`, `packages/mcp-remote/package.json`,
`packages/mcp-server/package.json`, `vscode-extension/package.json` — none
mention Gluecron, Tallrig, or Vapron. Nothing to change.

### `integrations/marketplace/listing.md`
No mentions found. Nothing to change.

---

## Not in scope of this pass

`website/app/admin/**` (10+ files: `PlatformSiblings.tsx`,
`OverviewDashboard.tsx`, `admin/health/page.tsx`,
`admin/integrations/tallrig/page.tsx`, tabs) — internal, staff-only dashboard
behind `AdminLogin`, not customer-visible. `website/app/lib/**` and
`website/app/api/**/route.ts` — implementation code (client/adapter modules,
env var names, route handlers); the bulk of the ~870 raw grep hits live here
and are code identifiers, excluded per the brief. `integrations/smoke/empire-smoke.js`
— internal smoke-test tooling, comments only, excluded as a test-adjacent
script.
