export const meta = {
  name: 'gatetest-admin-resume',
  description: 'Resume the interrupted GateTest repairs (corpus, admin security, repo-scan autofix, secrets panel) with adversarial review, and run the admin design round (3 designers, 3 judges, synthesis, critic)',
  phases: [
    { title: 'Build', detail: 'four repair builders in their own worktrees' },
    { title: 'Review', detail: 'adversarial reviewer per PR' },
    { title: 'Fix', detail: 'address blocking review findings' },
    { title: 'Design', detail: 'three independent designers (lenses A/B/C)', model: 'fable' },
    { title: 'Judge', detail: 'owner / customer / engineering judges score all three' },
    { title: 'Synthesize', detail: 'one design system, IA and ranked first wave' },
    { title: 'Critique', detail: 'completeness critic, then revision' },
  ],
}

const SP = "C:/dev/crclabs-hq/GateTest/docs/admin-audit" // audit inputs/outputs live in the repo (was a session scratchpad)
const COMMON = `You are working on crclabs-hq/GateTest. Rules: never edit C:/dev/crclabs-hq/GateTest (the main checkout); work only in the worktree named below; never use bare \`git stash\`; merge, never rebase or force-push; commits end with the line \`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\`; PR bodies end with \`🤖 Generated with [Claude Code](https://claude.com/claude-code)\`; never \`gh pr merge --admin\`; if any permission is denied, stop and report it. Node_modules junctions: from PowerShell \`cmd /c mklink /J node_modules C:\\dev\\crclabs-hq\\GateTest\\node_modules\` (and website\\node_modules) if missing. Run tests with \`node scripts/run-tests.js <files>\` and REPORT pass / fail / SKIPPED counts (a skipped file hides regressions). One heavy test run at a time — the owner's PC is shared. Never print or commit a secret value. No vendor or model names in user-visible copy. No red/orange/amber/yellow Tailwind hue classes in any file you touch (owner design rule).`

const BUILD_SCHEMA = { type: 'object', properties: {
  pr_urls: { type: 'array', items: { type: 'string' } },
  branch: { type: 'string' }, worktree: { type: 'string' },
  summary: { type: 'string' }, tests: { type: 'string' }, unverified: { type: 'string' },
  blocked: { type: 'string' } }, required: ['pr_urls', 'summary', 'tests'] }
const REVIEW_SCHEMA = { type: 'object', properties: {
  blocking: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, issue: { type: 'string' }, evidence: { type: 'string' } }, required: ['issue'] } },
  non_blocking: { type: 'array', items: { type: 'string' } },
  verdict: { type: 'string', enum: ['approve', 'changes-needed'] } }, required: ['blocking', 'verdict'] }

