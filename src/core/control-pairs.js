'use strict';
/**
 * Control-pair counter for the per-rule precision table (the Fifty, move 02).
 *
 * Doctrine #3: no rule ships without a control pair — the real line that
 * fires it, and the idiom beside it that must stay quiet. Tests already carry
 * these pairs in prose ("control pair", "issue #NNN"), but nothing machine-
 * readable tied a rule id to the test that proves it. This is that tie.
 *
 * THE MARKER CONVENTION (one definition, imported): a line comment anywhere
 * in a file under tests/ (recursively, including tests/heavy/) of the exact
 * shape
 *
 *   // control-pair: <ruleId>
 *
 * counts as one control pair for <ruleId> — <ruleId> is the same string
 * src/core/rule-identity.js produces (e.g. "secrets", "python:eval"). A file
 * may carry more than one marker (one per pair it proves); each occurrence
 * counts once. This does not replace the existing "control pair" prose in
 * test comments — it is the minimal addition that makes the count
 * machine-countable without rewriting every existing test file.
 */

const fs = require('fs');
const path = require('path');

const MARKER_RE = /\/\/\s*control-pair:\s*(\S+)/g;

/** All .test.js files under `dir`, recursively (tests/ and tests/heavy/). */
function walkTestFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { // error-ok — a missing tests dir just yields no control pairs
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

/**
 * Count `// control-pair: <ruleId>` markers under `testsDir`, per rule id.
 * Pure w.r.t. its inputs being read once; safe to call per rule with the
 * same cached map via `controlPairCounts`.
 * @param {string} testsDir
 * @returns {Map<string, number>}
 */
function controlPairCounts(testsDir) {
  const counts = new Map();
  for (const file of walkTestFiles(testsDir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(MARKER_RE)) {
      const rule = m[1];
      counts.set(rule, (counts.get(rule) || 0) + 1);
    }
  }
  return counts;
}

module.exports = { controlPairCounts, walkTestFiles, MARKER_RE };
