'use strict';
/**
 * Render stored secrets to a systemd EnvironmentFile, and parse one back.
 *
 * Output: a header comment (timestamp + count, never a value), then one
 * `NAME="escaped"` line per secret, sorted by name.
 *
 * Quoting follows systemd.exec(5) EnvironmentFile= rules for double-quoted
 * values: inside double quotes a backslash followed by `"`, `\`, `$`, a
 * backtick or a newline yields that character. So all four are escaped —
 * `$` and the backtick too, even though systemd itself does not expand them,
 * because the same file is readable by shells and dotenv-style loaders that
 * DO, and an unescaped `$FOO` in a password would silently become the value
 * of FOO there. NUL, CR and LF are refused outright (a raw newline would end
 * the assignment and turn the rest of the value into a new line of the file).
 *
 * parseEnvFile() implements the same rules in reverse (double-quoted,
 * single-quoted verbatim, unquoted with backslash escapes, `#`/`;` comment
 * lines) so the materializer can read its own output back before renaming it
 * into place, and the shadow detector can read the app's env file the way
 * systemd does when the unit loads it.
 */

class RenderError extends Error {
  constructor(name, code) {
    super(`cannot render ${name}: ${code}`);
    this.name = 'RenderError';
    this.code = code;
    this.secretName = name;
  }
}

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function escapeValue(name, value) {
  const s = String(value);
  if (/[\0\r\n]/.test(s)) throw new RenderError(name, 'value_invalid_chars');
  return s.replace(/[\\"$`]/g, (c) => `\\${c}`);
}

/**
 * @param {Array<{name:string, value:string}>} entries
 * @param {{ now?: number }} [opts]
 * @returns {string}
 */
function renderEnv(entries, opts = {}) {
  const now = new Date(opts.now || Date.now()).toISOString();
  const seen = new Set();
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = [
    '# GateTest platform secrets — rendered by the admin secrets panel. DO NOT EDIT BY HAND.',
    `# rendered_at=${now} count=${sorted.length}`,
  ];
  for (const e of sorted) {
    if (!NAME_RE.test(e.name)) throw new RenderError(String(e.name), 'invalid_name');
    if (seen.has(e.name)) throw new RenderError(e.name, 'duplicate_name');
    seen.add(e.name);
    lines.push(`${e.name}="${escapeValue(e.name, e.value)}"`);
  }
  return `${lines.join('\n')}\n`;
}

const DQ_ESCAPABLE = new Set(['"', '\\', '$', '`', '\n']);

/** Read a double- or single-quoted value starting at text[i] (the quote). */
function readQuoted(text, i) {
  const q = text[i];
  let out = '';
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === q) return { value: out, end: j + 1 };
    if (q === '"' && c === '\\' && j + 1 < text.length && DQ_ESCAPABLE.has(text[j + 1])) {
      if (text[j + 1] !== '\n') out += text[j + 1];
      j += 2;
      continue;
    }
    out += c;
    j += 1;
  }
  return null; // unterminated — the assignment is invalid
}

/** Read an unquoted value: to end of line, `\x` → x, trailing `\` continues. */
function readUnquoted(text, i) {
  let out = '';
  let j = i;
  while (j < text.length && text[j] !== '\n') {
    if (text[j] === '\\' && j + 1 < text.length) {
      if (text[j + 1] !== '\n') out += text[j + 1];
      j += 2;
      continue;
    }
    out += text[j];
    j += 1;
  }
  return { value: out.replace(/[ \t\r]+$/, ''), end: j };
}

/**
 * Parse an EnvironmentFile-style text into a Map name → value. Invalid lines
 * are skipped, never thrown on. A later assignment of the same name wins,
 * as it does in systemd.
 */
function parseEnvFile(text) {
  const out = new Map();
  const src = String(text || '').replace(/\r\n/g, '\n');
  let i = 0;
  while (i < src.length) {
    const lineEnd = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    const line = src.slice(i, lineEnd);
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(line);
    if (!m || /^[ \t]*[#;]/.test(line)) { i = lineEnd + 1; continue; }
    const start = i + m[0].length;
    let parsed;
    if (src[start] === '"' || src[start] === "'") {
      parsed = readQuoted(src, start);
      if (!parsed) break;
      const rest = src.indexOf('\n', parsed.end);
      i = rest === -1 ? src.length : rest + 1;
    } else {
      parsed = readUnquoted(src, start);
      i = parsed.end + 1;
    }
    out.set(m[1], parsed.value);
  }
  return out;
}

/** Header fields of a rendered file, or null when it is not one of ours. */
function readHeader(text) {
  const m = /^# rendered_at=(\S+) count=(\d+)$/m.exec(String(text || ''));
  return m ? { renderedAt: m[1], count: Number(m[2]) } : null;
}

module.exports = { escapeValue, renderEnv, parseEnvFile, readHeader };