const JOBS = [
  { key: 'corpus', worktree: 'C:/dev/crclabs-hq/GateTest-wt-apollo', prompt: `${COMMON}
WORKTREE: C:/dev/crclabs-hq/GateTest-wt-apollo (branch fix/corpus-apollo-regression, based on origin/main cb26ff38). MAIN IS RED: CI job "real repos must not be blocked" (workflow "Reliability Corpus (false-positive gate)", runs 36602008548, 36604845519) fails — apollo-server has 2 blocking findings, ceiling 0. Every open PR inherits this red check. A previous builder died mid-task (usage limit) and left UNCOMMITTED work in src/core/confidence.js, src/core/test-paths.js, src/modules/security.js, tests/confidence.test.js, tests/test-path-canonical.test.js. First \`git fetch origin && git merge origin/main\`, then read \`git diff\` and judge that work: keep it if correct, fix or discard it if not.
A kept clone of apollo-server at the pinned sha may exist under %TEMP%/gt-realworld-*/apollo-server (look for the newest); otherwise run \`node scripts/real-world-precision.js --repo apollo-server --keep\` to get one. Read scripts/real-world-precision.js for exactly how the engine is invoked (suite, flags, how "blocking" is counted) so you reproduce CI. List the 2 blocking findings (module, rule, file:line, message). Today's suspects: #843 (source-strip string-at-line-end, security CSRF shapes, featureFlag, performance SW, promptSafety severity), #844 (a11y lines/collapse, secrets line), #846 (authBypass client calls + python routes, placeholders, dev-tools, REPORT_ONLY). Bisect by checking out the module from 0ae1e2bc into a scratch copy if needed.
Fix the RULE, never the ceiling (doctrine #2). Control pair: the exact apollo-server line(s) as a quiet fixture in the module's tests + the positive case the original change exists for still fires (keep the DavenRoe #842 tests green). Prove the quiet case fails on the pre-fix module. Verify: \`node scripts/real-world-precision.js --repo apollo-server\` → 0 blocking; then the WHOLE corpus once (\`node scripts/real-world-precision.js\`, ~20 min) → REAL-WORLD PRECISION GATE: PASSED (no --ratchet). Also the module's tests + tests/precision-per-rule.test.js + tests/corpus-*.test.js, \`npm run lint\`, \`GATETEST_NO_TELEMETRY=1 node bin/gatetest.js --suite quick --parallel\`. Commit with the measurement in the message, push, \`gh pr create --body-file\` (title starts "fix(corpus):"), \`gh pr merge <n> --auto --merge\`. Report the 2 findings, which merge caused them and why, the fix, control-pair old/new, corpus result.` },

  { key: 'security', worktree: 'C:/dev/crclabs-hq/GateTest-wt-admin-sec', prompt: `${COMMON}
WORKTREE: C:/dev/crclabs-hq/GateTest-wt-admin-sec (branch fix/admin-auth-and-heal-guard, clean, based on origin/main; \`git fetch origin && git merge origin/main\` first). SECURITY FIXES found by today's admin audit (code on origin/main cb26ff38 — re-verify each before changing). Do not touch website/app/admin/secrets/** or website/app/admin/tabs/RepoScanTab.tsx / useAutoFix.ts / FixResultCard.tsx / website/app/components/LiveScanTerminal.tsx (other builders own them). Never probe production with forged requests; verify by code and tests only.
A. Presence-only admin checks: website/app/api/admin/hn-launch/poll/route.ts:78-81, hn-launch/draft/route.ts:35-38, seo/submit/route.ts:43-46 define isAdminRequest as \`Boolean(req.cookies.get("gatetest_admin")?.value)\` — ANY request with a cookie of that name passes (the real admin cookie is gt_admin, so the owner is locked out). These call paid AI/external APIs. Create ONE helper website/app/lib/admin-guard.ts \`requireAdminRoute(req, {mutating})\` → NextResponse(401/403, no-store) | null, using isAdminRequest (lib/admin-auth.ts) OR getAdminLoginFromCookies (lib/admin-session), plus a same-origin check on mutating methods. Make website/app/lib/secrets/http.ts requireAdmin delegate to it (no behaviour change).
B. website/app/api/admin/github-profiles/route.ts:21-22 authenticates with the PLAINTEXT admin password in an x-admin-password header, and website/app/admin/tabs/AccountsTab.tsx:13 reads a cookie gatetest_admin via document.cookie (the real cookie is HttpOnly gt_admin) → every call 401s and the tab says "No GitHub accounts connected yet". Move the route to requireAdminRoute, drop the header path; AccountsTab uses same-origin fetch, handles non-OK honestly (error state, never "none"), confirm-by-typing on Remove.
C. Switch EVERY admin API route (grep website/app/api/admin/** and other admin-only routes such as api/watches, api/db/init, api/admin/overview/stats/keys/platforms/platform-siblings/integrations/tallrig/feedback/compliance/triage/triage/pipeline/fleet-intelligence/watchdog/briefing/pipeline-trace/stream/learning/build-status/health/audit-log/repos) from inline copies (checkPwCookie, local isAdminRequest, "same two-method check") to requireAdminRoute, behaviour-preserving for the real owner. Add tests/admin-route-guard.test.js: every route file under website/app/api/admin/** imports requireAdminRoute (explicit allowlist with reasons, e.g. the login route), and no file under website/app contains \`cookies.get("gatetest_admin")\` or \`x-admin-password\`.
D. website/app/api/heal/ssh/route.ts runs sudo playbooks on GATETEST_SSH_HOST always (body host ignored by design), but website/app/admin/tabs/NuclearScanTab.tsx:51-58 calls it after scanning ANY domain → "Fix Everything" runs playbooks on our own production box and can report "Server Healed". Route: require the request's hostname to be in GATETEST_SSH_HOSTNAMES (comma list); unset → 409 {error:"target_not_configured"}; mismatch → 409 {error:"target_mismatch"}; never connect in either case. Tab: only offer SSH heal when the scanned hostname is allowed (dry-run answer from the route), else template fixes only, saying why. Remove the playbook steps that start/restart/enable caddy, nginx or run certbot (~lines 73-94) — CLAUDE.md deployment doctrine bans those proxies on this platform; keep read-only diagnostics and the app's own unit restart. Add GATETEST_SSH_HOSTNAMES to website/.env.example and website/app/lib/env-catalogue.js with a why. Tests: mismatch → 409 and no SSH connect (inject the client), unset → 409, match → proceeds, playbook has no caddy/nginx/certbot mutation.
E. website/app/api/scan/nuclear, scan/server, scan/guidance: a grep showed no auth, payment or rate-limit reference. Read them fully. If any does paid-tier or AI-costing work for an anonymous caller without payment verification, rate limit, or the daily API budget (GATETEST_DAILY_API_BUDGET_USD — CLAUDE.md usage doctrine meter 3), gate it the way paid scan routes do (see how /api/scan/run verifies payment/admin) with a test; if intentionally public and cheap, add a code comment saying why. Report each.
Run your tests + tests/signin-gate.test.js tests/admin-secrets-wiring.test.js tests/route-grammar.test.js tests/status-readiness-honesty.test.js; \`cd website && npx tsc --noEmit -p .\`; root \`npm run lint\`; \`cd website && npx eslint <touched>\`; quick self-scan last. Commit per item, push, PR titled "fix(admin-security): ...", \`gh pr merge <n> --auto --merge\`. Report per item A–E what you found and changed (file:line).` },

  { key: 'autofix', worktree: 'C:/dev/crclabs-hq/GateTest-wt-admin-autofix', prompt: `${COMMON}
WORKTREE: create it — from C:/dev/crclabs-hq/GateTest-wt-admin-sec run \`git fetch origin && git worktree add C:/dev/crclabs-hq/GateTest-wt-admin-autofix -b fix/admin-repo-scan-honest origin/main\`, then work only there. Files you own: website/app/admin/tabs/RepoScanTab.tsx, useAutoFix.ts, FixResultCard.tsx, ModuleResults.tsx, website/app/components/LiveScanTerminal.tsx (and their tests). Admin audit findings (origin/main cb26ff38): (1) RepoScanTab.tsx:153-166 starts auto-fix automatically after every completed scan — it writes PRs to the scanned repo unasked; fixes go in 5-file batches, /api/scan/fix makes a branch/PR per request, and useAutoFix.ts:167 keeps only the last prUrl. Make fixing an explicit button, collect and show every PR url. (2) LiveScanTerminal.tsx:78 never checks res.ok — a 500 {status:"failed"} renders "GATE: PASSED" and the tab shows "All Clear"; fix to show failed with the reason. (3) useAutoFix.ts:162 never checks res.ok — a 500 marks every file "done" and ends "Fix partially completed"; show failures per file. (4) The terminal prints fake "running on the engine" progress on a timer with a wrong module list (quick tier is 4 modules — read website/app/lib/checkout-tiers.ts); stop presenting timed text as engine progress (label it as waiting, or show real progress if the API streams it). (5) "Quick (41 modules)" label at RepoScanTab.tsx:129 — derive counts from checkout-tiers, never type them. (6) copyIssues reports success through the red error line (:74-78); loadGuidance ignores res.ok (:92-93); the <select> has no label (:124); fixIssues/retryFailedFiles duplicate one loop — unify. Tests for each (source-level + pure logic). Run them + tests/admin-*.test.js relevant files; tsc; lint; eslint on touched; quick self-scan last. Push, PR titled "fix(admin): repo scan never writes unasked and never reports a failure as a pass", auto-merge.` },

  { key: 'secrets-ui', worktree: 'C:/dev/crclabs-hq/GateTest-wt-secrets-ui', prompt: `${COMMON}
WORKTREE: C:/dev/crclabs-hq/GateTest-wt-secrets-ui (branch feat/admin-secrets-panel = PR #847). A previous builder died mid-task and left an UNCOMMITTED, half-finished split: SecretDialogs.tsx deleted and new AuditDrawer.tsx, DeleteDialog.tsx, PanelHeader.tsx, RevealDialog.tsx, SecretsTable.tsx, SetSecretDialog.tsx, StepUpDialog.tsx, errors.ts, with SecretsPanel.tsx modified. First \`git pull --no-rebase\` (remote is f24536a6) and \`git merge origin/main\`, then read the working tree, finish or correct the split. Required:
1. Per-file ceiling 500 lines (GateTest self-scan blocks >500 changed lines): every file under website/app/admin/secrets/** well under 500, no behaviour change from the split.
2. api.ts dead exports: Tier, SecretState, SecretSource, Liveness, ApplyState, ApplyOutcome, VerifyResult, ApplyResult, StepUpResult — drop \`export\` where only used in api.ts; if another file uses one, keep it exported and actually import it there.
3. tests/admin-secrets-panel.test.js:103 inline eslint-disable — restructure so no rule is disabled.
4. Audit fixes: (a) apply cannot recover from would_drop_keys — backend POST /api/admin/secrets/apply accepts {allowRemoving:[names]} and returns dropped?; add both to applySecrets()/ApplyResult, and on reason would_drop_keys show the names with a confirm that re-calls apply with allowRemoving; (b) out_of_sync is the NORMAL "store changed, not yet applied" state — render a neutral pending notice with Apply, never "Could not write the env file"; (c) the audit endpoint returns \`chain\` — show intact / broken at entry N / cannot tell in the drawer header, never default to intact; (d) verify audit rows (alive/dead/cannot-tell) styled by liveness, not as failures; (e) IPs in the audit drawer middle-truncated with full value in title.
5. Tests for 4a–d. Run tests/admin-secrets-panel.test.js tests/admin-secrets-wiring.test.js tests/admin-secrets-store.test.js tests/no-hardcoded-color-literals.test.js tests/design-system-compliance.test.js; \`cd website && npx tsc --noEmit -p .\`; root lint; website eslint on touched; quick self-scan last. Commit, push (no rebase).
6. Reply in each of these PR #847 review threads and resolve them: \`gh api -X POST repos/crclabs-hq/GateTest/pulls/847/comments/<id>/replies -f body=...\` — one line saying what changed, ending with the line \`_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_\`. Ids: 4136778139 (SecretDialogs size), 4136778167 (SecretsPanel size), 4136778192 (eslint-disable), 4136778210 Tier, 4136778223 SecretState, 4136778239 SecretSource, 4136778258 Liveness, 4136778270 ApplyState, 4136778282 ApplyOutcome, 4136778294 VerifyResult, 4136778313 ApplyResult, 4136778328 StepUpResult, 4136778344 (logic.js size: reply "informational — under the 500 ceiling; no change"). Resolve via GraphQL (reviewThreads(first:80){nodes{id comments(first:1){nodes{databaseId}}}} then resolveReviewThread). The "real repos must not be blocked" check is red from main (apollo-server) and is fixed elsewhere — do not touch it. Report file sizes, tests, threads resolved.` },
]

