'use strict';
/**
 * Resolve the fix TARGET for a failing test — the implementation, never the
 * test itself (THE-FIFTY move 8). Reuses the one import-graph definition
 * (doctrine §4) instead of a private require()/import scan: `edgesForFile`
 * already extracts every outgoing edge from a single file, resolved to an
 * absolute path when it lands inside this project.
 */

const path = require('path');
const { collectSourceFiles, edgesForFile } = require('./import-graph');
const { repoRelative } = require('./repo-path');

/**
 * @param {string} testFilePath — absolute or repo-relative path to the failing test file
 * @param {string} projectRoot
 * @returns {string[]} repo-relative paths to the in-repo files the test imports,
 *   in import order, deduped, the test file itself excluded. Empty when the
 *   test imports nothing local (or the graph could not be read) — the caller
 *   treats that as "could not resolve", not as "nothing to fix" (doctrine #1).
 */
function resolveImplementationFiles(testFilePath, projectRoot) {
  const absTest = path.isAbsolute(testFilePath) ? testFilePath : path.join(projectRoot, testFilePath);

  let files;
  try {
    files = collectSourceFiles(projectRoot);
  } catch {
    return []; // error-ok — unreadable project tree, nothing to resolve
  }
  const fileSet = new Set(files);

  let edges;
  try {
    edges = edgesForFile(absTest, fileSet, { projectRoot }, true);
  } catch {
    return []; // error-ok — unreadable/unparseable test file
  }

  const seen = new Set();
  const impls = [];
  for (const edge of edges || []) {
    if (!edge || !edge.to) continue;
    if (edge.to === absTest) continue;
    if (!fileSet.has(edge.to)) continue; // external/unresolved specifier
    const rel = repoRelative(projectRoot, edge.to);
    if (seen.has(rel)) continue;
    seen.add(rel);
    impls.push(rel);
  }
  return impls;
}

module.exports = { resolveImplementationFiles };
