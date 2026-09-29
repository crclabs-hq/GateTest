'use strict';
/**
 * Operator CLI files — ONE definition (issue #771, GT-12).
 *
 * A file under `bin/`, `scripts/` or `cli/`, or any file whose FIRST line is
 * a shebang (`#!/usr/bin/env node`), is run interactively by a human on
 * their own terminal. When it prints the argument it was just handed —
 * `console.log(token)` in `bin/rotate-api-key.js` echoing the `--token` it
 * was invoked with — or the one-time value it just generated for that
 * human (AlecRae.com apps/api/scripts/create-admin-user.ts:126 prints the
 * admin password it created, under a line that says "ONE-TIME PASSWORD"),
 * that is the tool confirming what it did, not a plaintext credential
 * leaking into a log-aggregation stack.
 *
 * Both logPii (src/modules/log-pii.js) and dataIntegrity's "PII in logs"
 * rule (src/modules/data-integrity.js) reported these on the AlecRae scan;
 * both consult this helper so the exemption is the FILE's role, decided in
 * one place. The identical `console.log(password)` in application code
 * under `src/` still fires.
 *
 * Segment-matched (doctrine #5): `subscripts/report.js` does not have a
 * `scripts` SEGMENT and is not exempted. Only the first line is checked for
 * a shebang, matching how a shell decides how to run the file; a `#!`
 * appearing later is a string or a comment.
 */

const OPERATOR_CLI_DIR_RE = /(?:^|\/)(?:bin|scripts|cli)\//;
const SHEBANG_RE = /^#!/;

/**
 * @param {string} rel  repo-relative path (either slash style)
 * @param {string} [text]  file contents, for the shebang check
 * @returns {boolean}
 */
function isOperatorCliFile(rel, text) {
  const normalised = String(rel || '').replace(/\\/g, '/');
  if (OPERATOR_CLI_DIR_RE.test(normalised)) return true;
  if (typeof text !== 'string' || text.length === 0) return false;
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  return SHEBANG_RE.test(firstLine);
}

module.exports = { OPERATOR_CLI_DIR_RE, isOperatorCliFile };
