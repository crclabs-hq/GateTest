const path = require('path');
const { SHELL_EXTENSIONS, SNIFF_BYTES, headIsShellScript } = require('./shell-files');
'use strict';
/**
 * Source stripper — ONE definition of "what is a string / comment / regex
 * literal" in JS/TS source (Doctrine §4).
 *
 * Lived privately in src/modules/syntax.js; extracted so the import-graph
 * elision scanner (src/core/import-elision.js) tokenises the same masked text
 * the syntax module counts brackets on. Two strippers disagreeing about where
 * a template literal ends would be two answers to one question.
 *
 * Output is offset-preserving: every masked character becomes a space (a
 * newline stays a newline), so an index into the stripped text is the same
 * index into the original. Callers that need the ORIGINAL bytes at a masked
 * position (an import specifier, say) slice the raw source at that offset.
 */

// Slice-based scanner: runs of code are copied with slice() and a masked run
// is produced with one replace(), instead of one push per character — 2.6x
// faster over the 9,751-file corpus (2,986 ms → 1,157 ms), and this
// stripper runs two or three times per file per scan (syntax, the elision
// tokenizer, aiHallucination). Byte-identical to the character machine it
// replaced on 9,740 of those files; the 11 that differ were the old
// machine's defects, both now pinned in tests/source-strip.test.js:
//   - a line comment inside a `${ … }` hole returned to the plain state, so
//     the closing backtick opened a NEW template and the rest of the file
//     was blanked (trpc's www/src/theme/BlogPostPage/Metadata/index.tsx —
//     every import below that point vanished from the graph);
//   - a backslash-newline inside a template or string masked the newline to
//     a space, moving every line number after it.
// Comments never change state here; the newline after a backslash stays.
const REGEX_PRECEDERS = /[=(,;:!&|?{}[\n+\-*<>%^~]/;
const FLAG_RE = /[gimsuy]/;
// A `\r` is kept as well as `\n`: every consumer splits raw and masked text
// with the same /\r?\n/, and a `\r` masked to a space inside a comment left
// the masked line one character longer than its raw line on CRLF files
// (found by the race-condition migration, 2026-09-05).
const NL_RE = /[^\n\r]/g;
const mask = (s) => s.replace(NL_RE, ' ');

function stripStringsAndComments(src) {
  const n = src.length;
  const parts = [];
  let copyFrom = 0; // start of the pending run of unmasked text
  const emitCode = (end) => { if (end > copyFrom) parts.push(src.slice(copyFrom, end)); copyFrom = end; };
  const emitMasked = (from, to) => { emitCode(from); parts.push(mask(src.slice(from, to))); copyFrom = to; };
  // States: 0 normal, 6 template-expr (a `${ … }` hole — code).
  let state = 0;
  const returnTo = [];
  const holeDepths = [];
  let templateExprDepth = 0;
  let lastSig = '\n';

  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    // ── code (normal or inside a template hole) ──
    if (c === 47 /* / */) {
      const next = src.charCodeAt(i + 1);
      if (next === 47) { // line comment
        let j = src.indexOf('\n', i + 2); if (j === -1) j = n;
        emitMasked(i, j); i = j; lastSig = '\n';
        continue;
      }
      if (next === 42) { // block comment
        let j = src.indexOf('*/', i + 2); j = j === -1 ? n : j + 2;
        emitMasked(i, j); i = j;
        continue;
      }
      if (REGEX_PRECEDERS.test(lastSig)) { // regex literal
        let j = i + 1; let inClass = false;
        emitCode(i); parts.push('/'); copyFrom = i + 1;
        for (; j < n; j += 1) {
          const d = src.charCodeAt(j);
          if (d === 92 /* \ */) { j += 1; continue; }
          if (inClass) { if (d === 93 /* ] */) inClass = false; continue; }
          if (d === 91 /* [ */) { inClass = true; continue; }
          if (d === 47 /* / */ || d === 10 /* \n */) break;
        }
        if (j >= n) { parts.push(mask(src.slice(i + 1, n))); copyFrom = n; i = n; continue; }
        if (src.charCodeAt(j) === 10) { // unterminated: keep the newline as code
          parts.push(mask(src.slice(i + 1, j))); copyFrom = j; i = j; lastSig = '\n';
          // the newline itself is emitted as code by the normal path
          parts.push('\n'); copyFrom = j + 1; i = j + 1;
          continue;
        }
        parts.push(mask(src.slice(i + 1, j))); parts.push('/'); let k = j + 1;
        while (k < n && FLAG_RE.test(src[k])) k += 1;
        if (k > j + 1) parts.push(src.slice(j + 1, k));
        copyFrom = k; i = k; lastSig = '/';
        continue;
      }
      lastSig = '/'; i += 1; continue;
    }
    if (c === 39 || c === 34) { // ' or "
      const q = c;
      let j = i + 1;
      for (; j < n; j += 1) {
        const d = src.charCodeAt(j);
        if (d === 92) { j += 1; continue; }
        if (d === q || d === 10) break;
      }
      emitCode(i); parts.push(src[i]); copyFrom = i + 1;
      if (j >= n) { parts.push(mask(src.slice(i + 1, n))); copyFrom = n; i = n; continue; }
      // A '…' / "…" literal cannot hold a raw newline, so one that reaches
      // the line end is unterminated and ends there — the same rule the
      // Python stripper applies. Before this an apostrophe in JSX text
      // (`DavenRoe's cookie use`, CookiePolicy.jsx:341) opened a "string"
      // that ran to the next quote two lines down and inverted every mask
      // below it: real string literals read as code, code read as strings,
      // and a CRITICAL "CSRF protection disabled" fired on prose (#842 DR-1).
      if (src.charCodeAt(j) === 10) {
        parts.push(mask(src.slice(i + 1, j))); copyFrom = j; i = j; lastSig = '\n';
        continue;
      }
      parts.push(mask(src.slice(i + 1, j))); parts.push(src[j]); copyFrom = j + 1; i = j + 1; lastSig = src[j];
      continue;
    }
    if (c === 96) { // ` — template literal
      emitCode(i); parts.push('`'); copyFrom = i + 1;
      let j = i + 1;
      for (; j < n; j += 1) {
        const d = src.charCodeAt(j);
        if (d === 92) { j += 1; continue; }
        if (d === 96) break;
        if (d === 36 && src.charCodeAt(j + 1) === 123) break; // ${
      }
      if (j >= n) { parts.push(mask(src.slice(i + 1, n))); copyFrom = n; i = n; continue; }
      parts.push(mask(src.slice(i + 1, j))); copyFrom = j;
      if (src.charCodeAt(j) === 96) { parts.push('`'); copyFrom = j + 1; i = j + 1; lastSig = '`'; continue; }
      // `${` — enter a hole
      parts.push('${'); copyFrom = j + 2; i = j + 2;
      returnTo.push(state); holeDepths.push(templateExprDepth);
      state = 6; templateExprDepth = 1;
      continue;
    }
    if (state === 6) {
      if (c === 123) templateExprDepth += 1;
      else if (c === 125) {
        templateExprDepth -= 1;
        if (templateExprDepth === 0) {
          // back into the template body
          emitCode(i + 1); lastSig = '}';
          let j = i + 1;
          for (;;) {
            for (; j < n; j += 1) {
              const d = src.charCodeAt(j);
              if (d === 92) { j += 1; continue; }
              if (d === 96) break;
              if (d === 36 && src.charCodeAt(j + 1) === 123) break;
            }
            break;
          }
          if (j >= n) { parts.push(mask(src.slice(i + 1, n))); copyFrom = n; i = n; continue; }
          parts.push(mask(src.slice(i + 1, j))); copyFrom = j;
          if (src.charCodeAt(j) === 96) { parts.push('`'); copyFrom = j + 1; i = j + 1; state = returnTo.pop(); templateExprDepth = holeDepths.pop(); lastSig = '`'; continue; }
          parts.push('${'); copyFrom = j + 2; i = j + 2; templateExprDepth = 1;
          continue;
        }
      }
    }
    if (c > 32) lastSig = src[i];
    i += 1;
  }
  emitCode(n);
  return parts.join('');
}
/**
 * The Python counterpart: `#` comments, '…' / "…" strings (escapes honoured,
 * unterminated ones end at the line), and triple-quoted strings that span
 * lines. Offset-preserving like the JS stripper — every masked character is
 * a space, `\n` and `\r` stay. An f-string's `{…}` hole is masked with the
 * string: the rules that read Python decide on the call shape around the
 * string and read names from the raw line. Before this, prompt-safety's
 * Python scan kept a per-line quote counter, where an apostrophe in a
 * `# don't` comment opened a "string" that ran to the next quote (2026-09-05).
 */
function stripPythonStringsAndComments(src) {
  const n = src.length;
  const parts = [];
  let copyFrom = 0;
  const emitMasked = (from, to) => {
    if (from > copyFrom) parts.push(src.slice(copyFrom, from));
    parts.push(mask(src.slice(from, to)));
    copyFrom = to;
  };
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '#') {
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      emitMasked(i, j); i = j;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const triple = src[i + 1] === ch && src[i + 2] === ch;
      const open = triple ? ch + ch + ch : ch;
      const from = i + open.length; // first content character
      let j = from;
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (!triple && c === '\n') break; // unterminated: the string ends at the line
        if (src.startsWith(open, j)) { closed = true; break; }
        j += 1;
      }
      const to = Math.min(j, n); // content ends here; a closing delimiter is kept as code
      if (to > from) emitMasked(from, to);
      i = closed ? to + open.length : to;
      continue;
    }
    i += 1;
  }
  if (copyFrom < n) parts.push(src.slice(copyFrom));
  return parts.join('');
}

