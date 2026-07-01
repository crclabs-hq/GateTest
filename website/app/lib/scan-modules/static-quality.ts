/**
 * Static-quality scan modules: syntax, lint, codeQuality, documentation.
 *
 * Every check inspects real file content. No defaults, no placeholders.
 */

import type { ModuleContext, ModuleOutput, ModuleRunner, RepoFile } from "./types";

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

function isTestPath(p: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(p) || /\.(test|spec)\./i.test(p);
}

function countOccurrences(haystack: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < haystack.length; i++) if (haystack[i] === ch) n++;
  return n;
}

/**
 * Strips line comments, block comments, and string/template literal
 * CONTENTS (keeping the quote characters themselves as empty pairs) so
 * bracket-balance counting isn't fooled by brace/paren/bracket
 * characters that are just TEXT — CLI help strings ("[options]"),
 * regex literals, JSON examples inside comments, markdown in docstrings.
 *
 * Real bug this fixes: bin/gatetest.js (a CLI with a large embedded
 * --help string full of "[option]"-style usage examples) was flagged
 * with a false "bracket imbalance" — Node's own parser confirmed the
 * file has zero syntax errors. A naive whole-file character count
 * will ALWAYS have this failure mode on any file with substantial
 * string content; this is not a threshold-tuning problem, the
 * counting itself needs to skip non-code text.
 *
 * Not a full tokenizer (no template-literal ${} re-entry, no regex
 * vs division disambiguation) — good enough for a balance CHECK, where
 * the failure mode of "strip a bit too much" (under-count) is far
 * safer than "count text as code" (false positive), since an actually
 * unbalanced file will still show a large, real gap after stripping.
 */
function stripStringsAndComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i++; // skip escaped char
        i++;
      }
      i++; // closing quote
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function sourceFiles(fc: RepoFile[]): RepoFile[] {
  return fc.filter((f) => SOURCE_EXT.test(f.path));
}

export const syntax: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  for (const f of ctx.fileContents) {
    if (SOURCE_EXT.test(f.path)) {
      // Strip strings/comments FIRST — counting brackets in raw file text
      // false-positives on any file with substantial string content (CLI
      // help text, regex literals, JSON-in-comments). See
      // stripStringsAndComments() for the real bug this fixed.
      const code = stripStringsAndComments(f.content);

      const openBr = countOccurrences(code, "{");
      const closeBr = countOccurrences(code, "}");
      checks++;
      if (Math.abs(openBr - closeBr) > 2) {
        issues++;
        details.push(`${f.path}: brace imbalance (${openBr} open vs ${closeBr} close)`);
      }

      const openP = countOccurrences(code, "(");
      const closeP = countOccurrences(code, ")");
      checks++;
      if (Math.abs(openP - closeP) > 2) {
        issues++;
        details.push(`${f.path}: parenthesis imbalance (${openP} vs ${closeP})`);
      }

      const openSq = countOccurrences(code, "[");
      const closeSq = countOccurrences(code, "]");
      checks++;
      if (Math.abs(openSq - closeSq) > 2) {
        issues++;
        details.push(`${f.path}: bracket imbalance (${openSq} vs ${closeSq})`);
      }

      const backticks = countOccurrences(f.content, "`");
      checks++;
      if (backticks % 2 !== 0) {
        issues++;
        details.push(`${f.path}: unterminated template literal (${backticks} backticks)`);
      }
    }

    if (f.path.toLowerCase().endsWith(".json")) {
      checks++;
      try {
        JSON.parse(f.content);
      } catch (e) {
        issues++;
        const msg = e instanceof Error ? e.message : String(e);
        details.push(`${f.path}: invalid JSON (${msg})`);
      }
    }
  }

  if (checks === 0) return { checks: 0, issues: 0, details, skipped: "no readable files to parse" };
  return { checks, issues, details };
};

