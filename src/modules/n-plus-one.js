/**
 * N+1 Query Module — database queries inside loops.
 *
 * The N+1 query is the single most common performance bug in every
 * backend codebase we've scanned. Fetch a list of 100 users, then
 * iterate and load each user's orders with a separate query = 101
 * round-trips. Fine on 100 users in staging, catastrophic on 10k
 * users in prod. ORMs make this worse because the `await
 * user.orders` syntax hides the SQL completely.
 *
 * Every competitor either:
 *   a) Profiles at runtime (New Relic, Datadog) — too late, already
 *      in prod.
 *   b) Ships an ORM-specific linter (e.g. prisma-lint-find-many) —
 *      catches one ORM, misses the rest.
 *
 * We scan source statically, ORM-agnostic, zero-dep. Catches every
 * major ORM surface + raw SQL driver calls.
 *
 * Approach (line-heuristic, no AST):
 *
 *   1. Walk JS/TS files. For each file, find the start and end of
 *      every loop block (simple brace-matching, string-aware).
 *   2. Inside each loop body, look for a line that both:
 *        a) uses `await` (or a `.then(` chain), AND
 *        b) calls a known query-shaped method.
 *   3. Flag each occurrence with the loop's start line too.
 *
 * Query-shaped methods recognised:
 *
 *   Prisma:    `prisma.<model>.(findUnique|findMany|findFirst|create|update|delete|upsert|count)(`
 *   Sequelize: `<Model>.(findOne|findAll|findByPk|create|update|destroy|count)(`
 *              `sequelize.query(`
 *   TypeORM:   `<repo>.(findOne|findOneBy|find|save|remove|update|count)(`
 *              `getRepository(`, `.manager.(save|remove|find)(`
 *   Mongoose:  `<Model>.(findOne|find|create|updateOne|updateMany|deleteOne|deleteMany|countDocuments|aggregate)(`
 *   Knex:      `knex(`, `db(`, `.where(...).first()`, `.where(...).select()`
 *   node-pg:   `client.query(`, `pool.query(`, `db.query(`
 *   MySQL:     `connection.execute(`, `connection.query(`, `pool.execute(`
 *   Drizzle:   `db.select().from(`, `db.insert(`, `db.update(`, `db.delete(`
 *   Generic:   `db.<anything>(`, `orm.<anything>(`, `repo.<anything>(`
 *
 * Rules:
 *
 *   error:   A query-shaped `await` occurs inside a `for`, `while`,
 *            `do...while`, `for..of`, `for..in`, `.map(`, `.forEach(`,
 *            `.filter(`, `.reduce(`, `.some(`, `.every(` loop body.
 *            Severity error because the runtime cost is linear in
 *            the input size and usually hits prod exactly when it
 *            hurts.
 *            (rule: `n-plus-one:query-in-loop:<rel>:<line>`)
 *
 *   info:    Loop body uses `await Promise.all(...)` over an array
 *            .map that itself contains a query — this is the fix
 *            shape, recorded for dashboard confidence.
 *            (rule: `n-plus-one:batched-ok:<rel>:<line>`)
 *
 * TODO(gluecron): Once Gluecron ships a first-party ORM, add its
 * method signatures to the query-method table.
 */

const fs = require('fs');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { HARNESS_DIR_RE } = require('../core/scan-scope');

// Excludes beyond BaseModule._collectFiles' defaults (KI #104).
const EXTRA_EXCLUDES = ['.terraform'];

const SOURCE_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

