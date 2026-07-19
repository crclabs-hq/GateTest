# GateTest for VS Code (MVP)

Runs the free local **quick** gate (syntax, lint, hardcoded secrets, code
quality — the same 4 modules the free GitHub App install runs on every
push) directly in the editor. Findings show up as native diagnostics: red/
yellow squiggles on the offending line, entries in the Problems panel.

This is the free tier's IDE-native surface — it does not attempt to
replicate the paid 120-module scan, AI code review, or auto-fix PRs, which
remain a separate purchase at [gatetest.ai](https://gatetest.ai). See
`docs/COMPETITIVE-BENCHMARK.md` for what the full scan catches that this
free quick gate doesn't.

## Status: MVP, not yet published

This has not been submitted to the VS Code Marketplace — per the Bible's
Boss Rule, that's a distribution/publishing decision requiring Craig's
explicit go, same as the GitHub Marketplace listing. It's built and
runnable locally today; publishing is a separate step.

## Try it locally (F5 debug launch)

1. `cd editors/vscode && npm install` (pulls in `@gatetest/cli` from npm —
   until it's published, `npm link` the root package instead: from the repo
   root run `npm link`, then here run `npm link @gatetest/cli`).
2. Open this `editors/vscode/` folder in VS Code.
3. Press `F5` — this launches a new "Extension Development Host" window with
   the extension active.
4. In that new window, open any folder containing JS/TS source. The
   extension scans automatically on activation and on every file save.
   Findings appear in the Problems panel (`Ctrl+Shift+M` / `Cmd+Shift+M`) and
   as squiggles in the editor gutter.
5. Or run the command palette action **"GateTest: Scan Workspace (free
   quick gate)"** to trigger a scan manually.

## Architecture

- `extension.js` — the only file that imports `vscode`. Thin: wires
  commands/events, calls into `@gatetest/cli`'s programmatic API
  (`new GateTest(root).init().runSuite('quick')` — see `src/index.js` at
  the repo root), and converts the result into `vscode.Diagnostic`s.
- `lib/map-findings.js` — pure function, zero `vscode` dependency, so it's
  unit-testable with plain `node --test` (see
  `tests/vscode-map-findings.test.js` at the repo root). Converts a scan
  summary into a plain `Map<filePath, diagnostic[]>`; `extension.js` is the
  only place that touches the real `vscode.Diagnostic` constructor.

## Before publishing (tracked, not yet done)

- [ ] Extension icon (128×128 PNG) — `contributes.icon` in `package.json`
- [ ] Marketplace publisher account (`vsce publish` needs a Azure DevOps PAT)
- [ ] `@gatetest/cli` actually published to npm first (currently the CLI
      ships from this monorepo; the extension depends on the published
      package, not a relative path, so it works once installed standalone)
- [ ] Decide: scan-on-save always-on, or opt-in via a setting (some users
      may find scan-on-every-save noisy on large repos — worth a
      `gatetest.scanOnSave` boolean setting before wide release)
- [ ] Craig's go-ahead to submit to the VS Code Marketplace (Boss Rule)
