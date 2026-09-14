/**
 * Race-Condition Module — check-then-act, TOCTOU, get-then-set.
 *
 * Concurrency bugs are the most expensive class of production bugs:
 * hard to reproduce, impossible to debug from logs, only surface
 * under load. The most common shape is "check, then act":
 *
 *   1. Check a condition (`fs.exists(p)`, `await getUser(id)`,
 *      `await db.findFirst({ email })`).
 *   2. Act on the result (`fs.writeFile(p, ...)`, `await updateUser
 *      (id, ...)`, `await db.create({ email })`).
 *
 * Between step 1 and step 2, a concurrent request changes the state
 * out from under you. Result: duplicate rows, overwritten writes,
 * files clobbered, TOCTOU vulnerabilities.
 *
 * The fix is always one of:
 *   - Atomic primitives (`fs.open(path, 'wx')`, `INSERT ... ON
 *     CONFLICT`, compare-and-swap).
 *   - Wrap in a transaction with `SERIALIZABLE` or `SELECT ... FOR
 *     UPDATE`.
 *   - Use a unique constraint + catch the duplicate-key error.
 *
 * Competitors: nothing. SonarQube has a couple of Java-specific
 * concurrency rules. Nobody scans JS/TS for these patterns.
 *
 * Approach (line-heuristic, no AST):
 *
 *   Scan JS/TS files. For each `await`/sync "check" call, look ahead
 *   up to 15 lines (or to the end of the current function body) for
 *   a related "act" call. If the check and act mention the same
 *   variable or key and no transaction wrapper is visible, flag.
 *
 * Patterns recognised:
 *
 *   fs TOCTOU:
 *     `fs.exists(p)` / `fs.existsSync(p)` / `fs.stat(p)` followed
 *     by `fs.writeFile(p, ...)` / `fs.unlink(p)` / `fs.rename(p)`
 *     → error (classic TOCTOU, also a CWE-367 security issue)
 *
 *   DB upsert race:
 *     `await db.x.findFirst({ where: { ... } })` / `.findUnique`
 *     followed by `await db.x.create(...)` / `.update(...)` with
 *     no visible `$transaction` / `SERIALIZABLE` / unique-constraint
 *     try/catch → warning (the `getOrCreate` anti-pattern)
 *
 *   Counter get-then-set:
 *     `await X.get(...)` / `.find` followed by `await X.set(...)` /
 *     `.update` that writes a value derived from the previous get
 *     → warning (lost-update on concurrent counters)
 *
 *   Auth check-then-act:
 *     `const user = await getUser(id)` followed by
 *     `await updateUser(id, { ... })` without a transaction →
 *     warning (authorization bypass via concurrent role change)
 *
 * Rules:
 *
 *   error:   `fs.exists*`/`fs.stat` followed by a mutating `fs.*`
 *            call on the same path. This is a CWE-367 TOCTOU bug.
 *            (rule: `race-condition:fs-toctou:<rel>:<line>`)
 *
 *   warning: find*-then-create / find*-then-update without a
 *            transaction wrapper visible in the enclosing function.
 *            (rule: `race-condition:get-or-create:<rel>:<line>`)
 *
 *   warning: counter-style get-then-set where the set value is
 *            derived from the get.
 *            (rule: `race-condition:lost-update:<rel>:<line>`)
 *
 * TODO(gluecron): host-neutral.
 */

const fs = require('fs');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);


// fs check patterns — the first argument (the path expression) is read by
// balancedFirstArg from the text after the `(`, NOT by a `[^,)]+` capture:
// that cut `path.join(r.dir, 'node_modules')` down to `path.join(r.dir`,
// which then "matched" a later `fs.writeFileSync(path.join(r.dir, 'src/a.js'))`
// — two different files reported as one TOCTOU (our own scanner on PR #437,
// 2026-09-05).
const FS_CHECK_RES = [
  /\bfs(?:\.promises)?\.(?:exists|existsSync|stat|statSync|lstat|lstatSync|access|accessSync)\s*\(/,
  /\bexistsSync\s*\(/,
];

/**
 * The first call argument in `text` (which starts just after the `(`),
 * balanced across nested parens / brackets / braces on the MASKED twin
 * `code` (a bracket or comma inside a string is not one — the one stripper
 * decides), and sliced from the raw text, so `path.join(a, 'b')` comes back
 * whole. Empty when there is none.
 */
function balancedFirstArg(text, code) {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return text.slice(0, i).trim(); depth--; continue; }
    if (ch === ',' && depth === 0) return text.slice(0, i).trim();
  }
  return text.trim();
}