function reviewPrompt(job, built) {
  return `You are an adversarial code reviewer for crclabs-hq/GateTest. A builder claims to have finished this work: ${JSON.stringify({ key: job.key, pr_urls: built.pr_urls, summary: built.summary, tests: built.tests, unverified: built.unverified })}.
The original brief was:\n---\n${job.prompt}\n---\nYour job is to REFUTE that it is correct and complete. Read the actual PR diff(s) (\`gh pr diff <n>\`) and the touched files at the PR head. Check: every brief item done or explicitly and justifiably declined; correctness (logic, edge cases, error paths — especially any place a failure could still render as success); security (auth bypass, secret exposure, SSRF, CSRF, anything that lets an anonymous caller spend money or mutate state); tests actually exercise the change (control pairs, not vacuous; would they fail on the old code?); no behaviour regression for the real owner; no banned hue classes; doctrine (one definition, no ceiling raised, no --admin merges). Do not edit anything. Return blocking issues only for real defects with evidence (file:line and why); style nits go in non_blocking. verdict = approve only if there are zero blocking issues.`
}

function fixPrompt(job, built, review) {
  return `${COMMON}
WORKTREE: ${job.worktree}. You own this PR: ${built.pr_urls.join(', ')} (branch ${built.branch || 'see worktree'}). An adversarial reviewer found these BLOCKING issues:\n${JSON.stringify(review.blocking, null, 2)}\nFix each one on the same branch (merge origin/main first if behind; never rebase/force-push), add or adjust tests so each fix is proven, rerun the same checks as the original brief, commit, push. If you believe an issue is not real, say so with evidence instead of changing code. Original brief for reference:\n---\n${job.prompt}\n---\nReport per issue: fixed (how) or disputed (why), plus test results.`
}

