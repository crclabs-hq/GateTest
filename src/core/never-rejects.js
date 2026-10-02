'use strict';

/**
 * Does calling this function ever produce a rejected promise?
 *
 * `audit({...}).catch(() => {})` reads as a swallowed error, but Gluecron's
 * `audit()` (src/lib/notify.ts) is `async function audit(opts) { try { …await
 * db.insert(…) } catch (err) { console.error("[audit] failed:", err); } }` —
 * it cannot reject, so the `.catch` has nothing to drop. Measured 2026-10-02:
 * 21 of Gluecron's 55 remaining blocking `catch-noop` findings were calls to
 * three such functions (`audit`, `resetIfCycleExpired`, `notify`).
 *
 * A function NEVER REJECTS when, read on the masked source:
 *   - it is `async` (a plain function returning a promise can hand back a
 *     rejected one no try can see);
 *   - its whole body is one `try { … } catch { … }` with nothing after it;
 *   - the catch neither `throw`s nor returns `Promise.reject`;
 *   - no `return` inside the try hands back an un-awaited call — in an async
 *     function `return p` resolves to `p` OUTSIDE the try, so a rejection of
 *     `p` escapes it. `return await p` and `return value` stay inside.
 * Anything else — including a body this reader cannot delimit — is "may
 * reject", so the finding keeps its severity.
 *
 * Resolution: the same file, or a named import with a relative specifier
 * (`import { audit } from "../lib/notify"`, aliases included). Path aliases and
 * packages are not followed — silence over invented facts.
 */

const fs = require('fs');
const path = require('path');
const { maskSource } = require('./source-strip');
const { resolveImport } = require('./import-graph');

const FN_RE = /\basync\s+function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
const ARROW_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*async\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*\{/g;
const IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** Index of the brace that closes the one opening at `open`, or -1. */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Is `body` (the text between a function's braces) one non-rethrowing try/catch? Pure. */
function bodyNeverRejects(body) {
  const t = body.trim();
  if (!t.startsWith('try')) return false;
  const tryOpen = t.indexOf('{');
  if (tryOpen < 0 || !/^try\s*$/.test(t.slice(0, tryOpen))) return false;
  const tryClose = matchBrace(t, tryOpen);
  if (tryClose < 0) return false;
  const afterTry = t.slice(tryClose + 1);
  const c = afterTry.match(/^\s*catch\s*(?:\([^)]*\))?\s*\{/);
  if (!c) return false;
  const catchOpen = tryClose + 1 + c[0].length - 1;
  const catchClose = matchBrace(t, catchOpen);
  if (catchClose < 0 || t.slice(catchClose + 1).trim() !== '') return false;
  const catchBody = t.slice(catchOpen + 1, catchClose);
  if (/\bthrow\b|\bPromise\s*\.\s*reject\b/.test(catchBody)) return false;
  const tryBody = t.slice(tryOpen + 1, tryClose);
  // `return f()` / `return x.then(...)` — un-awaited, escapes the try.
  if (/\breturn\s+(?!await\b)[^;]*?[\w$)\]]\s*\(/.test(tryBody)) return false;
  return true;
}

/** Names of the functions in `masked` source that never reject. Pure. */
function neverRejectingNames(masked) {
  const names = new Set();
  for (const re of [FN_RE, ARROW_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) {
      let open;
      if (re === FN_RE) {
        const paramsOpen = m.index + m[0].length - 1;
        const paramsClose = matchParen(masked, paramsOpen);
        if (paramsClose < 0) continue;
        // `): Promise<void> {` — the return annotation sits before the brace.
        const brace = masked.slice(paramsClose).search(/\{/);
        if (brace < 0) continue;
        const between = masked.slice(paramsClose + 1, paramsClose + brace);
        if (!/^\s*(?::[^;{}]*(?:<[^;]*>)?)?\s*$/.test(between)) continue;
        open = paramsClose + brace;
      } else {
        open = m.index + m[0].length - 1;
      }
      const close = matchBrace(masked, open);
      if (close < 0) continue;
      if (bodyNeverRejects(masked.slice(open + 1, close))) names.add(m[1]);
    }
  }
  return names;
}

/** `{ audit, notify as send }` → Map(local → exported). Pure. */
function importedNames(raw) {
  const out = new Map();
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(raw))) {
    for (const part of m[1].split(',')) {
      const p = part.trim().replace(/^type\s+/, '');
      if (!p) continue;
      const as = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (as) out.set(as[2], { name: as[1], spec: m[2] });
      else if (/^[A-Za-z_$][\w$]*$/.test(p)) out.set(p, { name: p, spec: m[2] });
    }
  }
  return out;
}

const DISK = { has: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } } };

/**
 * One scan's resolver. `cache` maps an absolute file to the names it defines
 * that never reject (null when unreadable), so each file is read once however
 * many call sites point at it.
 */
function createNeverRejects() {
  const cache = new Map();
  const namesIn = (abs) => {
    if (!cache.has(abs)) {
      let names = null;
      try { names = neverRejectingNames(maskSource(fs.readFileSync(abs, 'utf-8'), abs)); } catch { names = null; }
      cache.set(abs, names);
    }
    return cache.get(abs);
  };
  /** Does `callee`, called in `abs` (raw text `raw`), never reject? */
  return function neverRejects(abs, raw, callee) {
    const local = namesIn(abs);
    if (local && local.has(callee)) return true;
    const imp = importedNames(raw).get(callee);
    if (!imp || !imp.spec.startsWith('.')) return false;
    const target = resolveImport(path.dirname(abs), imp.spec, DISK);
    if (!target) return false;
    const names = namesIn(target);
    return !!(names && names.has(imp.name));
  };
}

module.exports = { bodyNeverRejects, neverRejectingNames, importedNames, createNeverRejects };
