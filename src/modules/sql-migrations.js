/**
 * SQL Migrations Module — schema-change safety scanner.
 *
 * The fastest way to take production down is a bad migration: a `DROP
 * COLUMN` with in-flight reads, a non-concurrent `CREATE INDEX` that
 * blocks writes for ten minutes, an `ADD COLUMN ... NOT NULL` that
 * rejects every existing row. This module walks every SQL file that
 * lives under a recognised migration directory and flags the classic
 * production-breaking patterns, zero network, zero dependencies.
 *
 * Recognised migration roots: the shared convention in
 * `src/core/migration-dirs.js` (any `migrations/` segment, Rails
 * `db/migrate`, Flyway `db/migration`, Liquibase `db/changelog`, Alembic
 * `alembic/versions`, Drizzle `drizzle/` beside its config, any dir holding
 * `atlas.sum`) — one definition with `dataIntegrity`, Doctrine §4. Before
 * 2026-09-05 this module kept a private copy that also treated ANY bare
 * `migration`/`migrate` segment as a migration tree, which is the name of a
 * framework's migration implementation far more often than of a migration.
 *
 * Rules:
 *   error:   DROP COLUMN / DROP TABLE               — data loss
 *   error:   ADD COLUMN ... NOT NULL  (no DEFAULT)  — rejects existing rows
 *   error:   ALTER COLUMN ... SET NOT NULL          — full-table lock
 *   error:   CREATE INDEX CONCURRENTLY inside BEGIN — Postgres refuses this
 *   warning: CREATE / DROP INDEX without CONCURRENTLY
 *   warning: ALTER TABLE ... RENAME / RENAME COLUMN — rolling-deploy breakage
 *   warning: ALTER COLUMN ... TYPE                  — possible table rewrite
 *   warning: ALTER TABLE ... ADD CONSTRAINT without NOT VALID
 *   info:    TRUNCATE                               — destructive, rarely wanted
 *
 * Pattern-keyed names (`sql:drop-column:<rel>:<line>` etc.) so the
 * memory module can cluster fixes over time.
 *
 * TODO(gluecron): Rails ActiveRecord / Django / Knex / Sequelize DSL
 * migrations are a follow-up — they encode the same dangers but in a
 * higher-level API. This first cut focuses on raw SQL (Flyway, Prisma,
 * Supabase, Alembic emits, plain `.sql`).
 */

const fs = require('fs');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { findMigrationDirs, isUnderMigrationDir } = require('../core/migration-dirs');

class SqlMigrationsModule extends BaseModule {
  constructor() {
    super('sqlMigrations', 'SQL Migration Safety — drop column/table, non-concurrent indexes, NOT NULL without default, blocking constraints, rolling-deploy renames');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findMigrations(projectRoot);

    if (files.length === 0) {
      result.addCheck('sql:no-files', true, {
        severity: 'info',
        message: 'No SQL migration files found — skipping',
      });
      return;
    }

    result.addCheck('sql:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} SQL migration file(s)`,
    });

