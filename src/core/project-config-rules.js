'use strict';

/**
 * Configuration contradictions that only show up across files — built from
 * Tallrig's bug corpus (scripts/cross-test-score.js):
 *
 *   peer-meta-drift     package.json lists a package in peerDependenciesMeta
 *                       but not in peerDependencies; package managers record
 *                       the pair differently and the lockfile drifts from the
 *                       manifest (TALLRIG-2026-041: `bun install
 *                       --frozen-lockfile` failed in CI)
 *   csp-eval-conflict   the app's CSP script-src has no 'unsafe-eval' while a
 *                       SolidStart app.config keeps the default serializer,
 *                       which deserializes server-function results with
 *                       eval — every client navigation that calls a
 *                       "use server" function throws EvalError
 *                       (TALLRIG-2026-001, a live outage)
 *
 * Pure: inputs are file text, outputs are findings. The security module
 * walks the tree and reports.
 */

function peerMetaDrift(relPath, text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return []; } // error-ok — invalid JSON is the syntax module's finding
  const meta = pkg && pkg.peerDependenciesMeta;
  if (!meta || typeof meta !== 'object') return [];
  const peers = (pkg.peerDependencies && typeof pkg.peerDependencies === 'object') ? pkg.peerDependencies : {};
  const lines = String(text).split(/\r?\n/);
  return Object.keys(meta).filter((name) => !(name in peers)).map((name) => {
    const idx = lines.findIndex((l) => l.includes(`"${name}"`));
    return {
      rule: 'peer-meta-drift',
      line: idx >= 0 ? idx + 1 : 1,
      severity: 'warning',
      message: `${relPath}: "${name}" is in peerDependenciesMeta but not in peerDependencies — package managers record it differently and a frozen-lockfile install can fail`,
      suggestion: `Add "${name}" to peerDependencies (with a version range), or remove its peerDependenciesMeta entry.`,
    };
  });
}

// A CSP script-src directive literal, and whether it allows eval.
// CSP source keywords are themselves single-quoted ('self', 'unsafe-eval'),
// so the directive runs to `;`, a double quote, a backtick or end of line.
const SCRIPT_SRC_RE = /script-src\b[^;"`\n]*/;
const SOLID_CONFIG_PATH_RE = /(?:^|\/)app\.config\.[cm]?[jt]s$/;

/** @param {Array<{relPath: string, content: string}>} files */
function cspEvalConflict(files) {
  const strictCsp = files.find((f) => {
    const m = SCRIPT_SRC_RE.exec(f.content);
    return m && !/'unsafe-eval'/.test(m[0]);
  });
  if (!strictCsp) return [];
  const out = [];
  for (const f of files) {
    if (!SOLID_CONFIG_PATH_RE.test(f.relPath.replace(/\\/g, '/'))) continue;
    if (!/\bdefineConfig\s*\(/.test(f.content) || /\bserialization\s*:/.test(f.content)) continue;
    const lines = f.content.split(/\r?\n/);
    const idx = lines.findIndex((l) => /\bdefineConfig\s*\(/.test(l));
    const solid = /@solidjs\/start/.test(f.content);
    out.push({
      relPath: f.relPath,
      rule: 'csp-eval-conflict',
      line: idx + 1,
      severity: solid ? 'error' : 'warning',
      message: `${f.relPath}:${idx + 1} the app's CSP (${strictCsp.relPath}) forbids eval, but this config keeps the default server-function serializer, which uses eval — client navigation that calls a server function will throw EvalError`,
      suggestion: 'Set `serialization: { mode: "json" }` in defineConfig (SolidStart), or allow the specific need in the CSP knowingly. Test with a client-side navigation, not a full page load.',
    });
  }
  return out;
}

module.exports = { peerMetaDrift, cspEvalConflict };
