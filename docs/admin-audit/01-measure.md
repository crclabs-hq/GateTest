# GateTest admin audit — 01 measure (origin/main cb26ff38, 2026-09-30)

Two read-only scouts read every admin tab end to end (route → components → API → data source).
Paths relative to website/app/. Full coverage reported; not reached: api/admin/triage internals,
scan/nuclear|server|guidance bodies (security builder is reading them), lib/secrets/panel.js beyond
apply-state. Security defects (auth bypass, SSH heal target) are being fixed in a separate PR and
are listed here only for completeness.

## The shell and navigation today
- admin/layout.tsx gates on the cookie and wraps AdminShell. The sidebar has 9 links
  (AdminShell.tsx:16-26). /admin renders AdminPanel, which has a SECOND navigation: 9 in-page
  tabs in useState("scan") with no URLs, not in the sidebar; default tab is Repo Scan, not the
  dashboard (AdminPanel.tsx:23-33,61).
- Two token systems: admin.css `--gt-admin-*` (whose warning/danger are amber/red,
  admin.css:45-46,79-80,109-110) and the site's `var(--accent)` used by ui.tsx. ~108 lines use
  banned hues across 20 files; ~290 lines hard-code bg-white/gray; headings on white cards inherit
  the dark-theme foreground.
- No mobile layout (no width media queries; sidebar fixed 15.5rem, admin.css:131-133).
- Tabs lack role=tabpanel / aria-controls; ThemeToggle mixes role=radio + aria-pressed.
- Build status bar is real (build-info.json + GitHub compare) but flags "stale" after 24h even
  when the deployed commit equals main (admin-build-status.ts:121).

## Areas — job, data, what is broken
- **Overview** (OverviewDashboard.tsx, /api/admin/overview): "is the product healthy now?" Real
  data. False-OK: a missing AI key reads "present" (status renames the key; overview matches the
  raw name, admin-overview.ts:269,278); worker reads Healthy with no activity (:111,117); missing
  tables show real-looking zeros (:164-166); "Not ready" gives no reasons; no card links; stats
  bar duplicates numbers via a second query; "Revenue" = SUM(tier_price_usd) over all scans incl.
  failed — not Stripe money.
- **Recent scans** (ScansTab): last 50 scans; a stats failure reads "No scans recorded yet";
  badge counts all-time failures; no paging/filter/detail.
- **Repo scan** (RepoScanTab + useAutoFix + FixResultCard + LiveScanTerminal): failed scans read
  "PASSED" (res.ok never checked); fix errors read "done"; the terminal progress is fake
  (timer-printed lines, wrong module list); every scan auto-opens PRs in 5-file batches and only
  the last PR url is kept; "Quick (41 modules)" (real: 4). [fix in flight: PR 2 of the security
  builder]
- **Server scan** (ServerScanTab): 429/500 reads "No automated fixes available"; unlabeled input;
  snippet renderer duplicated with Forensic.
- **Forensic / nuclear** (NuclearScanTab): "Fix Everything" SSH-heals our own box for any domain
  [fix in flight]; Claude diagnosis branch unreachable (tier not passed); "SSH credentials not
  found" shown for any empty result; red #dc2626 button, ☢ emoji.
- **Watchdog** (WatchdogTab/Panel/Briefing): "Run Tick Now" always 401s (no bearer) yet alerts
  "Tick complete: checked undefined"; failed repo scans read "✓ No issues found"; DB failure
  reads "No watches yet"; briefing drops three stats; unbounded N+1 GitHub calls in /api/admin/repos.
- **Pipeline trace** (572-line page): live feed dies at 55 s (client closes instead of
  reconnecting) while showing "reconnecting"; DB unset shows a green live dot; scrollIntoView
  jumps the page; duplicate nav/`<main>`; feed duplicates Recent Scans.
- **Triage** (463-line page + FleetIntelligencePanel): fleet "table missing" note never shown
  (reads "No fleet data yet"); errors styled as empty; near-copy of pipeline-trace skeleton.
- **Health** (450 lines, 8 live checks): git-host check never rendered (UI expects id `github`,
  API returns `gluecron`) so a failure shows "1 Failure" with no red row; green button before any
  run; div-onClick rows; contradictory advice (/api/db/init is POST-only); own env list instead of
  env-catalogue; "Ready" defined differently from Overview.
- **Customers** (CustomersTab, 43 lines): who paid and how much; stats failure reads "No
  customers yet"; LIMIT 100 silently; no detail page, no Stripe link (stripe_customer_id fetched,
  unused), no refund/credit/email; two different revenue sources.
- **API keys** (KeysTab, 239): GET 503/500 → "Loading..." forever; POST getDb outside try;
  revoke ignores status and uses confirm(); no step-up to issue; no rotate/expiry/usage/customer
  link.
- **Platforms** (PlatformsTab + PlatformSiblings): list failure reads "No admin platforms
  registered yet"; add/remove no error handling; sibling with no healthy/overall field counted
  healthy; stale "vapron-ai" placeholder; help text points at Tallrig's secrets instead of ours;
  health widget styled for dark bg inside a light tab.
- **GitHub accounts** (AccountsTab): fully broken — every call 401 (wrong cookie, HttpOnly,
  route wants plaintext password) and reads "No GitHub accounts connected yet"; one-click red
  delete [fix in flight].
- **Tallrig integration events**: JSONL file in the app dir (may not survive a swap); read failure
  returns ok:true events:[] → "No push events recorded yet"; job.failed not highlighted.
- **Compliance**: controls list is a hard-coded constant marked in_place by assertion
  (compliance-status.ts:60-124); a thrown chain check returns ok:true → "✓ Hash chain intact"
  (:257-258); DB unset → 0 locked / 0 failed with no banner; evidence line says "Vercel edge
  enforces HTTPS"; /api/admin/audit-log CSV export exists but no page links it.
- **Feedback**: honest errors; scan_id fetched but not shown (no jump to the scan); no filters,
  no reply.
- **HN launch**: auth bypass/lockout [fix in flight]; polling effect restarts on every "Mark
  replied" and may draft again; dark-only orange/amber page.
- **Learning** (476 lines): status/trend failures dropped → "Modules tracked 0"; refresh errors
  shown in the green success box; copy says "red" while badges are amber; hard-coded bg-white.
- **Secrets** (branch, ~1,930 lines UI; backend on main): honest states, tokens only, modal
  a11y — the best area. Gaps: apply cannot recover from would_drop_keys; out_of_sync (normal
  pending state) shown as a write failure; audit hash-chain result ignored; verify rows styled as
  failures [all being fixed on #847].

## Cross-cutting
- The dominant defect class (as on Tallrig): a failure rendered as success/empty/zero/"healthy"
  — at least 20 places above. Every data panel needs three states: ok / failed / cannot tell.
- Duplication: status pill ~11 copies, relative-time formatter 5+4 copies, copy button 6 copies,
  Stat component 2, fetch without res.ok everywhere, admin auth check copied into ~12 routes
  [consolidation in flight].
- Scan tools live in four places (Repo scan, Watchdog, Triage source, Forensic); server scan in
  three; Recent Scans duplicated by the pipeline feed.
- The owner cannot, from admin: open a customer page (scans, keys, Stripe, timeline), refund /
  credit / email, see MRR or failed payments, see usage or AI spend per customer or key, run an
  incident, see releases/deploys beyond a raw event list, read one unified audit trail, or find
  anything by search.