    let totalIssues = 0;
    for (const file of files) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('sql:summary', true, {
      severity: 'info',
      message: `SQL migration scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findMigrations(projectRoot) {
    // Shared walk replaced a private readdir sweep so --diff scans shrink the file set (KI #104).
    // The directory set comes from the shared convention; the file set from
    // the shared walk, so `--diff` still narrows it.
    const dirs = findMigrationDirs(projectRoot);
    if (dirs.length === 0) return [];
    return this._collectFiles(projectRoot, ['.sql'])
      .filter((full) => isUnderMigrationDir(full, dirs));
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = repoRelative(projectRoot, file);
    // Strip -- line comments (keep lines for line numbers) and /* */ block
    // comments. Preserve line count.
    const raw = content.split(/\r?\n/);
    const stripped = raw.map((l) => l.replace(/--.*$/, ''));
    // Block-comment stripping that preserves newlines
    let joined = stripped.join('\n').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const lines = joined.split(/\r?\n/);

    let issues = 0;
    let inTransaction = false;
    let transactionStart = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const t = line.trim();
      if (!t) continue;
      const upper = t.toUpperCase();

      // Track explicit BEGIN / START TRANSACTION blocks to catch
      // CONCURRENTLY-inside-transaction which Postgres rejects.
      if (/^\s*(BEGIN|START\s+TRANSACTION)\b/i.test(t)) {
        inTransaction = true;
        transactionStart = i + 1;
        continue;
      }
      if (/^\s*(COMMIT|ROLLBACK|END)\b/i.test(t)) {
        inTransaction = false;
        continue;
      }

      // 1. DROP COLUMN
      if (/\bALTER\s+TABLE\b.*\bDROP\s+COLUMN\b/i.test(upper) || /\bDROP\s+COLUMN\b/i.test(upper)) {
        issues += this._flag(result, `sql:drop-column:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          message: '`DROP COLUMN` — destroys data immediately and breaks any running app code still reading the column',
          suggestion: 'Multi-phase: (1) stop writing to the column, (2) ship code that stops reading it, (3) drop in a later migration.',
        });
      }

      // 2. DROP TABLE
      if (/^\s*DROP\s+TABLE\b/i.test(t)) {
        issues += this._flag(result, `sql:drop-table:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          message: '`DROP TABLE` — irreversible data loss',
          suggestion: 'Rename the table first (`ALTER TABLE foo RENAME TO foo_deprecated`), let code deploy without referencing it, then drop in a later migration.',
        });
      }

      // 3. ADD COLUMN ... NOT NULL without DEFAULT
      const addCol = upper.match(/ADD\s+COLUMN\s+\S+\s+([^,;]+)/);
      if (addCol) {
        const defn = addCol[1];
        if (/\bNOT\s+NULL\b/.test(defn) && !/\bDEFAULT\b/.test(defn)) {
          issues += this._flag(result, `sql:add-notnull-no-default:${rel}:${i + 1}`, {
            severity: 'error',
            file: rel,
            line: i + 1,
            message: '`ADD COLUMN ... NOT NULL` without `DEFAULT` — rejects every existing row and fails on populated tables',
            suggestion: 'Add the column nullable first, backfill, then `ALTER COLUMN ... SET NOT NULL` in a separate migration — or give it a DEFAULT.',
          });
        }
      }

      // 4. ALTER COLUMN ... SET NOT NULL (full-table exclusive lock on Postgres)
      if (/ALTER\s+(TABLE|COLUMN)\b.*ALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL/i.test(t) ||
          /ALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL/i.test(upper)) {
        issues += this._flag(result, `sql:set-notnull:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          message: '`SET NOT NULL` — Postgres acquires an ACCESS EXCLUSIVE lock and scans the whole table',
          suggestion: 'Postgres 12+: first `ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT`, then `SET NOT NULL` (which becomes fast).',
        });
      }

      // 5. CREATE INDEX CONCURRENTLY inside a transaction
      if (inTransaction && /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(upper)) {
        issues += this._flag(result, `sql:concurrent-in-tx:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          message: `\`CREATE INDEX CONCURRENTLY\` inside a transaction (opened at line ${transactionStart}) — Postgres will refuse to run this`,
          suggestion: 'Run CONCURRENTLY statements outside any BEGIN/COMMIT. In Rails use `disable_ddl_transaction!`.',
        });
      }

      // 6. CREATE INDEX without CONCURRENTLY (writes blocked while building)
      if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(t) && !/CONCURRENTLY/i.test(upper)) {
        // Skip CREATE INDEX IF NOT EXISTS if a fresh table — heuristic:
        // if the file also CREATEs the same table fresh, the lock doesn't
        // matter. We stay conservative and still warn; the suggestion
        // covers the fresh-table case.
        issues += this._flag(result, `sql:index-not-concurrent:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          message: '`CREATE INDEX` without CONCURRENTLY — blocks writes to the table while the index builds',
          suggestion: 'Use `CREATE INDEX CONCURRENTLY` (Postgres). OK to omit only when the table was created in the same migration.',
        });
      }

      // 7. DROP INDEX without CONCURRENTLY
      if (/^\s*DROP\s+INDEX\b/i.test(t) && !/CONCURRENTLY/i.test(upper)) {
        issues += this._flag(result, `sql:drop-index-not-concurrent:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          message: '`DROP INDEX` without CONCURRENTLY — takes an ACCESS EXCLUSIVE lock',
          suggestion: 'Use `DROP INDEX CONCURRENTLY` (Postgres) so queries keep running during the drop.',
        });
      }

      // 8. ALTER TABLE ... RENAME / RENAME COLUMN
      if (/ALTER\s+TABLE\b.*\bRENAME\b/i.test(upper)) {
        issues += this._flag(result, `sql:rename:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          message: '`RENAME` during a rolling deploy — old app pods still referencing the old name will error',
          suggestion: 'Add the new column/table, dual-write, cut over reads, drop the old — spread across multiple deploys.',
        });
      }

      // 9. ALTER COLUMN ... TYPE (non-trivial type changes rewrite the table)
      if (/ALTER\s+COLUMN\s+\S+\s+(TYPE|SET\s+DATA\s+TYPE)\b/i.test(upper)) {
        issues += this._flag(result, `sql:alter-type:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          message: '`ALTER COLUMN ... TYPE` — on most type changes Postgres rewrites the whole table under an ACCESS EXCLUSIVE lock',
          suggestion: 'Add a new column with the target type, backfill in batches, swap reads/writes, drop the old column.',
        });
      }

      // 10. ALTER TABLE ... ADD CONSTRAINT without NOT VALID
      if (/ALTER\s+TABLE\b[^;]*\bADD\s+CONSTRAINT\b/i.test(upper) && !/NOT\s+VALID/i.test(upper)) {
        // Only CHECK and FOREIGN KEY constraints benefit from NOT VALID; UNIQUE
        // must build an index, which is the same problem under a different
        // name. Flag any ADD CONSTRAINT without NOT VALID as a warning.
        if (/\b(CHECK|FOREIGN\s+KEY|UNIQUE)\b/i.test(upper)) {
          issues += this._flag(result, `sql:add-constraint-validates:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: '`ADD CONSTRAINT` without `NOT VALID` — blocks the table while validating every existing row',
            suggestion: 'Add with `NOT VALID`, then `ALTER TABLE ... VALIDATE CONSTRAINT` in a separate migration.',
          });
        }
      }

      // 11. TRUNCATE
      if (/^\s*TRUNCATE\b/i.test(t)) {
        issues += this._flag(result, `sql:truncate:${rel}:${i + 1}`, {
          severity: 'info',
          file: rel,
          line: i + 1,
          message: '`TRUNCATE` — wipes the entire table; make sure this is not running in production by accident',
          suggestion: 'Only use in explicit reset/seed migrations. Guard with environment checks if unsure.',
        });
      }
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = SqlMigrationsModule;
