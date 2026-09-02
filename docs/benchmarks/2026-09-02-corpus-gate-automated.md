# Corpus gate — automated, and what the first run found (2026-09-02)

**Engine:** GateTest v1.61.0, `--suite full --parallel`, skipping the four
modules that need the target's own toolchain or a browser (mutation, e2e,
unitTests, dataIntegrity). Same nine repos and SHAs as
`2026-09-01-corpus-nine-repos.md`. Run on Linux — that matters, see below.

The benchmark of 2026-09-01 was run by hand and referenced by nothing. It is
now `scripts/corpus-gate.js` + `.github/workflows/corpus-gate.yml`, blocking
on every PR, with per-repo baselines in `benchmarks/corpus/baselines/`.

## Before any fix (first automated run)

| Repo | Kind | Blocking | Warnings |
|---|---|---|---|
| express | clean | **2** | 81 |
| multer | clean | **1** | 49 |
| chalk | clean | **3** | 31 |
| fastify | clean | 6 | 180 |
| axios | clean | **20** | 277 |
| lodash | clean | 21 | 213 |
| dvna | vulnerable | 25 | 66 |
| nodegoat | vulnerable | 60 | 190 |
| juice-shop | vulnerable | 353 | 791 |

The 2026-09-01 record said express 0, multer 0, chalk 1, axios 7. **The
difference is the operating system.** Those runs were on Windows; every
regression below passed there and failed on Linux, which is what every CI
runner and every customer machine that matters actually is:

- `documentation`: `existsSync('README.md')` is true on a case-insensitive
  filesystem when the file is `Readme.md` (express) or `readme.md` (chalk).
- `bashSafety`: `dir.includes('/.git')` never matched a backslash path, so on
  Windows the exclusion was inert and on Linux it also swallowed `.github/`
  — no CI workflow was ever scanned on Linux, by anyone.
- `authBypass`: `file.includes('/api/')` never matched on Windows, so an
  Express app under `server/api/` was scanned there and skipped on Linux.
- `prSize`: a pinned checkout diffed against `origin/main` on a repo whose
  default branch is `v1.x` (axios) was sized as a 52,447-line pull request.

## After (baselines now committed)

| Repo | Kind | Blocking | What remains, itemised |
|---|---|---|---|
| express | clean | **0** | — |
| multer | clean | **0** | — |
| chalk | clean | **0** | — |
| fastify | clean | 3 | routes in a top-level `integration/` harness; `.catch(noop)` ×2 in lib/reply.js |
| axios | clean | 1 | one empty catch in lib/adapters/http.js |
| lodash | clean | 17 | 5 real devDependency CVEs; innerHTML + event-cleanup in the perf harness UI; 7 empty catches in lodash.js/perf.js |
| dvna | vulnerable | 24 | every planted class of 2026-09-01 still fires |
| nodegoat | vulnerable | 59 | every planted class still fires |
| juice-shop | vulnerable | 352 | every planted class still fires |

The one-finding drops on each vulnerable repo are `docs:readme-usage`, which
is now a warning (a README section is quality advice, not a build breaker —
Forbidden #25). No security class moved.

## The eleven precision fixes, each with a still-fires control

| Module | False positive | Fix | Control test |
|---|---|---|---|
| secrets | tracked `.npmrc` holding only `package-lock=false` etc. blocked at 1.0 | judge the file's contents; `_authToken` still blocks | corpus-express-blockers |
| secrets | `-----BEGIN RSA PRIVATE KEY-----\nMIIE...` placeholder in a runbook | header needs 40+ base64 chars behind it | secrets-prose-specificity |
| documentation | `Readme.md` reported missing | case-insensitive lookup, any README extension | corpus-express-blockers |
| documentation | missing README section BLOCKED the gate | warning | corpus-clean-repo-classes |
| codeQuality | script in a private nested app graded as root-package library code | nearest package.json owns the file; `files` scopes what ships | code-quality-nearest-package |
| syntax | JSONC fix shipped dead (out-of-scope variable) | hoisted; end-to-end test through the module | jsonc-config-files |
| hardcodedUrl | bare `http://localhost` as URL-parse base | whole-match check, port or path still fires | corpus-clean-repo-classes |
| ciSecurity | `${{ github.event.pull_request.base.sha }}` in `git diff` | `.sha`/`.number`/`.id` fields are not injectable; titles/refs still fire | corpus-clean-repo-classes |
| prSize | commit already on the default branch sized as a PR | `origin/HEAD` first; merge-base == HEAD → not a PR; `bun.lock` excluded | corpus-clean-repo-classes |
| bundleSize | committed `dist/lodash.js` graded as a page bundle | no bundler manifest → warning | corpus-clean-repo-classes |
| links | `string,`, `LINK`, `www.websitename.com`, `{{sponsor.imageUrl}}`, `../node_modules/…`, harness pages | code spans stripped; bare tokens, bare domains, dependency assets, harness pages skipped | corpus-clean-repo-classes |

## Warning volume (unchanged, now budgeted)

Per-module warning counts are pinned per repo; the gate fails when any module
grows past `baseline × 1.25 + 5`. axios at 261 and juice-shop at 792 are not
audited here — they are the next measurement. `errorSwallow:empty-catch` is
the largest single class on every repo including our own (346 on this one).

## Honest limits

- 85 modules ran, not 121. Language modules for languages absent from the
  repo report nothing; four modules are skipped by design.
- The three vulnerable repos are pinned by CLASS (module:rule), not by count
  alone, so a precision change that silences a planted bug fails the build
  even if the total holds.
- Nine repos is still not a rate. It is now, at least, a gate.
