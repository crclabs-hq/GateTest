'use strict';

/**
 * Accepted risk overrides — a RECORDED, EXPIRING alternative to
 * `.gatetestignore` for a finding that is real but accepted, not wrong.
 *
 * Complaint C8 (dev.to quality-gate posts, G2): teams route around gates
 * that cannot be overridden — the UNRECORDED bypass is the actual complaint,
 * not the override itself. `.gatetestignore` already covers "this rule is
 * wrong about my repo" — a silent, permanent suppression with no reason and
 * no expiry (src/core/ignore-file.js). An accepted risk is the other case:
 * "this finding is right, we accept it anyway, here is why, and here is
 * when we stop accepting it." It never disappears from the report (it moves
 * to a separate `overrides[]` array, never the suppressed list), and an
 * expired override blocks again with a message naming it — never silent
 * (Bible Forbidden #16).
 *
 * IDENTITY: the SAME finding id every other surface already uses —
 * `${module}:${checkName}`, exactly `f.id` in src/core/finding-registry.js
 * and `issues[].id` in `gatetest --format json` — never a second identity
 * scheme (doctrine #4, "one definition, imported").
 *
 * TWO SOURCES, ONE SHAPE — `{ id, reason, by, until, created }`:
 *   - `.gatetest/accepted-risks.json`, an array reviewed in PRs like any
 *     other repo file (loadAcceptedRisks / saveAcceptedRisks).
 *   - `--accept-risk <id> --reason "<text>" [--until YYYY-MM-DD] [--by name]`
 *     (repeatable; parseAcceptRiskArgs). `--persist` writes the CLI
 *     overrides into the file; without it they apply for this run only.
 */

const fs = require('fs');
const path = require('path');

const ACCEPTED_RISKS_RELPATH = path.join('.gatetest', 'accepted-risks.json');

/** Absolute path to `.gatetest/accepted-risks.json` under a project root. */
function acceptedRisksPath(projectRoot) {
  return path.join(projectRoot || process.cwd(), ACCEPTED_RISKS_RELPATH);
}

/**
 * Read `.gatetest/accepted-risks.json`. Never throws — an absent, unreadable
 * or malformed file reads as "no overrides on record", the same convention
 * `.gatetestignore` and the baseline file use.
 * @param {string} projectRoot
 * @returns {Array<{id:string, reason?:string, by?:string, until?:string, created?:string}>}
 */
function loadAcceptedRisks(projectRoot) {
  try {
    const text = fs.readFileSync(acceptedRisksPath(projectRoot), 'utf-8');
    const data = JSON.parse(text);
    return Array.isArray(data) ? data.filter((o) => o && typeof o.id === 'string') : [];
  } catch { return []; } // error-ok — no file / unreadable / malformed: no overrides on record
}

/**
 * Write the overrides array to `.gatetest/accepted-risks.json`, creating the
 * directory if needed. Used by `--accept-risk --persist`.
 * @param {string} projectRoot
 * @param {Array<object>} overrides
 * @returns {string} the path written
 */
function saveAcceptedRisks(projectRoot, overrides) {
  const file = acceptedRisksPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(overrides, null, 2)}\n`, 'utf-8');
  return file;
}

/**
 * Is `until` in the past relative to `now`? An unparsable date never
 * silently expires — that would turn a typo into a surprise block.
 * @param {string|null|undefined} until  YYYY-MM-DD or any Date-parsable string
 * @param {Date} [now]
 */
function isExpired(until, now = new Date()) {
  if (!until) return false;
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < now.getTime();
}

/**
 * Parse the repeatable `--accept-risk <id> --reason "<text>" [--until d]
 * [--by name]` groups out of raw argv, leaving every other token untouched
 * for `src/core/cli-args.js`'s generic parser.
 *
 * Grammar: each `--accept-risk <id>` opens a new group; a `--reason` /
 * `--until` / `--by` that follows (before the next `--accept-risk` or the
 * end of argv) belongs to it. `--persist` is a bare flag, order-independent.
 *
 * Missing `--reason` is never silently applied (Bible Forbidden #16): the
 * group is still returned (so the caller can name it in an error) but with
 * `reason: null`; the caller decides fatal-vs-warning and drops it from the
 * active override set when non-fatal.
 *
 * @param {string[]} argv
 * @returns {{ overrides: Array<{id:string, reason:string|null, by:string|null, until:string|null}>,
 *             persist: boolean, errors: string[], remainingArgv: string[] }}
 */
function parseAcceptRiskArgs(argv) {
  const overrides = [];
  const errors = [];
  const remainingArgv = [];
  let persist = false;
  let current = null;

  const flush = () => {
    if (!current) return;
    if (!current.reason) {
      errors.push(`--accept-risk ${current.id}: missing --reason — an override is never applied without one`);
    }
    overrides.push(current);
    current = null;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--accept-risk') {
      flush();
      const next = argv[i + 1];
      if (!next || (typeof next === 'string' && next.startsWith('--'))) {
        errors.push('--accept-risk needs a finding id');
        continue;
      }
      current = { id: argv[++i], reason: null, by: null, until: null };
    } else if (arg === '--reason' && current) {
      current.reason = argv[++i] || null;
    } else if (arg === '--until' && current) {
      current.until = argv[++i] || null;
    } else if (arg === '--by' && current) {
      current.by = argv[++i] || null;
    } else if (arg === '--persist') {
      persist = true;
    } else {
      remainingArgv.push(arg);
    }
  }
  flush();
  return { overrides, persist, errors, remainingArgv };
}

/**
 * Merge file-recorded overrides with CLI-supplied ones into one list, CLI
 * winning on a shared id (an operator overriding the record for this run).
 * Drops any override with no reason — the parser already reported why.
 * Stamps `created` on anything that lacks it.
 * @param {Array<object>} fileOverrides
 * @param {Array<object>} cliOverrides
 */
function mergeOverrides(fileOverrides, cliOverrides) {
  const byId = new Map();
  const nowIso = new Date().toISOString();
  for (const o of fileOverrides || []) {
    if (!o || !o.id || !o.reason) continue;
    byId.set(o.id, { created: nowIso, by: null, until: null, ...o });
  }
  for (const o of cliOverrides || []) {
    if (!o || !o.id || !o.reason) continue;
    byId.set(o.id, { created: nowIso, ...byId.get(o.id), ...o });
  }
  return [...byId.values()];
}

/**
 * Build a matcher from a merged override list.
 * @param {Array<object>} overrides
 * @param {{now?: Date}} [opts]
 * @returns {{ match: (id:string) => null | {override:object, expired:boolean} }}
 */
function buildOverrideMatcher(overrides, opts = {}) {
  const now = opts.now || new Date();
  const byId = new Map();
  for (const o of overrides || []) {
    if (o && o.id) byId.set(o.id, o);
  }
  return {
    match(id) {
      const override = byId.get(id);
      if (!override) return null;
      return { override, expired: isExpired(override.until, now) };
    },
  };
}

module.exports = {
  ACCEPTED_RISKS_RELPATH,
  acceptedRisksPath,
  loadAcceptedRisks,
  saveAcceptedRisks,
  isExpired,
  parseAcceptRiskArgs,
  mergeOverrides,
  buildOverrideMatcher,
};