/**
 * Line-level fallback for the languages neither stripper parses (Ruby, Go,
 * shell, YAML, …): `#` and `//` line comments, a block comment that opens and
 * closes on the line, and single-line quotes. Positions stay stable. JS/TS go
 * through stripStringsAndComments and Python through
 * stripPythonStringsAndComments — this is only for the rest, and it lives
 * here so there is one place that knows how little it knows.
 */
function stripLineLiterals(line) {
  const out = [];
  let inS = false; let inD = false; let inT = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (!inS && !inD && !inT && ch === '/' && line[i + 1] === '/') {
      // Rest of line is a line comment.
      while (i < line.length) { out.push(' '); i += 1; }
      break;
    }
    if (!inS && !inD && !inT && ch === '#') {
      // Python / shell / YAML comment.
      while (i < line.length) { out.push(' '); i += 1; }
      break;
    }
    if (!inS && !inD && !inT && ch === '/' && line[i + 1] === '*') {
      out.push(' '); out.push(' '); i += 2;
      while (i < line.length) {
        if (line[i] === '*' && line[i + 1] === '/') {
          out.push(' '); out.push(' '); i += 2; break;
        }
        out.push(' '); i += 1;
      }
      continue;
    }
    if (ch === '\\') {
      out.push(ch);
      if (i + 1 < line.length) { out.push(line[i + 1]); i += 2; continue; }
      i += 1; continue;
    }
    if (!inD && !inT && ch === '\'') { inS = !inS; out.push(' '); i += 1; continue; }
    if (!inS && !inT && ch === '"') { inD = !inD; out.push(' '); i += 1; continue; }
    if (!inS && !inD && ch === '`') { inT = !inT; out.push(' '); i += 1; continue; }
    if (inS || inD || inT) { out.push(' '); i += 1; continue; }
    out.push(ch); i += 1;
  }
  return out.join('');
}

