/**
 * JSONC — JSON with comments and trailing commas.
 *
 * Several config files are JSONC *by specification*, not by accident:
 * `tsconfig.json`, `jsconfig.json`, `.devcontainer/devcontainer.json` and
 * everything under `.vscode/`. Editors and the tools that own those formats
 * parse them happily. `JSON.parse` does not.
 *
 * Measured 2026-09-01: scanning axios @81df7a5, the syntax module reported a
 * BLOCKING "JSON syntax error" on `.devcontainer/devcontainer.json`, whose
 * only sin was a trailing comma — legal in the format it is written in. Any
 * repo with a devcontainer or a commented tsconfig hits this, which is a very
 * large share of modern TypeScript projects, and it fails their build on a
 * file that is correct.
 *
 * The knowledge already existed in this codebase — `syntax.js` strips comments
 * before reading tsconfig, with the comment "tsconfig is JSONC" — 200 lines
 * away from the check that did not. This module is that knowledge with one
 * home.
 *
 * Deliberately NOT a general JSON5 parser: unquoted keys and single-quoted
 * strings stay errors, because those genuinely are invalid in these files.
 */

/**
 * Strip line/block comments and trailing commas, without touching string
 * contents. String-aware on purpose: a regex that removes `//` would eat the
 * `//` in `"https://example.com"`, and one that removes `,` before `}` would
 * corrupt the literal `"a,}"`.
 *
 * @param {string} text
 * @returns {string} strict-JSON-parseable text of the same semantic content
 */
function stripJsonc(text) {
  const src = String(text);
  let out = '';
  let i = 0;

  /** Index of the next character that is not whitespace or a comment. */
  const nextMeaningful = (from) => {
    let j = from;
    while (j < src.length) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { j++; continue; }
      if (c === '/' && src[j + 1] === '/') {
        while (j < src.length && src[j] !== '\n') j++;
        continue;
      }
      if (c === '/' && src[j + 1] === '*') {
        j += 2;
        while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
        j += 2;
        continue;
      }
      return j;
    }
    return -1;
  };

  while (i < src.length) {
    const ch = src[i];

    // String literal — copied verbatim, escapes respected.
    if (ch === '"') {
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        out += c;
        i++;
        if (c === '\\') { out += src[i] ?? ''; i++; continue; }
        if (c === '"') break;
      }
      continue;
    }

    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Trailing comma: drop it only when the next meaningful character closes
    // the container.
    if (ch === ',') {
      const j = nextMeaningful(i + 1);
      if (j !== -1 && (src[j] === '}' || src[j] === ']')) { i++; continue; }
    }

    out += ch;
    i++;
  }

  return out;
}

// Files that ARE JSONC by their own specification. Anchored to the filename or
// a known directory — a repo's own `data/config.json` is still strict JSON and
// a trailing comma there is a real defect worth reporting.
// 2026-09-05, prisma: `packages/0-config/tsconfig/base.json` (a tsconfig
// split into a directory, commented) and `turbo.json` (Turborepo documents
// comments) were "JSON syntax errors". Added: a `tsconfig/` directory, the
// `.jsonc` extension, turbo/biome/deno configs, `.babelrc` / `.swcrc`.
const JSONC_FILE_RE =
  /(^|\/)(?:tsconfig(?:\.[^/]*)?\.json|jsconfig(?:\.[^/]*)?\.json|devcontainer\.json|\.eslintrc\.json|typedoc\.json|turbo\.json|biome\.jsonc?|deno\.jsonc?|\.babelrc(?:\.json)?|\.swcrc|[^/]+\.jsonc)$|(^|\/)\.?vscode\/[^/]+\.json$|(^|\/)\.devcontainer\/[^/]+\.json$|(^|\/)tsconfig\/[^/]+\.json$/i;

/**
 * True when `relPath` names a file whose format permits comments and trailing
 * commas.
 */
function isJsoncPath(relPath) {
  if (!relPath) return false;
  return JSONC_FILE_RE.test(String(relPath).replace(/\\/g, '/'));
}

module.exports = { stripJsonc, isJsoncPath };
