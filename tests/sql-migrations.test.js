const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SqlMigrationsModule = require('../src/modules/sql-migrations');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new SqlMigrationsModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function writeMigration(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('SqlMigrationsModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sql-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no migration files exist', async () => {
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'sql:no-files'));
  });

  it('finds SQL files under migrations/, db/migrate/, prisma/migrations/', async () => {
    writeMigration(tmp, 'migrations/001_init.sql',                      'CREATE TABLE a (id int);');
    writeMigration(tmp, 'db/migrate/20240101_add.sql',                  'CREATE TABLE b (id int);');
    writeMigration(tmp, 'prisma/migrations/20240102_x/migration.sql',   'CREATE TABLE c (id int);');
    writeMigration(tmp, 'supabase/migrations/20240103_y.sql',           'CREATE TABLE d (id int);');
    const r = await run(tmp);
    const scanning = r.checks.find((c) => c.name === 'sql:scanning');
    assert.match(scanning.message, /4 SQL/);
  });

  it('does NOT pick up .sql files outside migration directories', async () => {
    writeMigration(tmp, 'queries/report.sql',   'SELECT * FROM foo;');
    writeMigration(tmp, 'schema.sql',           'SELECT 1;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'sql:no-files'));
  });

  it('excludes node_modules', async () => {
    writeMigration(tmp, 'node_modules/pkg/migrations/001.sql', 'DROP TABLE users;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'sql:no-files'));
  });
});