/**
 * What kind of text sits at column `col` of line `i`: 'code', 'string'
 * (a string or template literal), 'regex' or 'comment'. Decided from the mask
 * alone: a masked character that differs from the raw one is inside some
 * literal; strings keep their delimiters on the masked line and comments
 * leave nothing, so the parity of quote characters before the column tells
 * the two apart (a masked string interior never contains a quote, and code
 * never contains a bare one). A blank masked line — the inside of a
 * template or block comment spanning lines — defers to the nearest
 * non-blank masked line above.
 */
function literalKindAt(rawLines, maskedLines, i, col) {
  const raw = rawLines[i] || '';
  const masked = maskedLines[i] || '';
  if (col < 0 || col >= raw.length || masked[col] === raw[col]) return 'code';
  for (let k = i; k >= 0; k -= 1) {
    const before = k === i ? masked.slice(0, col) : (maskedLines[k] || '');
    if (!before.trim()) continue;
    for (const q of ['"', "'", '`']) {
      let count = 0;
      for (let j = 0; j < before.length; j += 1) if (before[j] === q) count += 1;
      if (count % 2 === 1) return 'string';
    }
    return before.trimEnd().endsWith('/') ? 'regex' : 'comment';
  }
  return 'comment';
}

// Shell (moved here from src/modules/bash-safety.js, 2026-09-05): its own
// grammar — single quotes expand nothing, double quotes keep `$( … )` as code,
// `#` opens a comment only at a word start.
/**
 * Blank out the CONTENTS of quoted strings and of trailing `#` comments while
 * preserving length, so every pattern below matches shell CODE only.
 *
 * `$( ... )` re-enters code even inside double quotes, because it is code —
 * `NODE_BIN="$(command -v node || true)"` must still be analysed.
 *
 * Without this: a comment explaining why a `|| true` is safe was itself a
 * finding, `echo "|| true"` was a finding, and a jq program containing a
 * literal `|` broke the pipeline splitter below.
 */