async function repairTrack() {
  return pipeline(JOBS,
    job => agent(job.prompt, { label: `build:${job.key}`, phase: 'Build', schema: BUILD_SCHEMA }),
    (built, job) => {
      if (!built || !built.pr_urls || built.pr_urls.length === 0) return { built, review: null }
      return agent(reviewPrompt(job, built), { label: `review:${job.key}`, phase: 'Review', schema: REVIEW_SCHEMA })
        .then(review => ({ built, review }))
    },
    (res, job) => {
      if (!res || !res.review || res.review.verdict === 'approve' || res.review.blocking.length === 0) return { key: job.key, ...res, fix: null }
      return agent(fixPrompt(job, res.built, res.review), { label: `fix:${job.key}`, phase: 'Fix' })
        .then(fix => ({ key: job.key, ...res, fix }))
    },
  )
}

const CONSTRAINTS = `Owner constraints (non-negotiable):
- TWO themes, one clean white and one clean black, with IDENTICAL structure; the owner judges structure and craft, and a palette swap alone reads to him as "just changing colors" — craft must live in layout, hierarchy, type, density and interaction.
- NO red, orange or yellow anywhere. Severity by shape, fill, weight and label (blocker ■ weight 600, high ◆, medium ◐, low ○ muted, pass ● accent, not run = dashed outline). One accent hue (brand teal family), used sparingly. Primary buttons are ink.
- Typography: Geist (UI/body/headlines) + Geist Mono (SHAs, ids, numbers), weights 400–600.
- Every data panel has three states — ok / failed / cannot tell — and a failure never renders as empty, zero, "healthy" or green (the dominant defect today, ~20 places).
- No vendor or model names in user-visible copy.
Context: GateTest is a CI quality gate / code-scanning SaaS (122 static-analysis modules, GitHub App + Action, hosted site scans, fix PRs, MCP server, Stripe per-scan + subscriptions, self-hosted on one Linux box). This is its OWNER ADMIN console (Next.js 16 app router, website/app/admin, API under website/app/api/admin).
Inputs to read fully first: ${SP}/01-measure.md (every tab today, what is broken) and ${SP}/02-benchmark.md (table stakes, where to lead). You may read code read-only via \`git -C C:/dev/crclabs-hq/GateTest show origin/main:<path>\` (and origin/feat/admin-secrets-panel for the secrets UI). Do not edit any repository.`