describe('SqlMigrationsModule — destructive ops', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sql-drop-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on DROP COLUMN', async () => {
    writeMigration(tmp, 'migrations/001.sql', 'ALTER TABLE users DROP COLUMN legacy_flag;');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('sql:drop-column:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on DROP TABLE', async () => {
    writeMigration(tmp, 'migrations/002.sql', 'DROP TABLE audit_log;');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('sql:drop-table:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('info-flags TRUNCATE', async () => {
    writeMigration(tmp, 'migrations/003.sql', 'TRUNCATE TABLE sessions;');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('sql:truncate:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });

  it('ignores DROP COLUMN in a SQL comment', async () => {
    writeMigration(tmp, 'migrations/004.sql', [
      '-- later we will DROP COLUMN legacy_flag but not yet',
      'ALTER TABLE users ADD COLUMN new_flag boolean DEFAULT false;',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:drop-column:')), undefined);
  });

  it('ignores DROP COLUMN in a block comment', async () => {
    writeMigration(tmp, 'migrations/005.sql', [
      '/* TODO: DROP COLUMN legacy_flag next quarter */',
      'SELECT 1;',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:drop-column:')), undefined);
  });
});

/**
 * Issue #633 (Tallrig false-positive report, 2026-09-22): every DROP TABLE
 * finding from an 8/8-FP module was actually SQLite's own documented
 * table-rebuild idiom (lang_altertable.html §7) — CREATE __new_X, INSERT
 * INTO __new_X SELECT ... FROM X, DROP TABLE X, ALTER TABLE __new_X RENAME
 * TO X. The DROP in that sequence isn't data loss because the rows were
 * copied into the replacement table first.
 */
describe('SqlMigrationsModule — DROP TABLE rebuild idiom (issue #633)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sql-rebuild-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('POSITIVE (control): a bare DROP TABLE with no rebuild context still fires at error severity', async () => {
    writeMigration(tmp, 'migrations/001.sql', 'DROP TABLE users;');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('sql:drop-table:'));
    assert.ok(hit, 'expected a plain drop-table finding');
    assert.strictEqual(hit.severity, 'error');
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:drop-table-rebuild:')), undefined);
  });

  it('NEGATIVE: the full create/copy/drop/rename idiom does NOT fire as destructive', async () => {
    writeMigration(tmp, 'migrations/002.sql', [
      'CREATE TABLE __new_users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);',
      'INSERT INTO __new_users (id, email) SELECT id, email FROM users;',
      'DROP TABLE users;',
      'ALTER TABLE __new_users RENAME TO users;',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:drop-table:')), undefined,
      'the rebuild-idiom DROP TABLE must not fire as a plain destructive drop');
    const rebuildHit = r.checks.find((c) => c.name.startsWith('sql:drop-table-rebuild:'));
    assert.ok(rebuildHit, 'expected an info-level rebuild-idiom note');
    assert.strictEqual(rebuildHit.severity, 'info');
  });

  it('NEGATIVE: the idiom is also recognised with the shorter `new_X` naming', async () => {
    writeMigration(tmp, 'migrations/003.sql', [
      'CREATE TABLE new_orders (id INTEGER PRIMARY KEY, total REAL);',
      'INSERT INTO new_orders (id, total) SELECT id, total FROM orders;',
      'DROP TABLE orders;',
      'ALTER TABLE new_orders RENAME TO orders;',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:drop-table:')), undefined);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:drop-table-rebuild:')));
  });

  it('a DROP TABLE __new_X for a DIFFERENT table than the one rebuilt still fires', async () => {
    // Rebuilds `users`, but separately drops an unrelated real table —
    // that drop must still be reported at full severity.
    writeMigration(tmp, 'migrations/004.sql', [
      'CREATE TABLE __new_users (id INTEGER PRIMARY KEY);',
      'INSERT INTO __new_users (id) SELECT id FROM users;',
      'DROP TABLE users;',
      'ALTER TABLE __new_users RENAME TO users;',
      'DROP TABLE orders;',
    ].join('\n'));
    const r = await run(tmp);
    const plainDrops = r.checks.filter((c) => c.name.startsWith('sql:drop-table:'));
    assert.strictEqual(plainDrops.length, 1, 'only the unrelated orders drop should fire as plain destructive');
    assert.match(plainDrops[0].message, /orders|DROP TABLE/);
    assert.strictEqual(plainDrops[0].line, 5);
  });

  it('POSITIVE (control): DROP TABLE IF EXISTS tmp_import_batch with no rebuild context is quieter than a real drop', async () => {
    writeMigration(tmp, 'migrations/005.sql', 'DROP TABLE IF EXISTS tmp_import_batch;');
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:drop-table:')), undefined,
      'an ephemeral-named table must not be treated the same as a real table drop');
    const hit = r.checks.find((c) => c.name.startsWith('sql:drop-table-ephemeral:'));
    assert.ok(hit, 'expected an ephemeral-table finding');
    assert.notStrictEqual(hit.severity, 'error');
  });

  it('other ephemeral-naming prefixes (temp_, staging_) are also recognised as lower risk', async () => {
    writeMigration(tmp, 'migrations/006.sql', [
      'DROP TABLE temp_export;',
      'DROP TABLE staging_customers;',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.filter((c) => c.name.startsWith('sql:drop-table:')).length, 0);
    assert.strictEqual(r.checks.filter((c) => c.name.startsWith('sql:drop-table-ephemeral:')).length, 2);
  });
});

describe('SqlMigrationsModule — NOT NULL + ADD COLUMN', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sql-nn-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on ADD COLUMN ... NOT NULL without DEFAULT', async () => {
    writeMigration(tmp, 'migrations/001.sql',
      'ALTER TABLE users ADD COLUMN email VARCHAR(255) NOT NULL;');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('sql:add-notnull-no-default:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('accepts ADD COLUMN ... NOT NULL DEFAULT <value>', async () => {
    writeMigration(tmp, 'migrations/002.sql',
      "ALTER TABLE users ADD COLUMN email VARCHAR(255) NOT NULL DEFAULT '';");
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:add-notnull-no-default:')), undefined);
  });

  it('errors on ALTER COLUMN ... SET NOT NULL', async () => {
    writeMigration(tmp, 'migrations/003.sql',
      'ALTER TABLE users ALTER COLUMN email SET NOT NULL;');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('sql:set-notnull:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});

describe('SqlMigrationsModule — indexes', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sql-idx-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on CREATE INDEX without CONCURRENTLY', async () => {
    writeMigration(tmp, 'migrations/001.sql',
      'CREATE INDEX idx_users_email ON users (email);');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:index-not-concurrent:')));
  });

  it('warns on CREATE UNIQUE INDEX without CONCURRENTLY', async () => {
    writeMigration(tmp, 'migrations/002.sql',
      'CREATE UNIQUE INDEX idx_users_email ON users (email);');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:index-not-concurrent:')));
  });

  it('accepts CREATE INDEX CONCURRENTLY', async () => {
    writeMigration(tmp, 'migrations/003.sql',
      'CREATE INDEX CONCURRENTLY idx_users_email ON users (email);');
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:index-not-concurrent:')), undefined);
  });

  it('warns on DROP INDEX without CONCURRENTLY', async () => {
    writeMigration(tmp, 'migrations/004.sql', 'DROP INDEX idx_users_email;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:drop-index-not-concurrent:')));
  });

  it('errors on CREATE INDEX CONCURRENTLY inside BEGIN', async () => {
    writeMigration(tmp, 'migrations/005.sql', [
      'BEGIN;',
      'CREATE INDEX CONCURRENTLY idx_x ON users (email);',
      'COMMIT;',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('sql:concurrent-in-tx:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});

describe('SqlMigrationsModule — rolling deploy + constraints + types', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sql-roll-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on ALTER TABLE ... RENAME COLUMN', async () => {
    writeMigration(tmp, 'migrations/001.sql',
      'ALTER TABLE users RENAME COLUMN email TO email_address;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:rename:')));
  });

  it('warns on ALTER COLUMN ... TYPE', async () => {
    writeMigration(tmp, 'migrations/002.sql',
      'ALTER TABLE users ALTER COLUMN email TYPE TEXT;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:alter-type:')));
  });

  it('warns on ADD CONSTRAINT CHECK without NOT VALID', async () => {
    writeMigration(tmp, 'migrations/003.sql',
      'ALTER TABLE users ADD CONSTRAINT users_age_check CHECK (age >= 0);');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:add-constraint-validates:')));
  });

  it('accepts ADD CONSTRAINT ... NOT VALID', async () => {
    writeMigration(tmp, 'migrations/004.sql',
      'ALTER TABLE users ADD CONSTRAINT users_age_check CHECK (age >= 0) NOT VALID;');
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('sql:add-constraint-validates:')), undefined);
  });

  it('warns on ADD CONSTRAINT FOREIGN KEY without NOT VALID', async () => {
    writeMigration(tmp, 'migrations/005.sql',
      'ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:add-constraint-validates:')));
  });
});

