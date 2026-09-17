'use strict';

/**
 * KI #107 — admin softening of the CI/CLI gate. ONE definition (Doctrine
 * #4) of whether a blocking gate result may be softened, imported by
 * `runner.js` (decision) and `json-output.js` (disclosure).
 *
 * BACKGROUND — what the flag actually did before this fix (reproduced
 * 2026-09-16): NOTHING. Forbidden #25 in CLAUDE.md promises "admin paths
 * (env GATETEST_ADMIN=1, or .gatetest.json with owner:crclabs-hq or
 * admin:true) auto-fix and pass" — but no code in the plain scan/gate path
 * (`bin/gatetest.js`, `src/core/runner.js`) ever read `.gatetest.json`'s
 * `admin`/`owner` keys or `process.env.GATETEST_ADMIN`. `config.js`'s
 * `KNOWN_ROOT_KEYS` comment says as much: those keys are "consumed OUTSIDE
 * this process" (the husky pre-push shell template + the website's GitHub
 * commit-status wording). A control run on this repo — a synthetic
 * `secrets` finding, `.gatetest.json` carrying `admin: true` AND
 * `owner: "crclabs-hq"` — returned `GATE: BLOCKED` / exit 1 both with and
 * without `GATETEST_ADMIN=1` in the environment: the flag was completely
 * inert for gate enforcement. So the gate was never actually softened on
 * this repo; the risk was that Forbidden #25's promise gets wired up
 * naively later, straight onto a repo-level config default.
 *
 * THE FIX — softening is now real, but opt-in only, per Forbidden #25's own
 * recommendation on KI #107:
 *   - `.gatetest.json`'s `admin` / `owner` keys NEVER soften this gate. A
 *     repo-level config default silently turning CI advisory is exactly
 *     what KI #107 flagged as the danger — Doctrine #9 (our own scanner
 *     must be able to block our own PR) depends on that never happening.
 *   - ONLY `GATETEST_ADMIN=1` in the environment of the CURRENT run can
 *     soften a blocking result — a per-run, per-operator opt-in that CI
 *     never sets (no workflow in `.github/workflows/` sets it).
 *   - Softening is never silent (Forbidden #16). The blocking findings are
 *     still computed and reported; only the exit code / `gateStatus` flips,
 *     and only alongside a loud notice + an `adminOverride: true` flag in
 *     every report format.
 */

const ENV_VAR = 'GATETEST_ADMIN';

/** True only when the current process environment opts in. Config never does. */
function isRequested(env = process.env) {
  return env[ENV_VAR] === '1';
}

/** The loud, never-silent notice printed whenever a BLOCKED gate is softened. */
function notice({ totalBlockingErrors = 0, failedModules = 0 } = {}) {
  return `[GateTest] GATE SOFTENED by ${ENV_VAR}=1 — ${totalBlockingErrors} blocking `
    + `error(s) and ${failedModules} failed module(s) would otherwise BLOCK this gate. `
    + `They are reported above, not silenced. Unset ${ENV_VAR} to enforce.`;
}

module.exports = { ENV_VAR, isRequested, notice };