const DELIVERABLE = (dir, extra) => `Deliver into ${SP}/${dir}/ (create the folder):
1. spec.md (≤1,800 words): (a) information architecture — the new nav (groups, contents, what merges or disappears, stable URLs for every view and entity page: customer, repo, scan, finding-by-fingerprint, rule, fix PR, secret, deploy); (b) the design system — tokens for both themes (ink levels, surfaces, lines, accent, focus), type scale, spacing and density modes, severity/status mark set, table craft, charts without hue, empty / failed / cannot-tell states, motion; (c) per area (overview, scans & findings incl. "what was not checked", watchdog, pipeline trace, triage, health & incidents, customers & revenue, keys & integrations, secrets, audit & compliance, learning/precision, launch prep) — the concrete upgrade per current tab and which 01-measure problems it removes; (d) global patterns: search / Cmd-K, keyboard map, saved views, deep links; (e) a FIRST WAVE of 8–12 small, independently shippable PRs in order, each with its proof (what a browser check and a journey test must show in both themes).
2. mock.html — ONE self-contained static HTML file (inline CSS/JS only, no external requests; \`font-family: Geist, ui-sans-serif, system-ui\` and \`"Geist Mono", ui-monospace\` stacks) with a nav switching three screens: Overview; a Scan detail (findings with severity marks, a finding's lifecycle across commits, and the "What was not checked" tab); a Customer page (timeline mixing payments, scans, gate blocks, fix PRs)${extra}. A visible toggle switches white ↔ black with identical structure. Clearly sample data (no real names/emails). Works at 1440px and 390px.
Return: the two paths, a 10-line summary of your IA and signature ideas, and your first-wave list.`

