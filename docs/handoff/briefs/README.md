# Agent briefs in flight — re-issue from here

Written 2026-09-30 at the account switch (ccantynz → ccanty48co) so the next session can
continue without re-deriving anything. The briefs are the exact prompts the running agents
were given; the workflow file holds all of them.

## admin-resume-workflow.js

One workflow, two tracks, run as `wf_e964ad89-f8f` in the ccantynz session:

- **Repair track** (pipeline: build → adversarial review → fix), four jobs, each in its own
  worktree:
  | key | worktree | branch | snapshot on origin |
  |---|---|---|---|
  | corpus | C:/dev/crclabs-hq/GateTest-wt-apollo | fix/corpus-apollo-regression | wip/fix/corpus-apollo-regression |
  | security | C:/dev/crclabs-hq/GateTest-wt-admin-sec | fix/admin-auth-and-heal-guard | wip/fix/admin-auth-and-heal-guard (2 commits: 0deecc8b, 9389f31b) |
  | autofix | C:/dev/crclabs-hq/GateTest-wt-admin-autofix | fix/admin-repo-scan-honest | wip/fix/admin-repo-scan-honest |
  | secrets-ui | C:/dev/crclabs-hq/GateTest-wt-secrets-ui | feat/admin-secrets-panel (PR #847) | wip/feat/admin-secrets-panel |
- **Design track**: 3 designers (lenses A cockpit / B editorial / C entity-first, model
  fable) → 3 judges (owner / customer / engineering) → synthesis → completeness critic →
  revision. Inputs: docs/admin-audit/01-measure.md, 02-benchmark.md. Outputs:
  docs/admin-audit/designer-{a,b,c}/{spec.md,mock.html}, 05-synthesis.md, mock-final.html.
  (The running copy writes to the ccantynz session scratchpad
  `C:/Users/ccant/AppData/Local/Temp/claude/C--dev-crclabs-hq/4973dda3-06f4-4a4c-b87c-0b7e9776a401/scratchpad/admin-audit/`
  — copy anything found there into docs/admin-audit before re-running.)

## How to resume in a new session

1. Check what already landed: `gh pr list --state all --limit 20`,
   `git ls-remote --heads origin 'wip/*' 'fix/*' 'feat/admin*'`.
2. For each repair job: if its worktree still exists on this PC, `git -C <worktree> status`
   shows the agent's last state; otherwise restore with
   `git worktree add <worktree> -B <branch> origin/wip/<branch>`. A job whose PR is merged is
   done — drop it from the JOBS array.
3. Copy any design outputs from the scratchpad path above into docs/admin-audit, delete from
   the DESIGNERS array any designer whose spec.md + mock.html already exist, and adjust the
   design track to read existing ones.
4. Run `Workflow({scriptPath: "docs/handoff/briefs/admin-resume-workflow.js"})` (SP already
   points at docs/admin-audit). Workflow resume ids do not carry across sessions — start fresh.
5. After it finishes: render docs/admin-audit/mock-final.html in the browser (both themes,
   1440px and 390px, every link) before showing Craig the ranked first wave.
