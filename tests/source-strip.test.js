'use strict';
/**
 * src/core/source-strip.js — the one definition of where a string, comment
 * or regex literal begins and ends (Doctrine §4). syntax.js counts brackets
 * on its output, the elision tokenizer reads import specifiers from it, and
 * aiHallucination harvests imports through it: 63 files depend on it
 * transitively, so every guarantee it makes is pinned here.
 *
 * Contract: the output is OFFSET-PRESERVING — same length, every newline in
 * the same place, every masked character a space — so an index into the
 * stripped text is the same index into the source.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { stripStringsAndComments } = require('../src/core/source-strip');

function strip(src) {
  const out = stripStringsAndComments(src);
  assert.strictEqual(out.length, src.length, 'offset-preserving: same length');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') assert.strictEqual(out[i], '\n', `newline preserved at ${i}`);
  }
  return out;
}

describe('source-strip — comments', () => {
  it('a line comment is blanked to the end of the line, the newline stays', () => {
    assert.strictEqual(strip('a = 1; // require("x")\nb = 2;'), 'a = 1;                \nb = 2;');
  });
  it('a block comment is blanked across lines', () => {
    const out = strip('/* one\n two */ c = 3;');
    assert.strictEqual(out, '      \n        c = 3;');
  });
  it('NEGATIVE CONTROL — `//` inside a string is not a comment', () => {
    assert.strictEqual(strip("u = 'http://x'; v = 1;"), "u = '        '; v = 1;");
  });
  it('NEGATIVE CONTROL — `/*` inside a regex literal is not a comment', () => {
    const out = strip('r = /\\/\\*/g; s = 1;');
    assert.ok(out.endsWith(' s = 1;'), out);
  });
});

describe('source-strip — strings and templates', () => {
  it('string contents are blanked, the quotes stay, escapes do not end the string', () => {
    assert.strictEqual(strip('a = "x\\"y"; b = 1;'), 'a = "    "; b = 1;');
    assert.strictEqual(strip("a = 'it\\'s'; b = 1;"), "a = '     '; b = 1;");
  });
  it('a template literal is blanked but its `${}` holes are kept as code', () => {
    const out = strip('t = `a ${f("q")} b`; c = 1;');
    assert.strictEqual(out, 't = `  ${f(" ")}  `; c = 1;');
  });
  it('a nested template inside a hole ends the inner template, not the outer', () => {
    const out = strip('t = `x ${`y ${z} w`} v`; u = 1;');
    assert.ok(out.endsWith('; u = 1;'), out);
    assert.ok(!/[xyvw]/.test(out), 'template text blanked: ' + out);
    assert.ok(out.includes('${z}'), 'inner hole kept: ' + out);
  });
  it('an object literal brace inside a hole does not end the template early', () => {
    const out = strip('t = `${ {a:1}.a } end`; u = 1;');
    assert.ok(out.endsWith('; u = 1;'), out);
    assert.ok(!out.includes('end'), out);
  });
});

describe('source-strip — regex versus division', () => {
  it('a regex literal is blanked (its `/` delimiters stay); a division is code', () => {
    const re = strip('r = /ab+c/gi.test(s);');
    assert.strictEqual(re, 'r = /    /gi.test(s);');
    const div = strip('q = a / b / c;');
    assert.strictEqual(div, 'q = a / b / c;');
  });
  it('a regex character class may contain `/`', () => {
    const out = strip('r = /[/]x/; y = 2;');
    assert.ok(out.endsWith('; y = 2;'), out);
  });
});

describe('source-strip — the two defects the slice-based scanner fixed (2026-09-05)', () => {
  it('a line comment inside a template hole does not end the hole — the closing backtick closes the template, not opens one', () => {
    // trpc www/src/theme/BlogPostPage/Metadata/index.tsx: the old machine
    // returned to the plain state after the comment, read `}` as code and the
    // closing backtick as a NEW template, and blanked the rest of the file.
    const src = 't = `${f({\n  // note\n  a: 1,\n})}`;\nimport x from "./after";\n';
    const out = strip(src);
    assert.ok(out.endsWith('import x from "       ";\n'), 'code after the template survives: ' + JSON.stringify(out));
  });
  it('a backslash-newline inside a template or a string keeps the newline (line numbers after it hold)', () => {
    const out = strip('u = `a \\\nb`; v = "c \\\nd"; w = 1;');
    assert.ok(out.endsWith(' w = 1;'), out);
  });
  it('NEGATIVE CONTROL — a `}` inside a nested string within a hole does not close the hole either', () => {
    const out = strip('t = `${g("}")} tail`; z = 2;');
    assert.ok(out.endsWith('; z = 2;'), out);
    assert.ok(!out.includes('tail'), out);
  });
});

