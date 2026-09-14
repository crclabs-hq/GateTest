/**
 * Data Integrity Module - Deep validation of data handling, migrations, models,
 * PII compliance, backup procedures, and data validation patterns.
 */

const BaseModule = require('./base-module');
const { hasMutatingHandler } = require('../core/route-grammar');
const { scanMigrationDirs, listMigrationFiles } = require('../core/migration-dirs');
const { JS_SOURCE_EXTS, JS_SOURCE_EXTS_NO_JSX } = require('../core/source-extensions');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');

class DataIntegrityModule extends BaseModule {
  constructor() {
    super('dataIntegrity', 'Data Integrity Validation');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // One walk for both migration rules, by the shared convention
    // (src/core/migration-dirs.js). Until 2026-09-05 this module probed
    // four literal root paths and read only the files directly inside, so
    // Rails `db/migrate`, Alembic `alembic/versions`, Flyway, Django
    // `<app>/migrations`, Supabase, Drizzle — and Prisma's own nested
    // `prisma/migrations/<ts>/migration.sql` — all read as "no migrations".
    // Fixture trees under test paths (django's `tests/migrations/`, rails'
    // `test/dummy/db/migrate`) are not production migrations, and a dir
    // merely NAMED like one (`django/db/migrations/` is Django's migration
    // framework) is not a tree; both are reported as not checked
    // (Doctrine §6) rather than silently passed.
    const { dirs: allDirs, skipped } = scanMigrationDirs(projectRoot);
    const migrationDirs = allDirs.filter((d) => !this._isTestPath(d.rel));
    const notChecked = [
      ...allDirs.filter((d) => this._isTestPath(d.rel)).map((d) => `${d.rel} (fixture)`),
      ...skipped.map((d) => `${d.rel} (${d.reason})`),
    ];

    this._checkMigrations(projectRoot, result, migrationDirs, notChecked);
    this._checkModels(projectRoot, result);
    this._checkPiiHandling(projectRoot, result);
    this._checkDataValidation(projectRoot, result);
    this._checkSqlInjection(projectRoot, result);
    this._checkIdempotency(projectRoot, result, migrationDirs);
    this._checkBackupConfig(projectRoot, result);
  }

  _checkMigrations(projectRoot, result, migrationDirs, notCheckedDirs) {
    const notChecked = notCheckedDirs.length
      ? ` — not checked: ${notCheckedDirs.join(', ')}`
      : '';

    if (migrationDirs.length === 0) {
      result.addCheck('data:migrations', true, {
        message: `No migration directory found — skipping${notChecked}`,
        severity: 'info',
      });
      return;
    }

    const perDir = migrationDirs.map((d) => ({ ...d, files: this._migrationStatements(d.abs) }));
    const total = perDir.reduce((n, d) => n + d.files.length, 0);
    result.addCheck('data:migrations-exist', true, {
      message: `${total} migration file(s) found in ${perDir.map((d) => d.rel).join(', ')}${notChecked}`,
      severity: 'info',
    });

    for (const dir of perDir) {
      this._checkMigrationNaming(dir, result);
      for (const filePath of dir.files) this._checkDestructiveMigration(projectRoot, filePath, result);
    }
  }

  /**
   * The files in a tree an author WROTE. Tool state beside them — Drizzle's
   * `_journal.json`, Prisma 8's `ops.json` / `migration.json` manifests —
   * embeds the same DDL as data, and its `precheck` blocks are the tool's own
   * idempotency; a substring rule reading "CREATE TABLE" out of that JSON
   * reported "not idempotent" on a migration that checks before it creates
   * (prisma corpus, 2026-09-05).
   */
  _migrationStatements(dirAbs) {
    return listMigrationFiles(dirAbs).filter((f) => !/\.json$/i.test(f));
  }

  /**
   * Migration ORDER should be visible in the name. Whether it is was decided
   * by the shared convention (`ORDERED_NAME_RE` in src/core/migration-dirs.js
   * — the entry in the migration root, since Prisma stamps the DIRECTORY, not
   * the file): the only tree that reaches here unordered is a hand-named raw
   * SQL set, which is exactly what this rule is for.
   */
  _checkMigrationNaming(dir, result) {
    if (dir.ordered) return;
    result.addCheck(`data:migration-naming:${dir.rel}`, false, {
      file: dir.rel,
      severity: 'warning',
      message: `Migration files in ${dir.rel} lack sequential or timestamp naming`,
      suggestion: 'Use timestamp or sequential naming: 001_create_users.sql, 002_add_email.sql',
    });
  }