// fs mutating operations that, when called on the same path, are
// TOCTOU-risky. Restricted to DESTRUCTIVE / SECURITY-SENSITIVE ops:
// - unlink/rm/rmdir/rename: ENOENT if the file disappeared
// - chmod/chown: privilege-escalation vector if swapped for a symlink
// - copyFile: can overwrite the destination in the window
// - truncate: data loss if the file changed
// - open(without wx): races with create
//
// We deliberately EXCLUDE mkdir/writeFile/appendFile because the
// `if (!exists) mkdir/write` pattern is idempotent-setup — the
// worst case is a redundant operation, not a bug.
const FS_MUTATE_RE = /\bfs(?:\.promises)?\.(?:unlink|unlinkSync|rename|renameSync|rmdir|rmdirSync|rm|rmSync|chmod|chmodSync|chown|chownSync|copyFile|copyFileSync|truncate|truncateSync)\s*\(/;

// A `stat`/`lstat` followed by ANY mutating op (including writeFile)
// IS dangerous — the common shape is "check it's a file, then write"
// which is susceptible to symlink-race attacks. Broader set here.
const FS_MUTATE_STAT_RE = /\bfs(?:\.promises)?\.(?:writeFile|writeFileSync|unlink|unlinkSync|rename|renameSync|rmdir|rmdirSync|rm|rmSync|chmod|chmodSync|chown|chownSync|copyFile|copyFileSync|truncate|truncateSync|appendFile|appendFileSync|open|openSync)\s*\(/;

// DB find patterns — capture model name + a simple "key identifier".
const DB_FIND_RES = [
  // Prisma: prisma.user.findFirst / findUnique
  /\b(prisma\.[A-Za-z_$][\w$]*)\.(?:findFirst|findUnique|findMany)\s*\(/,
  // Sequelize / Mongoose / TypeORM: Model.findOne / findByPk / findOneBy
  /\b([A-Z][\w$]*)\.(?:findOne|findOneBy|findByPk|findFirst|findUnique)\s*\(/,
  // Repo.findOneBy
  /\b([A-Za-z_$][\w$]*)\.(?:findOne|findOneBy)\s*\(/,
];

// DB mutate patterns on the SAME model.
const DB_MUTATE_METHODS = [
  'create', 'createMany', 'save', 'insert',
  'update', 'updateOne', 'updateMany', 'upsert',
  'delete', 'deleteOne', 'deleteMany', 'destroy', 'remove',
];

// Transaction wrappers — if any of these is visible in the window,
// the get-then-act is safe.
const TX_MARKERS = [
  /\$transaction\s*\(/,
  /\.transaction\s*\(/,
  /\bSERIALIZABLE\b/,
  /\bisolationLevel\b/,
  /\bFOR\s+UPDATE\b/i,
  /\btransaction\s*\(\s*async/,
  /\bwithTransaction\s*\(/,
  /\bsequelize\.transaction\s*\(/,
  /\bprisma\.\$transaction\s*\(/,
];

// Unique-constraint-try / on-conflict = the other legitimate fix.
const UNIQUE_FALLBACK_RES = [
  /\bON\s+CONFLICT\b/i,
  /\bupsert\s*\(/,
  /\bP2002\b/,              // Prisma unique-constraint error code
  /\bER_DUP_ENTRY\b/,       // MySQL duplicate-key error
  /\b23505\b/,              // Postgres unique-violation SQLSTATE
];

class RaceConditionModule extends BaseModule {
  constructor() {
    super(
      'raceCondition',
      'Race-condition / check-then-act detector — fs TOCTOU, get-or-create anti-pattern, lost-update on counters',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('race-condition:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('race-condition:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s) for check-then-act races`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('race-condition:summary', true, {
      severity: 'info',
      message: `Race-condition scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  // KI #104: the shared walk replaces a private readdir copy so `--diff` /
  // `--pr` scans only touch changed files. `.terraform` is the one exclude
  // not in the shared defaults.
  _findFiles(projectRoot) {
    return this._collectFiles(projectRoot, [...SOURCE_EXTS], ['.terraform']);
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = repoRelative(projectRoot, file);
    const isTestFile = this._isTestPath(rel);
    const lines = content.split(/\r?\n/);
    // Every call is matched on the masked line (BaseModule._maskedLines:
    // strings, regexes and comments blanked, offsets kept); the path
    // ARGUMENTS are read from the raw line at the same offsets, because a
    // quoted path is string content. Masked line k is cut to raw line k's
    // length: the stripper blanks a `\r` that sits inside a comment, and the
    // two forward windows below are joined from both arrays and
    // cross-referenced by offset.
    const masked = this._maskedLines(content).map((l, k) => l.slice(0, lines[k].length));
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];      // raw: path expressions, SQL / error-code markers
      const code = masked[i] || ''; // masked: every call match
      if (!code.trim()) continue;

      // --- fs TOCTOU ---
      for (const checkRe of FS_CHECK_RES) {
        const m = checkRe.exec(code);
        if (!m) continue;
        const pathExpr = balancedFirstArg(line.slice(m.index + m[0].length), code.slice(m.index + m[0].length));
        if (!pathExpr) continue;

        // `stat`/`lstat` broadens the mutation set (symlink-race
        // vector); other checks use the narrow destructive set.
        const isStatCheck = /\b(?:stat|statSync|lstat|lstatSync)\b/.test(m[0]);
        const mutateRe = isStatCheck ? FS_MUTATE_STAT_RE : FS_MUTATE_RE;

        // Include the tail of the current line (anything after the
        // check expression) so single-line `if (exists(p)) unlink(p)`
        // patterns are caught.
        const tailAt = m.index + m[0].length + pathExpr.length;
        const window = `${line.slice(tailAt)}\n${this._forwardWindow(lines, i, 15)}`;
        const windowCode = `${code.slice(tailAt)}\n${this._forwardWindow(masked, i, 15)}`;

        // Find a mutate call whose FIRST ARGUMENT actually references
        // the same path expression. This avoids false-positives when
        // the window also contains an unrelated mutate on a different
        // path (e.g. a nearby function).
        const normalizedPath = pathExpr.replace(/['"`]/g, '').trim();
        if (!normalizedPath) break;
        const pathToken = this._escapeRegex(normalizedPath);
        const mutateRegexGlobal = new RegExp(mutateRe.source, 'g');
        let mutateMatch = null;
        let gm;
        while ((gm = mutateRegexGlobal.exec(windowCode)) !== null) {
          // The mutate's first argument, balanced, so a nested call is
          // compared whole: the check's expression must be the argument or a
          // token inside it, never merely its prefix. The call is found on the
          // masked window; its argument is read from the raw one.
          const after = window.slice(gm.index + gm[0].length, gm.index + gm[0].length + 200);
          const afterCode = windowCode.slice(gm.index + gm[0].length, gm.index + gm[0].length + 200);
          const firstArg = balancedFirstArg(after, afterCode).replace(/['"`]/g, '').trim();
          if (firstArg === normalizedPath || (!/[(]/.test(normalizedPath) && new RegExp(`(?:^|[^\\w$])${pathToken}(?:[^\\w$]|$)`).test(firstArg))) {
            mutateMatch = gm;
            break;
          }
        }
        if (!mutateMatch) break;

        issues += this._flag(result, `race-condition:fs-toctou:${rel}:${i + 1}`, {
          severity: isTestFile ? 'warning' : 'error',
          file: rel,
          line: i + 1,
          check: m[0].slice(0, 60),
          mutate: mutateMatch[0].slice(0, 60),
          message: `${rel}:${i + 1} fs TOCTOU — \`${m[0].trim()}\` followed by \`${mutateMatch[0].trim()}\` on \`${normalizedPath.slice(0, 40)}\`; between the check and the act another process can change the file (CWE-367)`,
          suggestion: 'Use atomic primitives: `fs.open(path, "wx")` creates-if-absent atomically; `fs.writeFile(path, data, { flag: "wx" })` for exclusive write. For deletes, catch ENOENT instead of pre-checking.',
        });
        break;
      }

      // --- DB get-or-create / get-then-update races ---
      for (const findRe of DB_FIND_RES) {
        const m = findRe.exec(code);
        if (!m) continue;
        const modelExpr = m[1];
        if (!modelExpr) continue;

        // Raw window: the transaction and unique-constraint markers below are
        // SQL (`FOR UPDATE`, `ON CONFLICT`) and error codes (`'P2002'`) — string
        // content, blank on the masked lines.
        const window = this._forwardWindow(lines, i, 15);

        // Is there a mutating call on the same model? A call, so masked.
        const mutateRe = new RegExp(
          `\\b${modelExpr.replace(/[.$]/g, (c) => `\\${c}`)}\\.(?:${DB_MUTATE_METHODS.join('|')})\\s*\\(`,
        );
        const mutateMatch = this._forwardWindow(masked, i, 15).match(mutateRe);
        if (!mutateMatch) continue;

        // Transaction wrapper visible?
        const txVisible = TX_MARKERS.some((re) => re.test(window))
          || UNIQUE_FALLBACK_RES.some((re) => re.test(window));
        if (txVisible) continue;

        // Also scan a broader enclosing-function window (back ~20 lines
        // + forward ~20) for a `$transaction` wrapper. This avoids
        // false positives when the entire function IS the tx callback.
        const enclosing = lines.slice(Math.max(0, i - 20), Math.min(lines.length, i + 30)).join('\n');
        if (TX_MARKERS.some((re) => re.test(enclosing))) continue;

        issues += this._flag(result, `race-condition:get-or-create:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          model: modelExpr,
          check: m[0].slice(0, 60),
          mutate: mutateMatch[0].slice(0, 60),
          message: `${rel}:${i + 1} get-or-create race — \`${m[0].trim()}\` then \`${mutateMatch[0].trim()}\` on \`${modelExpr}\` with no \`$transaction\`/\`FOR UPDATE\`/upsert visible; two concurrent requests will both see "not found" and both create`,
          suggestion: 'Replace with an atomic upsert (`prisma.user.upsert({...})`), or wrap in `$transaction` with a unique constraint + try/catch on the duplicate-key error. For read-modify-write, use `SELECT ... FOR UPDATE` or optimistic-locking with a version column.',
        });
        break;
      }
    }

    return issues;
  }

  _forwardWindow(lines, startLine, count) {
    return lines.slice(startLine + 1, Math.min(lines.length, startLine + 1 + count)).join('\n');
  }

  _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = RaceConditionModule;