describe('source-strip — Python (stripPythonStringsAndComments)', () => {
  const { stripPythonStringsAndComments: py } = require('../src/core/source-strip');
  const sameShape = (src) => {
    const out = py(src);
    assert.strictEqual(out.length, src.length, 'length preserved');
    assert.deepStrictEqual(out.split(/\r?\n/).map((l) => l.length), src.split(/\r?\n/).map((l) => l.length), 'line lengths preserved');
    return out;
  };
  it('a # comment is blanked; an apostrophe inside it does not open a string', () => {
    assert.strictEqual(sameShape("x = 'a#b' # don't\ny = \"q\"\n"), "x = '   '        \ny = \" \"\n");
  });
  it('a triple-quoted string spans lines; an f-string hole is masked with the string', () => {
    assert.strictEqual(sameShape('d = """multi\nline \'q\' """ + z\nm = f"gpt-{v}"\n'), 'd = """     \n         """ + z\nm = f"       "\n');
  });
  it('an unterminated single-quoted string ends at the line', () => {
    assert.strictEqual(sameShape("s = 'unterminated\nnext = 1\n"), "s = '            \nnext = 1\n");
  });
  it('an escaped quote does not close the string; CRLF line ends stay', () => {
    assert.strictEqual(sameShape('e = "esc \\" still" # c\r\nf = 2\r\n'), 'e = "            "    \r\nf = 2\r\n');
  });
});

describe('source-strip — robustness', () => {
  it('CRLF: both `\\r` and `\\n` stay, so raw and masked text split into lines of equal length', () => {
    // Length and every `\n` position are preserved (the helper asserts both),
    // so line numbers computed on the stripped text match the source.
    const out = strip('a = "s"; // c\r\nb = 1;\r\n');
    assert.strictEqual(out, 'a = " ";     \r\nb = 1;\r\n');
    const src = 'a // c\r\nb = "x\r\ny"\r\n/* m\r\n n */ z\r\n';
    const rawLines = src.split(/\r?\n/);
    const maskedLines = strip(src).split(/\r?\n/);
    assert.deepStrictEqual(maskedLines.map((l) => l.length), rawLines.map((l) => l.length));
  });
  it('an unterminated string or comment does not throw and keeps the length', () => {
    strip('a = "never closed\nb = 1;');
    strip('/* never closed\nb = 1;');
    strip('t = `never closed ${x');
  });
  it('POSITIVE CONTROL — code outside literals is untouched byte for byte', () => {
    const src = 'const { a, b } = require(mod);\nif (a < b && b > 0) { return a ?? b; }\n';
    assert.strictEqual(strip(src), src);
  });
});

describe('maskSource — which stripper a file gets is decided once (2026-09-05)', () => {
  const { maskSource } = require('../src/core/source-strip');
  const SHELL = ['#!/usr/bin/env sh', 'case $x in', '  /*)   app_path=$link ;; #(', 'esac', 'eval "set -- $(printf x)"', ''].join('\n');

  it('a shell script (by extension, or extensionless with a shebang) is masked with the shell grammar — `/*)` in a case pattern is code, not a comment opener', () => {
    for (const name of ['gradlew', 'bin/run.sh']) {
      const lines = maskSource(SHELL, name).split('\n');
      assert.match(lines[2], /^\s*\/\*\)\s+app_path=\$link ;;\s*$/, `${name}: ${JSON.stringify(lines[2])} (the trailing #( comment is blanked, the case pattern is not)`);
      assert.match(lines[4], /^eval "/, `${name}: the eval below the case pattern is still code`);
    }
  });

  it('the same bytes as JavaScript open a real block comment', () => {
    const lines = maskSource(SHELL, 'src/x.js').split('\n');
    assert.strictEqual(lines[4].trim(), '', 'everything after /* is comment in JavaScript');
  });

  it('Python by extension; a `#`-comment language by extension; everything else the JavaScript grammar', () => {
    assert.strictEqual(maskSource('x = 1  # comment "q"', 'a.py'), 'x = 1  ' + ' '.repeat(13));
    const yml = maskSource('key: "v"  # c', 'a.yml');
    assert.strictEqual(yml.length, 'key: "v"  # c'.length);
    assert.strictEqual(yml.includes('# c'), false);
    assert.strictEqual(maskSource('const s = "v"; // c', 'a.go'), 'const s = " "; ' + ' '.repeat(4));
  });
});

// A '…' / "…" literal cannot hold a raw newline, so one that reaches the line
// end is unterminated and ends there. Before 2026-09-29 the JS stripper ran
// it on to the next matching quote: an apostrophe in JSX text (DavenRoe
// CookiePolicy.jsx:341, `DavenRoe's cookie use`) opened a "string" that closed
// two lines later and inverted every mask below it — string literals read as
// code, code read as strings, and security's CSRF rule fired on prose (#842).
describe('source-strip — a quoted string ends at the line', () => {
  it("an apostrophe in JSX text does not open a string that runs to the next line's quote (#842 DR-1)", () => {
    const prose = 'Cannot be disabled. Examples: login tokens, CSRF protection.';
    const src = `<p>DavenRoe's cookie use is minimal</p>\nconst d = { desc: '${prose}' };\n`;
    const out = strip(src).split('\n');
    assert.ok(/^<p>DavenRoe' +$/.test(out[0]), out[0]);
    assert.strictEqual(out[1], `const d = { desc: '${' '.repeat(prose.length)}' };`);
  });
  it('a double-quoted string is the same; the newline after it is code again', () => {
    assert.strictEqual(strip('x = "open\ny = "z"\n'), 'x = "    \ny = " "\n');
  });
});
