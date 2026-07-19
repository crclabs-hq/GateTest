# SOC 2 readiness — gap analysis

**Purpose:** hand this directly to whichever compliance vendor/auditor Craig
picks. It's grounded in what's actually true of this codebase as of
2026-07-19 (verified by reading the relevant source, not assumed) — not an
aspirational checklist. **This is prep work, not a SOC2 process** — actually
starting SOC2 requires Craig to pick a vendor and pay for it (Boss Rule: new
external cost/vendor). Nothing here substitutes for that.

## Recommendation: SOC 2 Type 1 first, not Type 2

Type 1 is a point-in-time review of control *design* — faster and cheaper,
and the credential most early-stage vendors ask for first. Type 2 requires
3-12 months of *operating* evidence and is the natural next step once Type 1
is in hand and there's a real customer base to justify the cost. Automated
compliance platforms (Vanta, Drata, Secureframe, Thoropass) have largely
replaced pure manual-auditor engagements for companies this size — they wire
into your cloud/GitHub/HR tools, continuously check controls, and hand you an
auditor at the end for a fraction of a traditional audit firm's cost and
timeline. Worth comparing 2-3 before committing; this doc doesn't pick one.

## What's already true (verified in code, 2026-07-19)

| Control | Evidence |
|---|---|
| Constant-time secret comparison everywhere signatures are checked | `crypto.timingSafeEqual` used consistently in `events-push.js`, `github-events.js`, `self-scan-status.js`, `slack-notifier.js`, `vapron-dispatch.js`, `admin-auth.ts` |
| Fail-closed webhook verification | Missing/invalid signature → 401, not silent accept (`stripe-webhook/route.ts`, `webhook/route.ts`) |
| Admin auth fails closed if misconfigured | `admin-auth.ts`: if `GATETEST_ADMIN_PASSWORD` is unset, all auth attempts fail — never accidentally open |
| Session cookies are httpOnly + secure + sameSite=lax | `admin-auth.ts` |
| No secrets committed to git history (spot-checked, not exhaustively audited) | `.gitignore` blanket `.env*` exclusion actually caught and blocked a real attempted commit tonight — the control works, not just documented |
| Rate limiting on customer-facing API routes | Present on `admin/keys`, `admin/repos`, `chat`, `checkout`, `dashboard`, `finding/dismiss`, `memory`, `notify`, `recipes`, `scan/fix` (grep-verified, not spot-checked individually) |
| Stripe handles cardholder data — PCI scope inherited, not owned | Card details never touch GateTest's own servers (Stripe Checkout) |
| Database encryption at rest | Inherited from Neon (Postgres provider) — a vendor guarantee, not something this codebase implements or controls |
| No in-memory state between requests (serverless) | Bible-mandated architecture rule, enforced by the stateless Vercel function model itself |
| BYOK path never logs/stores the customer's Anthropic key | Per-request only, per CLAUDE.md `## VERSION` |

## What's genuinely missing — policy/process, not code

SOC2 auditors care as much about *documented, followed process* as they do
about technical controls. None of the below can be fixed by editing source:

- **Formal written security policy** — access control policy, acceptable use,
  incident response plan, data retention/deletion policy. None of these
  exist as standalone documents today (the Bible/CLAUDE.md covers engineering
  practice, not a formal security policy an auditor recognizes as such).
- **Incident response plan** — who does what within what timeframe if there's
  a breach or suspected breach. Not written down anywhere.
- **Access control review cadence** — who has prod DB access, Stripe dashboard
  access, GitHub org admin, Vercel/hosting access, and how often that list
  gets reviewed and pruned. For a solo/small team this may genuinely be "just
  Craig," which is fine, but it needs to be *written down* as the policy, not
  implicit.
- **Vendor risk management** — a list of sub-processors (Stripe, Neon,
  Anthropic, Vercel/hosting, Resend) and what data each one touches. Most of
  this exists implicitly in `.env.example` and the architecture docs; it
  needs to be pulled into one auditor-facing document.
- **Employee/contractor onboarding-offboarding process** — background checks,
  device security requirements, access revocation on departure. Likely N/A at
  current headcount but auditors ask regardless; "N/A, solo founder" is a
  valid answer if written down as a policy, not left unaddressed.
- **Change management process** — how code gets reviewed/approved before
  production. Right now: direct pushes to `main` with an admin bypass on
  branch protection (confirmed tonight — pushes bypass "must go through a
  PR" and the required CI status check). This is a real, current gap an
  auditor will flag: SOC2 generally expects some documented review gate
  before production changes, even a lightweight one. Worth deciding
  deliberately (self-review + CI green is the policy, formally written down)
  rather than leaving it as an unstated practice.
- **Business continuity / disaster recovery plan** — what happens if Neon,
  Vercel, or the current hosting box goes down. Given the ROADMAP's own
  Known Issue #36 (site currently on ad-hoc Coolify hosting pending a Vapron
  cutover), this is presently a real, open gap, not just a documentation gap.

## Suggested order of operations

1. Pick a vendor (Vanta/Drata/Secureframe/Thoropass) — Craig, Boss Rule (new
   external cost).
2. Vendor's own onboarding will generate a real gap list from their
   automated checks — treat this document as a head start, not the final word.
3. Write the policy documents (access control, incident response, vendor
   list) — these are business decisions, not code; a session can draft first
   passes from what's true today if asked, but Craig owns the actual policy.
4. Decide the change-management story explicitly (even if it stays "direct
   push + CI green + self-review," write it down as the chosen policy).
5. Target Type 1 first; revisit Type 2 once there's a real customer base
   asking for it (SOC2 sales conversations are usually the trigger, not the
   other way around).