describe('SqlMigrationsModule — summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sql-sum-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records a summary', async () => {
    writeMigration(tmp, 'migrations/001.sql', 'CREATE TABLE x (id int);');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'sql:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});

/**
 * KI #106 (the Fifty, move 11) — the directory convention is the shared
 * one in src/core/migration-dirs.js, not a private list. What changed:
 * Liquibase `db/changelog`, Alembic `alembic/versions`, Drizzle beside its
 * config and Atlas (`atlas.sum`) are now found; a bare `migration` /
 * `migrate` segment anywhere no longer is — in the corpus it only ever
 * named a framework's migration implementation or docs.
 */
describe('SqlMigrationsModule — shared migration-dir convention', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sql-dirs-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const LAYOUTS = [
    ['Flyway', 'src/main/resources/db/migration/V2__drop.sql'],
    ['Liquibase', 'src/main/resources/db/changelog/changes/002_drop.sql'],
    ['Alembic (alembic/versions)', 'alembic/versions/1975ea83b712_drop.sql'],
    ['golang-migrate', 'db/migrations/000002_drop.up.sql'],
    ['TypeORM-style src/migrations', 'src/migrations/1700000000000-drop.sql'],
    ['Laravel database/migrations', 'database/migrations/2014_10_12_000000_drop.sql'],
    ['EF Core Migrations/', 'Migrations/20240101120000_Drop.sql'],
    ['hand-named raw SQL set', 'migrations/drop_legacy.sql'],
  ];
  for (const [label, file] of LAYOUTS) {
    it(`POSITIVE: ${label} — only that layout present, its DROP TABLE is reported`, async () => {
      writeMigration(tmp, file, 'DROP TABLE users;');
      const r = await run(tmp);
      assert.strictEqual(r.checks.find((c) => c.name === 'sql:no-files'), undefined, `${label}: reported as no migrations`);
      const hit = r.checks.find((c) => c.name.startsWith('sql:drop-table:'));
      assert.ok(hit, `${label}: no drop-table finding`);
      assert.strictEqual(hit.file.replace(/\\/g, '/'), file);
    });
  }

  it('POSITIVE: Drizzle — drizzle/ beside drizzle.config.ts', async () => {
    writeMigration(tmp, 'drizzle.config.ts', 'export default {}');
    writeMigration(tmp, 'drizzle/0001_drop.sql', 'DROP TABLE users;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:drop-table:')));
  });

  it('POSITIVE: Atlas — a dir holding atlas.sum', async () => {
    writeMigration(tmp, 'schema/atlas.sum', 'h1:x');
    writeMigration(tmp, 'schema/20240101120000_drop.sql', 'DROP TABLE users;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('sql:drop-table:')));
  });

  it('NEGATIVE: a directory that merely contains the word is not a migration dir', async () => {
    writeMigration(tmp, 'src/migrationsHelper/drop.sql', 'DROP TABLE users;');
    writeMigration(tmp, 'docs/migration-guide/drop.sql', 'DROP TABLE users;');
    writeMigration(tmp, 'src/migrations2/drop.sql', 'DROP TABLE users;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'sql:no-files'));
  });

  it('NEGATIVE: a bare `migration` segment is a framework dir, not a tree', async () => {
    // rails activerecord/lib/active_record/migration, prisma packages/…/tooling/migration
    writeMigration(tmp, 'lib/active_record/migration/compatibility.sql', 'DROP TABLE users;');
    writeMigration(tmp, 'packages/tooling/migration/render.sql', 'DROP TABLE users;');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'sql:no-files'));
  });

  it('NEGATIVE: a dir named migrations holding only source is skipped', async () => {
    writeMigration(tmp, 'packages/postgres/src/core/migrations/op-factory-call.ts', 'const x = "DROP TABLE";');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'sql:no-files'));
  });
});