const DESIGNERS = [
  { id: 'A', dir: 'designer-a', lens: 'the operator cockpit — dense, fast, keyboard-first, like Datadog + Linear. The owner opens it many times a day to answer "is anything wrong, and what do I do next?"', extra: '' },
  { id: 'B', dir: 'designer-b', lens: 'calm editorial clarity — like the Stripe Dashboard at its best: few things per screen, each unmistakable, prose-quality labels, disciplined whitespace, numbers that explain themselves. The owner is a founder who wants to understand business and product health at a glance and act with confidence.', extra: '' },
  { id: 'C', dir: 'designer-c', lens: 'entity-first — like Sentry issue/release pages, Stripe\'s object inspector and PostHog\'s Cmd-K: everything is an object with a stable URL (customer, repo, scan, finding fingerprint, rule, fix PR, secret, deploy), reached by search, with a header, related objects and a timeline. Lists exist to lead to objects; the differentiators (finding lifecycle, what was not checked, precision per rule, fix-PR outcomes) are object pages.', extra: ', plus the Cmd-K palette open over one of them' },
]

const JUDGE_SCHEMA = { type: 'object', properties: {
  scores: { type: 'array', items: { type: 'object', properties: {
    designer: { type: 'string' }, ia: { type: 'number' }, craft: { type: 'number' }, honesty_states: { type: 'number' },
    constraint_violations: { type: 'array', items: { type: 'string' } }, strengths: { type: 'array', items: { type: 'string' } }, weaknesses: { type: 'array', items: { type: 'string' } } },
    required: ['designer', 'ia', 'craft', 'honesty_states', 'constraint_violations', 'strengths', 'weaknesses'] } },
  winner: { type: 'string' }, graft: { type: 'array', items: { type: 'string' } }, first_wave_opinion: { type: 'string' } },
  required: ['scores', 'winner', 'graft', 'first_wave_opinion'] }

const JUDGES = [
  { lens: 'OWNER', focus: 'You are judging as the owner, Craig: a founder who ships four products, reads this console many times a day, judges structure and craft (not palette), hates anything that looks finished while nothing happened, wants to dogfood and market his own products, and needs to act fast (refund, fix, deploy, rotate a secret) without hunting. Weight: clarity of "what is wrong and what do I do", speed to act, craft in both themes, trustworthiness of every number.' },
  { lens: 'CUSTOMER', focus: 'You are judging from the customers\' side: every admin screen exists so paying GateTest customers get faster, more honest outcomes — support answers, correct billing, fixed false positives, trustworthy scans. Weight: does the design make customer problems visible and resolvable (customer page, timeline, refunds/credits, feedback loop, precision per rule, what was not checked), and does it avoid exposing customer PII carelessly (masking, audit)?' },
  { lens: 'ENGINEERING', focus: 'You are judging as the engineer who must build it in this codebase (Next.js 16 app router, website/app/admin, existing API routes, tests via node:test, CI self-scan with a 500-line per-file ceiling). Weight: buildability as small gated PRs, reuse of existing data and routes, one definition per concept (status mark, relative time, fetch-with-res.ok, admin guard), accessibility (roles, focus, keyboard), performance (no N+1, no polling storms), testability (journey test + rendered check in both themes), and whether the first wave is sequenced so each PR ships value alone.' },
]

