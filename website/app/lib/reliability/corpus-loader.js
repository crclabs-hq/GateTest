/**
 * Reliability — corpus loader.
 *
 * Walks `<corpusRoot>/` and returns the list of valid case manifests
 * plus the code-root for each (the directory the manifest sits in).
 *
 * Skips directories: `baselines/` and anything starting with `.` or
 * `_`. Skips manifests that fail validation, with an explicit reason
 * in the returned `invalid` array so the operator sees the corpus
 * health at a glance.
 *
 * Output:
 *   {
 *     cases:   [{ manifest, codeRoot, manifestPath }],
 *     invalid: [{ path, errors }],
 *   }
 *
 * Pure function over an injectable fs. No I/O when called with a
 * mock filesystem.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { validateManifest } = require("./manifest.js");

const SKIP_DIRS = new Set(["baselines", "node_modules", ".git"]);

function isSkippable(name) {
  if (!name) return true;
  if (name.startsWith(".") || name.startsWith("_")) return true;
  if (SKIP_DIRS.has(name)) return true;
  return false;
}

function walkForManifests(root, _fs) {
  const out = [];
  if (!_fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = _fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (isSkippable(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name === "manifest.json") {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Load every manifest under `corpusRoot`. Returns valid cases (with
 * code-root) and the list of invalid ones (with reasons).
 *
 * @param {string} corpusRoot
 * @param {object} [_fs] injectable fs
 */
function loadCorpus(corpusRoot, _fs = fs) {
  const manifestPaths = walkForManifests(corpusRoot, _fs);
  const cases = [];
  const invalid = [];
  for (const p of manifestPaths) {
    let raw;
    try {
      raw = _fs.readFileSync(p, "utf8");
    } catch (err) {
      invalid.push({ path: p, errors: [`read failed: ${err.message || String(err)}`] });
      continue;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      invalid.push({ path: p, errors: [`json parse: ${err.message || String(err)}`] });
      continue;
    }
    const v = validateManifest(json);
    if (!v.ok) {
      invalid.push({ path: p, errors: v.errors });
      continue;
    }
    cases.push({
      manifest: json,
      codeRoot: path.dirname(p),
      manifestPath: p,
    });
  }
  // Stable ordering: by category, then by name
  cases.sort((a, b) => {
    if (a.manifest.category !== b.manifest.category) {
      return a.manifest.category < b.manifest.category ? -1 : 1;
    }
    return a.manifest.name < b.manifest.name ? -1 : 1;
  });
  return { cases, invalid };
}

/**
 * Render a corpus summary as customer-facing markdown.
 */
function renderCorpusSummary(loaded) {
  const lines = [];
  lines.push(`# Reliability corpus — ${loaded.cases.length} cases loaded`);
  lines.push("");
  if (loaded.invalid.length > 0) {
    lines.push(`⚠️ ${loaded.invalid.length} invalid manifest(s):`);
    for (const inv of loaded.invalid) {
      lines.push(`- \`${inv.path}\``);
      for (const e of inv.errors) lines.push(`  - ${e}`);
    }
    lines.push("");
  }
  const byCategory = new Map();
  for (const c of loaded.cases) {
    const k = c.manifest.category;
    byCategory.set(k, (byCategory.get(k) || 0) + 1);
  }
  lines.push("| Category | Count |");
  lines.push("| --- | --- |");
  for (const [cat, n] of Array.from(byCategory).sort()) {
    lines.push(`| \`${cat}\` | ${n} |`);
  }
  return lines.join("\n");
}

module.exports = {
  loadCorpus,
  walkForManifests,
  renderCorpusSummary,
  isSkippable,
};