function stripShellLiterals(raw) {
  const stack = [];
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const ctx = stack[stack.length - 1];
    if (ctx === 'sq') {                       // single quotes: nothing expands
      out += c === "'" ? (stack.pop(), c) : ' ';
      continue;
    }
    if (ctx === 'dq') {                       // double quotes: only $( ) is code
      if (c === '\\' && i + 1 < raw.length) { out += '  '; i++; continue; }
      if (c === '"') { stack.pop(); out += c; continue; }
      if (c === '$' && raw[i + 1] === '(') { stack.push('cmd'); out += '$('; i++; continue; }
      out += ' ';
      continue;
    }
    if (c === "'") { stack.push('sq'); out += c; continue; }
    if (c === '"') { stack.push('dq'); out += c; continue; }
    if (c === '$' && raw[i + 1] === '(') { stack.push('cmd'); out += '$('; i++; continue; }
    if (c === ')' && ctx === 'cmd') { stack.pop(); out += c; continue; }
    if (c === '#' && stack.length === 0 && (i === 0 || /[\s;&|(]/.test(raw[i - 1]))) {
      out += ' '.repeat(raw.length - i);
      break;
    }
    out += c;
  }
  return out;
}


/**
 * Split an expression on `sep` at bracket depth 0, outside strings and
 * comments — argument lists, declarator lists, object entries. Depth is
 * counted on the masked expression (a bracket or separator inside a string is
 * neither) and the pieces are sliced from the raw one. `angle` also counts
 * `<`/`>` (TypeScript generics in a declarator list). Two modules carried
 * their own copy of this walk before 2026-09-05 (undefined-ref,
 * inner-html-safety).
 */
function splitTopLevel(expr, sep, { angle = false } = {}) {
  const code = stripStringsAndComments(expr);
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{' || (angle && ch === '<')) depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}' || (angle && ch === '>')) depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) { parts.push(expr.slice(from, i)); from = i + 1; }
  }
  parts.push(expr.slice(from));
  return parts;
}

// Which stripper a file gets — decided once, here, for every reader
// (BaseModule._maskedLines and the confidence scorer). Until 2026-09-05 the
// scorer ran the JS stripper on everything: in ktor's `gradlew` the case
// pattern `/*)` on line 80 opened a phantom block comment that never closed,
// and every finding below it — a real `eval "set -- $(…)"` on line 241 —
// scored 0.2 and slipped under the gate (KI #85's class, on a shell file).
const HASH_COMMENT_EXT_RE = /\.(?:rb|yml|yaml|toml|ini|cfg|conf|pl|pm|r|env|properties|gitignore|dockerignore)$/i;
const HASH_COMMENT_BASENAME_RE = /^(?:dockerfile|containerfile|makefile|gnumakefile|gemfile|rakefile|procfile|brewfile|justfile)(?:[-_.].*)?$/i;
function maskSource(sourceText, filePath = '') {
  const text = String(sourceText);
  const base = path.basename(filePath || '');
  const ext = path.extname(base).toLowerCase();
  if (ext === '.py') return stripPythonStringsAndComments(text);
  const shell = SHELL_EXTENSIONS.includes(ext) || (ext === '' && base !== '' && headIsShellScript(Buffer.from(text.slice(0, SNIFF_BYTES), 'utf8')));
  if (shell) return text.split('\n').map(stripShellLiterals).join('\n');
  if (HASH_COMMENT_EXT_RE.test(base) || HASH_COMMENT_BASENAME_RE.test(base)) return text.split('\n').map(stripLineLiterals).join('\n');
  return stripStringsAndComments(text);
}

module.exports = { stripStringsAndComments, stripPythonStringsAndComments, stripLineLiterals, stripShellLiterals, literalKindAt, splitTopLevel, maskSource };