async function designTrack() {
  const designs = (await parallel(DESIGNERS.map(d => () =>
    agent(`You are Designer ${d.id} in an independent three-designer round for the GateTest owner admin console. Other designers work in parallel with different lenses; do NOT read ${SP}/designer-* folders other than your own.
YOUR LENS: ${d.lens}
${CONSTRAINTS}
${DELIVERABLE(d.dir, d.extra)}`, { label: `design:${d.id}`, phase: 'Design', model: 'fable' })
      .then(r => ({ id: d.id, dir: d.dir, report: r }))))).filter(Boolean)
  if (designs.length === 0) return { error: 'all designers failed' }
  log(`designs received: ${designs.map(x => x.id).join(', ')}`)

  const verdicts = (await parallel(JUDGES.map(j => () =>
    agent(`Judge panel for the GateTest owner admin redesign. ${j.focus}
${CONSTRAINTS}
Read all designs fully: ${designs.map(x => `${SP}/${x.dir}/spec.md and ${SP}/${x.dir}/mock.html (Designer ${x.id})`).join('; ')}. Read the mock HTML source carefully (structure, both themes, states, 390px behaviour). Score each designer 1–10 on ia, craft and honesty_states (three-state panels, failure never reads as success); list constraint violations precisely (any red/orange/yellow, structure differing between themes, vendor names, missing states); name the winner for your lens, the specific ideas to graft from the others, and your view of the right first wave. Be independent and specific; cite sections/elements.`, { label: `judge:${j.lens}`, phase: 'Judge', schema: JUDGE_SCHEMA })
      .then(v => ({ lens: j.lens, ...v }))))).filter(Boolean)

  const synth = await agent(`You are the synthesis designer for the GateTest owner admin redesign.
${CONSTRAINTS}
Designs: ${designs.map(x => `Designer ${x.id}: ${SP}/${x.dir}/spec.md + mock.html — summary: ${x.report}`).join('\n')}
Judge verdicts (owner / customer / engineering lenses): ${JSON.stringify(verdicts)}
Produce ONE design, starting from the design the judges favour overall and grafting the specific ideas they called out. Write:
1. ${SP}/05-synthesis.md (≤3,000 words): the final IA (nav groups, URLs, entity pages, what merges/disappears, how each current tab maps to its new home); the design system spec for BOTH themes with exact token values (hex), type scale, spacing, density modes, the severity/status mark set with exact glyph/shape/weight, table and chart craft, the three-state panel pattern (ok / failed / cannot tell) with copy rules, motion, focus, a11y; the shared component inventory (StatusMark, RelativeTime, fetchJson with res.ok, AdminGuard, EmptyState/FailedState/CannotTellState, DataTable, Timeline, CommandPalette, EntityHeader…); per-area upgrade plan tied to the 01-measure defects (every defect addressed or explicitly deferred with a reason); and a RANKED FIRST WAVE of 8–12 PRs — each with title, files it touches, what it removes from 01-measure, dependencies, and its proof (the rendered browser check in both themes + the journey test). Note the fixes already in flight as wave 0: admin auth consolidation + SSH heal guard + public scan gating (fix/admin-auth-and-heal-guard), repo-scan honesty (fix/admin-repo-scan-honest), secrets panel (#847), corpus fix.
2. ${SP}/mock-final.html — self-contained, same rules as the designer mocks (inline only, Geist stacks, white↔black toggle with identical structure, 1440px and 390px), showing: Overview, Scan detail (findings, lifecycle, What was not checked), Customer page, Secrets, and the Cmd-K palette.
Return: both paths and a 15-line summary (winner and why, grafts, first wave titles).`, { label: 'synthesis', phase: 'Synthesize' })

  const critique = await agent(`You are the completeness critic for the GateTest owner admin redesign. Read ${SP}/01-measure.md, ${SP}/02-benchmark.md, ${SP}/05-synthesis.md and ${SP}/mock-final.html.
${CONSTRAINTS}
Find what is missing or wrong: any 01-measure defect not addressed or not explicitly deferred; any constraint violation in the spec or the mock (grep the mock for red/orange/yellow colour values, compare the two themes' structure, check 390px CSS, check every data panel shows ok/failed/cannot-tell); any first-wave PR that is too big to ship alone, lacks a proof, or depends on something later; token values that fail WCAG AA contrast for text in either theme (compute them); missing entity URLs; security/PII issues (unmasked emails, secrets visible). Return a numbered list of concrete gaps with the fix for each; say "none" only if you truly find none.`, { label: 'critic', phase: 'Critique' })

  const revised = await agent(`You are the synthesis designer again. A completeness critic reviewed your work:\n${critique}\nApply every valid gap to ${SP}/05-synthesis.md and ${SP}/mock-final.html (edit in place). For any gap you reject, add a short "Critic items not adopted" section to 05-synthesis.md explaining why. Return a 10-line change summary and the final ranked first-wave titles.`, { label: 'revise', phase: 'Critique' })

  return { designs: designs.map(x => ({ id: x.id, dir: x.dir })), verdicts, synth, critique, revised }
}

const [repairs, design] = await parallel([() => repairTrack(), () => designTrack()])
return { repairs, design }