// Regexes that, when they match a line INSIDE a loop, signal a
// potential N+1. Any of these matching is sufficient.
const QUERY_METHOD_RES = [
  // Prisma — `prisma.user.findMany(...)`, `prisma.$queryRaw(...)`
  /\bprisma\.[A-Za-z_$][\w$]*\.(?:findUnique|findFirst|findMany|create|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\s*\(/,
  /\bprisma\.\$(?:queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)\s*[`(]/,
  // Sequelize / TypeORM / Mongoose — `Model.findOne(...)` with capitalised identifier
  /\b[A-Z][\w$]*\.(?:findOne|findAll|findByPk|findOneBy|find|create|update|updateOne|updateMany|destroy|deleteOne|deleteMany|remove|save|count|countDocuments|aggregate)\s*\(/,
  // TypeORM repository / Sequelize sequelize.query
  /\bsequelize\.query\s*\(/,
  /\bgetRepository\s*\(/,
  /\.manager\.(?:save|remove|find|findOne|update|delete|count)\s*\(/,
  /\brepo(?:sitory)?\.(?:findOne|findOneBy|find|save|remove|update|count|delete)\s*\(/,
  // Raw drivers — client/pool/db/connection
  /\b(?:client|pool|db|connection|conn)\.(?:query|execute|prepare|run|get|all|each)\s*[`(]/,
  // Knex — typical `knex('table').where(...).first()` or `db('table').select()`
  /\bknex\s*\(/,
  knexTableCall, // `db('table').where(...)` — table name read from the raw line, see below
  // Drizzle — `db.select().from(users)`, `db.insert(users)`, etc.
  /\bdb\.(?:select|insert|update|delete)\s*\(/,
  // Generic ORM-ish
  /\borm\.[A-Za-z_$][\w$]*\s*\(/,
];

// The raw-driver shape above (`client.query(`, `connection.execute(`…) is
// the only one whose ARGUMENT decides whether the loop is an N+1. Measured
// on prisma/prisma @ HEAD (2026-09-05): 25 `query-in-loop` findings, 6 of
// them blocking, and not one a per-row lookup —
//   for (let i = 0; i < count; i++) await client.query(`CREATE DATABASE prisma_rec_${i}`)
//   while (…) { try { await client.query('SELECT 1'); break; } catch … }   (wait-for-db)
//   for (const statement of setupSql) await connection.query(statement)
// DDL, session control and `SELECT 1` cannot be batched into one query —
// there is no "collect the ids first" for CREATE DATABASE — so those are
// not reported. An OPAQUE statement (`query(statement)`, `query(step.sql,
// params)`) is a statement LIST being replayed far more often than a
// per-row lookup, but the line cannot tell, so it is reported as a warning
// that says so (Doctrine §1: three states, and the third is printed).
const RAW_DRIVER_RE = /\b(?:client|pool|db|connection|conn)\.(?:query|execute|prepare|run|get|all|each)\s*[`(]/;
const NOT_N_PLUS_ONE_SQL_RE = /^\s*(?:CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|SET|RESET|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ANALYZE|ANALYSE|USE|PRAGMA|LOCK|UNLOCK|COMMENT|SELECT\s+1\b)/i;
const OPAQUE_STATEMENT_RE = /^\s*[A-Za-z_$][\w$]*(?:\s*[.?]\s*[A-Za-z_$][\w$]*|\s*!)*\s*[,)]/;

// Loop-opening patterns. Each entry: regex + hint about whether it's
// a "block-form" loop (needs brace matching) or a "callback-form"
// loop (the callback's body is the loop body).
const LOOP_OPENERS = [
  // Block-form: `for (...)`, `while (...)`, `do {`
  { re: /\bfor\s*\(/, kind: 'block' },
  { re: /\bwhile\s*\(/, kind: 'block' },
  { re: /\bdo\s*\{/, kind: 'block' },
  // Callback-form: `.map(`, `.forEach(`, `.filter(`, `.reduce(`,
  // `.some(`, `.every(`, `.flatMap(`
  { re: /\.(?:map|forEach|filter|reduce|some|every|flatMap)\s*\(/, kind: 'callback' },
];

// Every deciding regex runs on the MASKED line (BaseModule._maskedLines:
// string, regex and comment content blanked, offsets preserved). The raw
// line is read only for text that lives inside quotes: a knex table name,
// and the SQL literal handed to a raw driver.
const KNEX_TABLE_RE = /\bdb\s*\(\s*(['"`]) *\1\s*\)\s*\.(?:where|select|first|insert|update|del|count|returning)/;

// `db('users').where(...)`: the call shape on the masked line, the table
// name — one word between the quotes — on the raw one at the same offset.
function knexTableCall(code, line) {
  const m = KNEX_TABLE_RE.exec(code);
  if (!m) return null;
  const open = m.index + m[0].search(/['"`]/) + 1;
  return /^[\w]+['"`]/.test(line.slice(open)) ? m : null;
}

class NPlusOneModule extends BaseModule {
  constructor() {
    super(
      'nPlusOne',
      'N+1 query detector — database calls inside loops across Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle, node-pg, MySQL',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    // Shared walk replaced a private readdir sweep so --diff scans shrink the file set (KI #104).
    const files = this._collectFiles(projectRoot, SOURCE_EXTS, EXTRA_EXCLUDES);

    if (files.length === 0) {
      result.addCheck('n-plus-one:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('n-plus-one:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s)`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('n-plus-one:summary', true, {
      severity: 'info',
      message: `N+1 scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = repoRelative(projectRoot, file);
    const lines = content.split(/\r?\n/);
    const masked = this._maskedLines(content);
    let issues = 0;

    // Build a depth-map: for each character index, how many braces
    // deep inside a loop we are. This lets us ask "is line N inside a
    // loop?" without parsing.
    const loopRanges = this._findLoopRanges(masked);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];      // raw: the SQL literal, the knex table name
      const code = masked[i] || ''; // masked: every pattern match
      if (!code.trim()) continue;

      const loopStart = this._enclosingLoopStart(loopRanges, i);
      if (loopStart == null) continue;

      // Must be an awaited/chained call (to keep false-positive rate
      // low — synchronous reads of in-memory data aren't N+1).
      const hasAwait = /\bawait\b/.test(code);
      const hasThen = /\.(?:then|catch|finally)\s*\(/.test(code);
      if (!hasAwait && !hasThen) continue;

      // Check against every query method regex.
      let matched = null;
      let argStart = -1;
      for (const re of QUERY_METHOD_RES) {
        const m = typeof re === 'function' ? re(code, line) : code.match(re);
        if (m) { matched = m[0]; argStart = m.index + m[0].length; break; }
      }
      if (!matched) continue;

      const argKind = this._rawDriverArgKind(line, code, matched, argStart);
      if (argKind === 'not-n-plus-one') continue;
      const opaque = argKind === 'opaque';

      // Is this a batched fix shape? `await Promise.all(list.map(...))`
      // — the inner `.map()` creates an array of promises; the DB
      // call happens once per array element in parallel, which is
      // *not* an N+1 in the round-trips-per-request sense.
      // Heuristic: if the enclosing loop opener is a `.map(` and the
      // enclosing context is `Promise.all(` (look up a few lines),
      // classify as batched-ok.
      const enclosingLoop = masked[loopStart] || '';
      const isMap = /\.map\s*\(/.test(enclosingLoop);
      const precedingWindow = masked.slice(Math.max(0, loopStart - 2), loopStart + 1).join('\n');
      const isBatched = isMap && /\bPromise\.all\s*\(/.test(precedingWindow);

      if (isBatched) {
        result.addCheck(`n-plus-one:batched-ok:${rel}:${i + 1}`, true, {
          severity: 'info',
          file: rel,
          line: i + 1,
          loopStart: loopStart + 1,
          message: `${rel}:${i + 1} query inside \`Promise.all(arr.map(...))\` — batched-parallel, not an N+1`,
        });
        continue;
      }

      // A test or benchmark harness seeding rows in a loop is not a
      // production round-trip. Same split error-swallow makes: `_isTestPath`
      // plus the engine's one definition of a harness dir. Nineteen of
      // prisma's 25 were `db.public.X.create(…)` in test setup. SCOPE
      // changes the severity, never the report — the finding still prints.
      const isHarness = this._isTestPath(rel) || HARNESS_DIR_RE.test(rel.replace(/\\/g, '/'));
      const severity = isHarness || opaque ? 'warning' : 'error';
      const why = opaque
        ? `executes a pre-built statement per iteration (loop opens at line ${loopStart + 1}) — a statement list being replayed is not an N+1, a per-row lookup is; the line cannot tell which, so verify`
        : `database query inside a loop body (loop opens at line ${loopStart + 1}) — every iteration hits the database, producing an N+1 pattern that is fast in staging and slow in prod`;
      issues += this._flag(result, `n-plus-one:query-in-loop:${rel}:${i + 1}`, {
        severity,
        file: rel,
        line: i + 1,
        loopStart: loopStart + 1,
        match: matched.slice(0, 60),
        ...(isHarness ? { harness: true } : {}),
        ...(opaque ? { opaque: true } : {}),
        message: `${rel}:${i + 1} ${why}${isHarness ? ' (test/benchmark harness — warning, not a verdict)' : ''}`,
        suggestion: 'Batch: collect the IDs first and issue one query (e.g. `prisma.user.findMany({ where: { id: { in: ids } } })`), or wrap with `await Promise.all(list.map(async (x) => ...))` to run queries in parallel. For write-heavy loops, use a bulk insert / `createMany`.',
      });
    }

    return issues;
  }

  /**
   * For a raw-driver call (`client.query(…)`), what the FIRST ARGUMENT says
   * about the loop: 'not-n-plus-one' for a DDL / session-control / `SELECT 1`
   * literal, 'opaque' for a pre-built statement passed by name, 'lookup'
   * otherwise (and for every ORM shape, whose argument is irrelevant).
   */
  _rawDriverArgKind(line, code, matched, argStart) {
    if (!RAW_DRIVER_RE.test(matched)) return 'lookup';
    const arg = line.slice(argStart - 1); // raw, including the `(` or backtick: the SQL text is inside the quotes
    const literal = /^[`(]\s*(['"`])([\s\S]*?)(?:\1|$)/.exec(arg) || /^`([\s\S]*?)(?:`|$)/.exec(arg);
    const sqlText = literal ? (literal[2] !== undefined ? literal[2] : literal[1]) : null;
    if (sqlText != null) return NOT_N_PLUS_ONE_SQL_RE.test(sqlText) ? 'not-n-plus-one' : 'lookup';
    return OPAQUE_STATEMENT_RE.test(code.slice(argStart)) ? 'opaque' : 'lookup';
  }

  // Find all loop ranges in the file. Returns an array of
  // { start, end } line indices (inclusive start, exclusive end —
  // the range represents the loop body). Handles both:
  //   - block-form `for (...) {`: body = brace-matched block
  //   - callback-form `.map(async (x) => { ... })`: body = the
  //     arrow-function's block body (or a single-expression arrow)
  _findLoopRanges(masked) {
    const ranges = [];

    // Walk line-by-line looking for loop openers.
    for (let i = 0; i < masked.length; i += 1) {
      const line = masked[i];
      for (const { re, kind } of LOOP_OPENERS) {
        const m = line.match(re);
        if (!m) continue;

        if (kind === 'block') {
          // Find the `{` that opens the body. For `for`/`while` this
          // is the first `{` at depth 0 after the matching `)`. For
          // `do`, it's the `{` on this line.
          const braceLine = this._findOpenBraceLine(masked, i);
          if (braceLine < 0) continue;
          const end = this._findMatchingBrace(masked, braceLine);
          if (end < 0) continue;
          ranges.push({ start: braceLine, end });
        } else {
          // Callback form: the body is inside the method's parens.
          // We use the paren-matching approach: from the `(` after the
          // method name, walk forward, balancing parens, and accept
          // either a `{...}` block body or a single-line arrow.
          const end = this._findCallbackEnd(masked, i, m.index + m[0].length - 1);
          if (end < 0) continue;
          ranges.push({ start: i, end });
        }
      }
    }
    return ranges;
  }

  _findOpenBraceLine(masked, startLine) {
    let depthParen = 0;
    let seenOpenParen = false;
    for (let i = startLine; i < masked.length && i < startLine + 30; i += 1) {
      const line = masked[i];
      for (let j = 0; j < line.length; j += 1) {
        const ch = line[j];
        if (ch === '(') { depthParen += 1; seenOpenParen = true; }
        else if (ch === ')') { depthParen -= 1; }
        else if (ch === '{' && (depthParen === 0 || !seenOpenParen)) {
          return i;
        }
      }
    }
    return -1;
  }

  _findMatchingBrace(masked, braceLine) {
    let depth = 0;
    let started = false;
    for (let i = braceLine; i < masked.length && i < braceLine + 200; i += 1) {
      const line = masked[i];
      for (let j = 0; j < line.length; j += 1) {
        const ch = line[j];
        if (ch === '{') { depth += 1; started = true; }
        else if (ch === '}') {
          depth -= 1;
          if (started && depth === 0) return i;
        }
      }
    }
    return -1;
  }

  _findCallbackEnd(masked, startLine, openParenIdx) {
    let depth = 0;
    let started = false;
    for (let i = startLine; i < masked.length && i < startLine + 200; i += 1) {
      const line = masked[i];
      const startCol = i === startLine ? openParenIdx : 0;
      for (let j = startCol; j < line.length; j += 1) {
        const ch = line[j];
        if (ch === '(') { depth += 1; started = true; }
        else if (ch === ')') {
          depth -= 1;
          if (started && depth === 0) return i;
        }
      }
    }
    return -1;
  }

  _enclosingLoopStart(ranges, lineIdx) {
    // Return the start line of the INNERMOST loop that strictly
    // encloses `lineIdx`, or null.
    let best = null;
    for (const r of ranges) {
      if (r.start < lineIdx && lineIdx <= r.end) {
        if (best == null || r.start > best) best = r.start;
      }
    }
    return best;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = NPlusOneModule;