  /** Destructive operations without safeguards, in one migration file. */
  _checkDestructiveMigration(projectRoot, filePath, result) {
    const file = repoRelative(projectRoot, filePath);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8').toLowerCase();
    } catch { return; /* error-ok — unreadable migration file, nothing to judge */ }

    if (content.includes('drop table') && !content.includes('if exists')) {
      result.addCheck(`data:migration-drop:${file}`, false, {
        file,
        severity: 'error',
        message: 'DROP TABLE without IF EXISTS — dangerous in production',
        suggestion: 'Use DROP TABLE IF EXISTS for safety',
      });
    }

    if (content.includes('truncate')) {
      result.addCheck(`data:migration-truncate:${file}`, false, {
        file,
        severity: 'error',
        message: 'TRUNCATE in migration — will destroy data in production',
        suggestion: 'Avoid TRUNCATE in migrations; use conditional deletes instead',
      });
    }

    // Check for NOT NULL without DEFAULT on ALTER TABLE
    if (content.includes('alter table') && content.includes('not null') && !content.includes('default')) {
      result.addCheck(`data:migration-notnull:${file}`, false, {
        file,
        severity: 'warning',
        message: 'Adding NOT NULL column without DEFAULT — will fail on existing rows',
        suggestion: 'Add DEFAULT value or make the migration multi-step',
      });
    }
  }

  _checkModels(projectRoot, result) {
    // Prisma — and then the Mongoose sweep regardless. Until 2026-09-05 a
    // Prisma schema `return`ed here, so a repo carrying both (the shape of
    // every Mongo → Postgres migration in progress) never had its Mongoose
    // schemas checked.
    const prismaSchema = path.join(projectRoot, 'prisma/schema.prisma');
    const hasPrisma = fs.existsSync(prismaSchema);
    if (hasPrisma) {
      // Never let `npx` DOWNLOAD prisma to validate with it: on a fresh
      // clone that spent 60 s fetching the CLI, then reported a blocking
      // "schema validation failed" (2026-08-18 audit). Not installed → skip.
      const prismaInstalled = fs.existsSync(path.join(projectRoot, 'node_modules', 'prisma'));
      if (!prismaInstalled) {
        result.addCheck('data:prisma-schema', true, {
          severity: 'info',
          message: 'Prisma schema present but the prisma CLI is not installed in this environment — validation deferred to CI',
          suggestion: 'Run "npm ci" before scanning to include schema validation',
        });
      } else {
        const { exitCode, stdout, stderr } = this._exec('npx --no-install prisma validate 2>&1', { cwd: projectRoot });
        if (exitCode === 0) {
          result.addCheck('data:prisma-schema', true, { message: 'Prisma schema valid' });
        } else if (/could not determine executable|not found|ENOENT|Cannot find module/i.test(stdout + stderr)) {
          result.addCheck('data:prisma-schema', true, {
            severity: 'info',
            message: 'prisma CLI could not start in this environment — validation deferred to CI',
          });
        } else {
          result.addCheck('data:prisma-schema', false, {
            message: 'Prisma schema validation failed',
            details: (stdout + stderr).split(/\r?\n/).slice(-15),
            suggestion: 'Run "npx prisma validate" to see errors',
          });
        }
      }

      // Check for missing @unique / @@unique constraints
      const schema = fs.readFileSync(prismaSchema, 'utf-8');
      if (schema.includes('email') && !schema.includes('@unique')) {
        result.addCheck('data:prisma-unique', false, {
          file: 'prisma/schema.prisma',
          severity: 'warning',
          message: 'Email field found without @unique constraint',
          suggestion: 'Add @unique to email fields to prevent duplicates',
        });
      }
    }

    // Mongoose
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS_NO_JSX);
    let hasMongoose = false;
    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('mongoose.Schema') || content.includes('new Schema(')) {
        hasMongoose = true;
        const relPath = repoRelative(projectRoot, file);

        // Check for missing validation
        if (!content.includes('required:') && !content.includes('validate:')) {
          result.addCheck(`data:mongoose-validation:${relPath}`, false, {
            file: relPath,
            severity: 'warning',
            message: 'Mongoose schema without field validation',
            suggestion: 'Add required/validate constraints to schema fields',
          });
        }
      }
    }

    if (!hasMongoose && !hasPrisma) {
      result.addCheck('data:models', true, {
        message: 'No ORM schema detected — skipping',
        severity: 'info',
      });
    }
  }

  _checkPiiHandling(projectRoot, result) {
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS);

    const piiPatterns = [
      { regex: /console\.(log|info|debug)\s*\(.*(?:email|password|ssn|credit.?card|phone)/gi, type: 'PII in logs' },
      {
        regex: /JSON\.stringify\s*\(.*(?:password|secret|token)/gi,
        type: 'Sensitive data serialized',
        // A credential serialized as an HTTP REQUEST BODY is the credential
        // doing its job, not leaking. `body: JSON.stringify({ token })` is the
        // shape of every login form and every "save my API key" form ever
        // written — including this repo's own admin PAT form
        // (website/app/admin/tabs/AccountsTab.tsx:49), which POSTs the token to
        // our own API so it can be stored. Nothing is written to a log, a
        // URL, or localStorage; the matching read path already returns only
        // the last four characters.
        //
        // What this rule is actually for is serialization to somewhere
        // OBSERVABLE or PERSISTENT — console.log(JSON.stringify({password})),
        // localStorage.setItem(k, JSON.stringify({token})), an error string, a
        // query param. Those all still fire, because only the `body:`/`body =`
        // position is exempt.
        exempt: (line, index) => /\bbody\s*[:=]\s*$/.test(line.slice(0, index)),
      },
      { regex: /localStorage\.setItem\s*\(.*(?:token|password|secret)/gi, type: 'Sensitive data in localStorage' },
      { regex: /document\.cookie\s*=.*(?:token|password|auth)/gi, type: 'Sensitive data in cookies' },
    ];

    // Suppression: a line containing `// pii-ok` or `// data-ok` is excluded.
    const PII_OK = /\/\/\s*(pii-ok|data-ok)\b/;

    let piiCount = 0;
    for (const file of jsFiles) {
      const relPath = repoRelative(projectRoot, file);
      if (this._isTestPath(relPath)) continue;
      // Skip GateTest's own scanner modules — they contain detection patterns
      // (e.g. regex strings matching console.log(password)) that are not PII leaks.
      if (/^src[\\/]modules[\\/]/.test(relPath)) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      // Strings, regex literals and comments blanked to spaces, offsets kept
      // (BaseModule._maskedLines — the one stripper). The PII regexes read
      // words out of string content (`console.log('password:', pw)`), so
      // they run on the raw line; whether the match START is code is decided
      // against the masked line: a character the mask blanked sits inside a
      // string literal or a comment. The per-line quote counter this
      // replaced (2026-09-05) could not see a template literal or a block
      // comment that spans lines.
      const masked = this._maskedLines(content);

      for (const { regex, type, exempt } of piiPatterns) {
        regex.lastIndex = 0;
        // Check each line individually so suppression comments can work.
        // Also skip if the ENTIRE file has a file-level suppression.
        //
        // exec, not test, so there is a match POSITION to judge — the same change
        // KI #77 made to security.js and data-integrity's own SQL rule, for the
        // same two reasons:
        //   1. `console.log(user.password)` quoted inside a string literal, or sat
        //      in a comment, does not log anything. Reported at ERROR severity it
        //      blocks a build over a code sample (Forbidden #25). Caught by
        //      tests/heavy/inert-fixture-sweep.test.js — this rule was the one
        //      remaining unguarded PII path after the SQL rule was fixed.
        //   2. the finding carried no line or column, so the confidence scorer had
        //      no position to reason about and had to fall back to whole-line
        //      guessing. Both are now passed through.
        let hit = null;
        for (let i = 0; i < lines.length && !hit; i++) {
          const line = lines[i];
          const prevLine = i > 0 ? lines[i - 1] : '';
          if (PII_OK.test(line) || PII_OK.test(prevLine)) continue;
          if (this._isCommentLine(line)) continue;
          regex.lastIndex = 0;
          const m = regex.exec(line);
          if (!m) continue;
          if (this._insideLiteral(masked, lines, i, m.index)) continue;
          if (exempt && exempt(line, m.index)) continue;
          hit = { line: i + 1, column: m.index + 1 };
        }
        if (hit) {
          piiCount++;
          if (piiCount <= 5) {
            result.addCheck(`data:pii:${type}:${relPath}`, false, {
              file: relPath,
              line: hit.line,
              column: hit.column,
              severity: 'error',
              message: `Potential ${type} detected`,
              suggestion: 'Ensure PII is never logged, serialized unsafely, or stored in localStorage',
            });
          }
        }
      }
    }

    if (piiCount > 5) {
      result.addCheck('data:pii-count', false, {
        severity: 'error',
        message: `${piiCount} PII handling issues found (showing first 5)`,
      });
    } else if (piiCount === 0) {
      result.addCheck('data:pii', true, { severity: 'info', message: 'No PII handling issues detected' });
    }
  }

  _checkDataValidation(projectRoot, result) {
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS);

    for (const file of jsFiles) {
      const relPath = repoRelative(projectRoot, file);
      // `includes('test')` also matched `src/latest/`, `attestation.js`
      // and `testimonials/` — real shipped code, silently skipped.
      // BaseModule._isTestPath() is the canonical segment-anchored form.
      if (this._isTestPath(relPath) || relPath.split(/[\\/]/).includes('node_modules')) continue;

      const content = fs.readFileSync(file, 'utf-8');

      // Check for raw body parsing without validation
      if (content.includes('req.body') && !content.includes('validate') &&
          !content.includes('schema') && !content.includes('zod') &&
          !content.includes('joi') && !content.includes('yup')) {

        // Only flag handler files, not utility files — by the shared route
        // grammar, not a hand-spelled Express test: a Fastify / Hono / Koa /
        // NestJS handler reading req.body unvalidated passed here until
        // 2026-09-05 (the Fifty, move 11).
        if (hasMutatingHandler(content)) {
          result.addCheck(`data:no-validation:${relPath}`, false, {
            file: relPath,
            severity: 'warning',
            message: 'Request body used without input validation',
            suggestion: 'Add input validation using Zod, Joi, or similar',
          });
        }
      }
    }
  }

  _checkSqlInjection(projectRoot, result) {
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS_NO_JSX);

    // Scanner modules and our own non-DB source contain string concatenation
    // patterns that look like SQL but aren't. Restrict the check to files
    // that actually look DB-aware.
    const SCANNER_PATH_RE = /(?:^|\/)(?:src\/modules|src\/core|website\/app\/lib\/scan-modules|website\/app\/admin|tests|integrations\/infra|lib)\//;

    for (const file of jsFiles) {
      const relPath = repoRelative(projectRoot, file);
      const normalisedPath = relPath.replace(/\\/g, '/');
      if (normalisedPath.includes('test')) continue;
      if (SCANNER_PATH_RE.test(normalisedPath)) continue;

      const content = fs.readFileSync(file, 'utf-8');
      // The one stripper (BaseModule._maskedLines) decides whether `query(`
      // below sits in code: a character the mask blanked is inside a string
      // literal or a comment — including a template literal or a block
      // comment opened on an earlier line, which the per-line quote counter
      // this replaced (2026-09-05) could not see.
      const masked = this._maskedLines(content);

      // SQL string concatenation INSIDE a query/execute/raw call. The old
      // regex had a runaway `(?:\+\s*\w+\s*\+)` alternation that matched
      // ANY `+ var +` anywhere in the file — flagging template literals
      // and module-summary strings as SQL injections. This narrower form
      // only matches the actual unsafe shape: a query function call with
      // SELECT/INSERT/UPDATE/DELETE followed by an interpolation.
      // `\s*` after the opening quote closes a false NEGATIVE: the very
      // common formatting
      //     db.query(`
      //       SELECT * FROM users WHERE id = ${id}
      //     `)
      // was never detected, because the pattern demanded SELECT immediately
      // after the quote. Verified against the pre-change code: only the
      // single-line form was ever caught (found 2026-07-28 while fixing the
      // FP below — the multi-line case was checked rather than assumed).
      const sqlConcatPattern = /(?:query|execute|raw)\s*\(\s*[`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^`'"]*\$\{/gi;

      // Matched against the WHOLE file so the multi-line form above is
      // reachable at all; a line-by-line scan could not see it.
      //
      // The false positive it caused: a handbook/docs file where the whole
      // snippet sits inside an OUTER string —
      //     sqlTmpl: "db.query(`SELECT * FROM u WHERE id = ${req.query.id}`)",
      // — was reported as a blocking SQL-injection error (found 2026-07-28
      // by scanning an all-inert fixture, KI #77).
      //
      // The discriminator is the position of `query(` itself: in real code
      // it IS code, and in the doc string it is inside a string literal. So
      // check the match START rather than dropping to line-by-line. The
      // pattern itself reads the SQL keyword out of the quotes, so it runs
      // on the raw content, not the masked one.
      sqlConcatPattern.lastIndex = 0;
      let sqlMatch;
      while ((sqlMatch = sqlConcatPattern.exec(content)) !== null) {
        const before = content.slice(0, sqlMatch.index);
        const lineNo = before.split(/\r?\n/).length;
        const lineStart = before.lastIndexOf('\n') + 1;
        const lineText = content.slice(lineStart, content.indexOf('\n', sqlMatch.index) === -1
          ? content.length
          : content.indexOf('\n', sqlMatch.index));
        const col = sqlMatch.index - lineStart;

        if (this._isCommentLine(lineText)) continue;
        if ((masked[lineNo - 1] || '')[col] !== lineText[col]) continue;

        result.addCheck(`data:sql-injection:${relPath}:${lineNo}`, false, {
          file: relPath,
          line: lineNo,
          column: col,
          severity: 'error',
          message: `${relPath}:${lineNo} Possible SQL injection — string interpolation inside a SQL query call`,
          suggestion: 'Use parameterized queries or prepared statements',
        });
        break; // one finding per file is enough; the fix is the same everywhere
      }
    }
  }

  _checkIdempotency(projectRoot, result, migrationDirs) {
    for (const dir of migrationDirs) {
      for (const filePath of this._migrationStatements(dir.abs)) {
        const file = repoRelative(projectRoot, filePath);
        try {
          const content = fs.readFileSync(filePath, 'utf-8').toLowerCase();

          // Check CREATE TABLE without IF NOT EXISTS
          if (content.includes('create table') && !content.includes('if not exists')) {
            result.addCheck(`data:idempotent:${file}`, false, {
              file,
              severity: 'warning',
              message: 'CREATE TABLE without IF NOT EXISTS — not idempotent',
              suggestion: 'Use CREATE TABLE IF NOT EXISTS for idempotent migrations',
            });
          }
        } catch { /* error-ok — unreadable migration file, nothing to judge */ }
      }
    }
  }

  _checkBackupConfig(projectRoot, result) {
    // Check for backup/restore scripts
    const backupIndicators = [
      'backup.sh', 'restore.sh', 'scripts/backup.js', 'scripts/restore.js',
      'docker-compose.yml', // Often includes backup volumes
    ];

    const hasDbOps = this._collectFiles(projectRoot, JS_SOURCE_EXTS_NO_JSX).some(f => {
      try {
        const content = fs.readFileSync(f, 'utf-8');
        return content.includes('prisma') || content.includes('mongoose') ||
               content.includes('sequelize') || content.includes('knex');
      } catch { return false; }
    });

    if (hasDbOps) {
      const hasBackup = backupIndicators.some(f => fs.existsSync(path.join(projectRoot, f)));
      if (!hasBackup) {
        result.addCheck('data:backup', false, {
          severity: 'info',
          message: 'Database operations detected but no backup/restore scripts',
          suggestion: 'Add backup and restore scripts for disaster recovery',
        });
      }
    }
  }
}

module.exports = DataIntegrityModule;