export const lint: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  const targets = ctx.fileContents.filter(
    (f) => SOURCE_EXT.test(f.path) && !isTestPath(f.path)
  );

  for (const f of targets) {
    checks++;
    if (/\bvar\s+\w/.test(f.content)) {
      issues++;
      details.push(`${f.path}: uses legacy 'var' declaration`);
    }

    checks++;
    if (/[^=!]==[^=]|[^!]!=[^=]/.test(f.content)) {
      issues++;
      details.push(`${f.path}: uses loose equality (== or !=) instead of === / !==`);
    }

    const lines = f.content.split("\n");
    let longLineCount = 0;
    for (const ln of lines) if (ln.length > 200) longLineCount++;
    checks++;
    if (longLineCount > 0) {
      issues++;
      details.push(`${f.path}: ${longLineCount} line(s) exceed 200 characters`);
    }

    checks++;
    let run = 0;
    let maxRun = 0;
    let inFn = false;
    for (const ln of lines) {
      if (!inFn && /\bfunction\b|=>/.test(ln)) inFn = true;
      if (inFn) {
        if (ln.trim() === "") {
          if (run > maxRun) maxRun = run;
          run = 0;
          inFn = false;
        } else run++;
      }
    }
    if (run > maxRun) maxRun = run;
    if (maxRun > 50) {
      issues++;
      details.push(`${f.path}: function spans ${maxRun} consecutive non-empty lines (>50)`);
    }

    let trailingCount = 0;
    for (const ln of lines) if (/[ \t]+$/.test(ln)) trailingCount++;
    checks++;
    if (trailingCount > 5) {
      issues++;
      details.push(`${f.path}: ${trailingCount} lines with trailing whitespace`);
    }
  }

  if (checks === 0) return { checks: 0, issues: 0, details, skipped: "no lintable source files" };
  return { checks, issues, details };
};

export const codeQuality: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  const targets = sourceFiles(ctx.fileContents).filter((f) => !isTestPath(f.path));

  for (const f of targets) {
    checks++;
    if (/console\.(log|debug|info)\(/.test(f.content)) {
      issues++;
      details.push(`${f.path}: contains console.log/debug/info call`);
    }

    checks++;
    if (/\bdebugger\b/.test(f.content)) {
      issues++;
      details.push(`${f.path}: contains 'debugger' statement`);
    }

    checks++;
    if (/\/\/\s*(todo|fixme|hack|xxx)\b/i.test(f.content)) {
      issues++;
      details.push(`${f.path}: contains TODO/FIXME/HACK/XXX marker`);
    }

    checks++;
    if (/\beval\s*\(/.test(f.content)) {
      issues++;
      details.push(`${f.path}: uses eval()`);
    }

    const lines = f.content.split("\n");
    checks++;
    if (lines.length > 500) {
      issues++;
      details.push(`${f.path}: ${lines.length} lines (>500)`);
    }

    checks++;
    let deep = false;
    for (const ln of lines) {
      const leadingSpaces = ln.match(/^ +/)?.[0].length ?? 0;
      const leadingTabs = ln.match(/^\t+/)?.[0].length ?? 0;
      if (leadingSpaces > 20 || leadingTabs > 5) {
        deep = true;
        break;
      }
    }
    if (deep) {
      issues++;
      details.push(`${f.path}: deep nesting detected (indent >20 spaces or >5 tabs)`);
    }

    checks++;
    let longFn = false;
    for (const ln of lines) {
      if (ln.length > 200 && /\bfunction\b|=>/.test(ln)) {
        longFn = true;
        break;
      }
    }
    if (longFn) {
      issues++;
      details.push(`${f.path}: single-line function declaration over 200 chars`);
    }
  }

  if (checks === 0) return { checks: 0, issues: 0, details, skipped: "no source files to inspect" };
  return { checks, issues, details };
};

export const documentation: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  const hasFile = (name: string): boolean =>
    ctx.files.some((p) => p.toLowerCase() === name.toLowerCase());
  const hasAny = (names: string[]): boolean => names.some((n) => hasFile(n));

  checks++;
  if (!hasFile("README.md")) {
    issues++;
    details.push("repo: missing README.md at root");
  }

  checks++;
  if (!hasAny(["LICENSE", "LICENSE.md", "LICENSE.txt"])) {
    issues++;
    details.push("repo: missing LICENSE file");
  }

  checks++;
  if (!hasAny(["CHANGELOG.md", "CHANGES.md"])) {
    issues++;
    details.push("repo: missing CHANGELOG.md / CHANGES.md");
  }

  checks++;
  if (!hasFile(".env.example")) {
    issues++;
    details.push("repo: missing .env.example (required env vars not documented)");
  }

  const pkg = ctx.fileContents.find((f) => f.path === "package.json");
  if (pkg) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(pkg.content) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    for (const field of ["description", "repository", "license"]) {
      checks++;
      if (!parsed || !parsed[field]) {
        issues++;
        details.push(`package.json: missing '${field}' field`);
      }
    }
  }

  const src = sourceFiles(ctx.fileContents);
  if (src.length > 0) {
    checks++;
    let documented = 0;
    for (const f of src) {
      if (f.content.trimStart().startsWith("/**")) documented++;
    }
    const ratio = documented / src.length;
    if (ratio < 0.2) {
      issues++;
      details.push(
        `docs: only ${documented}/${src.length} source files (${Math.round(ratio * 100)}%) have file-level JSDoc (<20%)`
      );
    }
  }

  if (checks === 0) return { checks: 0, issues: 0, details, skipped: "repo tree empty" };
  return { checks, issues, details };
};
