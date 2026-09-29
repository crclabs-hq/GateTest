const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DataIntegrityModule = require('../src/modules/data-integrity');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('DataIntegrityModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dataint-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new DataIntegrityModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new DataIntegrityModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

/**
 * SQL-injection detection: position matters, and multi-line counts.
 *
 * Found 2026-07-28 by scanning an all-inert fixture — a handbook file whose
 * every dangerous construct sits inside a doc string. `data:sql-injection`
 * fired on it as a BLOCKING error:
 *
 *   sqlTmpl: "db.query(`SELECT * FROM u WHERE id = ${req.query.id}`)",
 *
 * The discriminator is where `query(` sits. In real code it IS code; in the
 * handbook it is inside an outer string. Checking the match position beats
 * dropping to a line-by-line scan, which would have lost the multi-line
 * form entirely.
 *
 * And while verifying that, the multi-line form turned out never to have
 * been detected at all — the pattern demanded SELECT immediately after the
 * opening quote. Confirmed against the pre-change code rather than assumed.
 */
describe('data-integrity — SQL injection: strings vs code, single vs multi-line', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-di-sqli-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scan(rel, source) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    const mod = new DataIntegrityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && c.name.startsWith('data:sql-injection'));
  }

  it('does NOT flag a query snippet quoted inside a doc string', async () => {
    const found = await scan('src/handbook.js', [
      'const RULES = {',
      '  sqlTmpl: "db.query(`SELECT * FROM u WHERE id = ${req.query.id}`)",',
      '};',
      'module.exports = { RULES };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('does NOT flag a query snippet inside a comment', async () => {
    const found = await scan('src/notes.js', [
      '// never write db.query(`SELECT * FROM u WHERE id = ${id}`)',
      'const a = 1;',
      'module.exports = { a };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('DOES flag a real single-line interpolated query', async () => {
    const found = await scan('src/db.js', [
      'async function one(db, req) {',
      '  return db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);',
      '}',
      'module.exports = { one };',
    ].join('\n'));
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].line, 2, 'the finding must carry a line number');
  });

  it('DOES flag a real MULTI-LINE interpolated query', async () => {
    // This shape was never detected before 2026-07-28.
    const found = await scan('src/db2.js', [
      'async function many(db, req) {',
      '  return db.query(`',
      '    SELECT * FROM users WHERE id = ${req.query.id}',
      '  `);',
      '}',
      'module.exports = { many };',
    ].join('\n'));
    assert.strictEqual(found.length, 1, 'multi-line queries are the common formatting');
  });

  it('a query inside a string, a template or a comment is not flagged; the real one beside them is (2026-09-05)', async () => {
    // Control pair for the one-stripper migration: the match START is judged
    // against BaseModule._maskedLines, which sees a template literal and a
    // block comment that span lines — the per-line quote counter it replaced
    // could not, and the block-comment line below was a live finding.
    const found = await scan('src/db.js', [
      'const doc = "db.query(`SELECT * FROM u WHERE id = ${req.query.id}`)";',
      'const tpl = `',
      "  db.query('SELECT * FROM u WHERE id = ${req.query.id}')",
      '`;',
      '/* example:',
      '   db.query(`SELECT * FROM u WHERE id = ${req.query.id}`)',
      '*/',
      'db.query(`SELECT * FROM u WHERE id = ${req.query.id}`);',
      '',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => [f.name, f.line]), [['data:sql-injection:src/db.js:8', 8]]);
  });

  it('does NOT flag a parameterised query', async () => {
    const found = await scan('src/safe.js', [
      'async function safe(db, req) {',
      '  return db.query("SELECT * FROM users WHERE id = $1", [req.query.id]);',
      '}',
      'module.exports = { safe };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });
});

/**
 * PII — "Sensitive data serialized": where the bytes GO decides it.
 *
 * `JSON.stringify(...)` containing the word token/password/secret was a
 * blocking error wherever it appeared. That flags the shape of every login form
 * and every "save my API key" form ever written, including this repo's own
 * admin PAT form (website/app/admin/tabs/AccountsTab.tsx:49), which POSTs the
 * token to our own API so it can be stored — the whole point of the feature.
 * Nothing is logged, put in a URL, or written to localStorage there, and the
 * matching read path returns only the last four characters of the token.
 *
 * The rule's real targets are serialization to somewhere OBSERVABLE or
 * PERSISTENT. Only the `body:`/`body =` position is exempt; every one of those
 * targets must keep firing, which is what the POSITIVE cases below pin.
 */
describe('data-integrity — PII: a request body is not a leak, a log is', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-di-pii-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scan(rel, source) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    const result = makeResult();
    await new DataIntegrityModule().run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && c.name.startsWith('data:pii'));
  }

  it('NEGATIVE: a token serialized as a fetch request body is the credential doing its job', async () => {
    const found = await scan('app/AccountsTab.tsx', [
      'export async function addProfile(ghLabel, ghToken, orgs) {',
      '  const res = await fetch("/api/admin/github-profiles", {',
      '    method: "POST",',
      '    headers: { "Content-Type": "application/json" },',
      '    body: JSON.stringify({ label: ghLabel, token: ghToken, orgs }),',
      '  });',
      '  return res.json();',
      '}',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('a console.log(password) inside a string, a template or a comment is not a leak; the real one beside them is (2026-09-05)', async () => {
    // Control pair for the one-stripper migration (see the SQL twin above).
    const found = await scan('app/log.js', [
      'const doc = "console.log(user.password)";',
      'const tpl = `',
      '  console.log(user.password)',
      '`;',
      '/* example:',
      '   console.log(user.password)',
      '*/',
      'console.log(user.password);',
      '',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => [f.name, f.line]), [['data:pii:PII in logs:app/log.js', 8]]);
  });

  it('POSITIVE: the same payload written to a LOG still fires', async () => {
    const found = await scan('app/log.js', [
      'function save(user) {',
      '  console.log("saving", JSON.stringify({ password: user.password }));',
      '}',
      'module.exports = { save };',
    ].join('\n'));
    assert.ok(found.length > 0, 'a serialized password in a log is a real leak');
    assert.ok(found.some((f) => f.line === 2), JSON.stringify(found));
  });

  it('POSITIVE: the same payload written to localStorage still fires', async () => {
    const found = await scan('app/store.js', [
      'function persist(session) {',
      '  localStorage.setItem("session", JSON.stringify({ token: session.token }));',
      '}',
      'module.exports = { persist };',
    ].join('\n'));
    assert.ok(found.length > 0, 'a serialized token in localStorage is a real leak');
  });

  it('POSITIVE: a bare serialization not bound to a request body still fires', async () => {
    const found = await scan('app/dump.js', [
      'function dump(cfg) {',
      '  const blob = JSON.stringify({ secret: cfg.secret });',
      '  return blob;',
      '}',
      'module.exports = { dump };',
    ].join('\n'));
    assert.ok(found.length > 0, 'only the body: position is exempt, not stringify in general');
  });

  it('the exemption is positional: "somebody:" or a trailing comment must not spell "body:"', async () => {
    const found = await scan('app/tricky.js', [
      'function leak(u) {',
      '  const nobody = JSON.stringify({ token: u.token });',
      '  return nobody;',
      '}',
      'module.exports = { leak };',
    ].join('\n'));
    assert.ok(found.length > 0, '`nobody =` must not be read as `body =`');
  });
});

// Move 11 (2026-09-05): "is this a handler file" comes from the shared route
// grammar, not a hand-spelled `app.post`. A Fastify/Hono/Nest handler reading
// req.body with no validation used to pass untouched.
describe('data-integrity — handler detection is framework-agnostic', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-di-routes-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scan(rel, source) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    const mod = new DataIntegrityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && c.name.startsWith('data:no-validation'));
  }

  for (const [label, src] of [
    ['fastify', "fastify.post('/users', async (req, reply) => { await db.insert(req.body); return {}; });"],
    ['hono', "hono.put('/users/:id', async (c) => { const req = c.req; return db.update(req.body); });"],
    ['nest', "@Post('/users')\ncreate(@Req() req) { return this.svc.save(req.body); }"],
    ['next app router', 'export async function PUT(req) { const body = await req.json(); return save(req.body || body); }'],
  ]) {
    it(`flags an unvalidated body in a ${label} handler`, async () => {
      const found = await scan('src/handler.js', src);
      assert.strictEqual(found.length, 1, label);
    });
  }

  it('still ignores a utility that merely reads req.body', async () => {
    const found = await scan('src/util.js', 'function pick(req) { return req.body.name; }\nmodule.exports = { pick };');
    assert.deepStrictEqual(found, []);
  });
});

/**
 * KI #106 (the Fifty, move 11) — two framework-gated early exits.
 *
 * 1. `prisma/schema.prisma` present → `_checkModels` RETURNED before the
 *    Mongoose sweep. A repo carrying both (every Mongo → Postgres migration
 *    in progress) never had its Mongoose schemas checked.
 * 2. Four literal root paths decided "no migrations", and only the files
 *    DIRECTLY inside were read — Rails `db/migrate`, Alembic, Flyway, a
 *    Django app's `migrations/`, and Prisma's own nested
 *    `prisma/migrations/<ts>/migration.sql` all reported "No migration
 *    directory found". The convention now lives in src/core/migration-dirs.js.
 */
describe('data-integrity — Prisma does not gate the Mongoose sweep', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-di-orm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function plant(rel, content) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  async function scan() {
    plant('package.json', '{"name":"t","version":"1.0.0"}\n');
    const result = makeResult();
    await new DataIntegrityModule().run(result, { projectRoot: tmp });
    return result.checks;
  }
  const UNVALIDATED_MONGOOSE = [
    "const mongoose = require('mongoose');",
    'const UserSchema = new mongoose.Schema({ email: String, name: String });',
    "module.exports = mongoose.model('User', UserSchema);",
  ].join('\n');

  it('POSITIVE: a Prisma repo with an unvalidated Mongoose schema gets BOTH checked', async () => {
    plant('prisma/schema.prisma', 'model User { id Int @id\n email String @unique }');
    plant('src/models/user.js', UNVALIDATED_MONGOOSE);
    const checks = await scan();
    assert.ok(checks.some((c) => c.name === 'data:prisma-schema'), 'prisma path still runs');
    assert.ok(checks.some((c) => c.name === 'data:mongoose-validation:src/models/user.js' && !c.passed),
      `mongoose sweep must run beside prisma: ${checks.map((c) => c.name).join(', ')}`);
    assert.ok(!checks.some((c) => c.name === 'data:models'), '"no ORM" must not be claimed when two ORMs are present');
  });

  it('NEGATIVE: a Prisma-only repo does not invent a Mongoose finding', async () => {
    plant('prisma/schema.prisma', 'model User { id Int @id\n email String @unique }');
    plant('src/db.js', "const { PrismaClient } = require('@prisma/client');\nmodule.exports = new PrismaClient();");
    const checks = await scan();
    assert.ok(!checks.some((c) => c.name.startsWith('data:mongoose-validation')));
    assert.ok(!checks.some((c) => c.name === 'data:models'), 'prisma IS an ORM schema');
  });

  it('still says "No ORM schema detected" when there is neither', async () => {
    plant('src/app.js', 'module.exports = 1;');
    const checks = await scan();
    assert.ok(checks.some((c) => c.name === 'data:models'));
  });
});

describe('data-integrity — migration trees are found by the shared convention', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-di-mig-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function plant(rel, content) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  async function scan() {
    plant('package.json', '{"name":"t","version":"1.0.0"}\n');
    const result = makeResult();
    await new DataIntegrityModule().run(result, { projectRoot: tmp });
    return result.checks;
  }
  const DROP = 'DROP TABLE users;';

  // Each layout planted ALONE: the tree must be found and the destructive
  // statement inside it must be reported. Before the shared convention every
  // one of these said "No migration directory found — skipping".
  const LAYOUTS = [
    ['Rails db/migrate', 'db/migrate/20170806125915_drop_users.rb', 'execute "DROP TABLE users"'],
    ['Alembic alembic/versions', 'alembic/versions/1975ea83b712_drop.py', 'op.execute("DROP TABLE users")'],
    ['Alembic migrations/versions', 'migrations/versions/1975ea83b712_drop.py', 'op.execute("DROP TABLE users")'],
    ['Flyway', 'src/main/resources/db/migration/V2__drop.sql', DROP],
    ['Liquibase', 'src/main/resources/db/changelog/changes/drop.sql', DROP],
    ['Supabase', 'supabase/migrations/20240101120000_drop.sql', DROP],
    ['Prisma nested', 'prisma/migrations/20240102030405_drop/migration.sql', DROP],
    ['Django app', 'blog/migrations/0002_drop.py', 'migrations.RunSQL("DROP TABLE users")'],
    ['TypeORM', 'src/migrations/1700000000000-Drop.ts', 'await q.query("DROP TABLE users")'],
    ['Laravel', 'database/migrations/2014_10_12_000000_drop.php', 'DB::statement("DROP TABLE users");'],
    ['EF Core', 'Migrations/20240101120000_Drop.cs', 'migrationBuilder.Sql("DROP TABLE users");'],
    ['Sequelize', 'migrations/20240101-drop.js', 'await qi.sequelize.query("DROP TABLE users")'],
    ['golang-migrate', 'db/migrations/000002_drop.up.sql', DROP],
    ['Knex', 'migrations/20240101120000_drop.js', 'knex.raw("DROP TABLE users")'],
  ];
  for (const [label, file, content] of LAYOUTS) {
    it(`POSITIVE: ${label} — only that layout present, its DROP TABLE is reported`, async () => {
      plant(file, content);
      const checks = await scan();
      assert.ok(!checks.some((c) => c.name === 'data:migrations'), `${label}: must not say "no migration directory"`);
      const hit = checks.find((c) => c.name === `data:migration-drop:${file}`);
      assert.ok(hit && !hit.passed, `${label}: expected a drop finding, got ${checks.map((c) => c.name).join(', ')}`);
      assert.strictEqual(hit.file, file);
    });
  }

  it('POSITIVE: Drizzle — drizzle/ beside drizzle.config.ts, meta/ snapshots not read', async () => {
    plant('drizzle.config.ts', 'export default {}');
    plant('drizzle/0001_drop.sql', DROP);
    plant('drizzle/meta/_journal.json', '{"note":"DROP TABLE users"}');
    const checks = await scan();
    assert.ok(checks.some((c) => c.name === 'data:migration-drop:drizzle/0001_drop.sql'));
    assert.ok(!checks.some((c) => c.name.includes('_journal.json')));
  });

  it('POSITIVE: Atlas — a dir holding atlas.sum', async () => {
    plant('migrate/atlas.sum', 'h1:x');
    plant('migrate/20240101120000_drop.sql', DROP);
    const checks = await scan();
    assert.ok(checks.some((c) => c.name === 'data:migration-drop:migrate/20240101120000_drop.sql'));
  });

  it('NEGATIVE: a dir that merely contains the word is not a migration dir', async () => {
    plant('src/migrationsHelper/index.js', 'module.exports = "DROP TABLE users";');
    plant('docs/migration-guide/v2.md', 'Run `DROP TABLE users` then TRUNCATE the cache.');
    const checks = await scan();
    assert.ok(checks.some((c) => c.name === 'data:migrations'), 'must report no migration dir');
    assert.ok(!checks.some((c) => c.name.startsWith('data:migration-')));
  });

  it('NEGATIVE: a framework\'s migration implementation is named like one and is not one — and is listed as not checked', async () => {
    // prisma corpus: packages/…/src/core/migrations/op-factory-call.ts renders
    // DDL; it produced four BLOCKING drop findings on 2026-09-05.
    plant('packages/postgres/src/core/migrations/op-factory-call.ts', 'const ddl = `DROP TABLE ${name}`;');
    plant('django/db/migrations/loader.py', '# DROP TABLE handling');
    const checks = await scan();
    assert.ok(!checks.some((c) => c.name.startsWith('data:migration-drop')), 'no drop finding on a DDL renderer');
    const info = checks.find((c) => c.name === 'data:migrations');
    assert.ok(info, 'reports no migration dir');
    assert.match(info.message, /not checked: .*django\/db\/migrations/);
    assert.match(info.message, /packages\/postgres\/src\/core\/migrations/);
  });

  it('fixture trees under test paths are not checked — and say so', async () => {
    plant('test/dummy/db/migrate/20170806125915_x.rb', 'execute "DROP TABLE users"');
    plant('db/migrate/20170806125915_y.rb', 'create_table :users');
    const checks = await scan();
    assert.ok(!checks.some((c) => c.name.startsWith('data:migration-drop')));
    const info = checks.find((c) => c.name === 'data:migrations-exist');
    assert.match(info.message, /found in db\/migrate/);
    assert.match(info.message, /not checked: test\/dummy\/db\/migrate \(fixture\)/);
  });

  it('naming: Prisma stamps the directory, so nested timestamped dirs are ordered', async () => {
    plant('prisma/migrations/20240102030405_init/migration.sql', 'CREATE TABLE IF NOT EXISTS a (id int);');
    plant('prisma/migrations/20240103030405_more/migration.sql', 'CREATE TABLE IF NOT EXISTS b (id int);');
    const checks = await scan();
    assert.ok(!checks.some((c) => c.name.startsWith('data:migration-naming')));
  });

  it('naming: Flyway and Alembic names carry order', async () => {
    plant('src/main/resources/db/migration/V1__init.sql', 'SELECT 1;');
    plant('src/main/resources/db/migration/R__views.sql', 'SELECT 1;');
    plant('alembic/versions/1975ea83b712_a.py', '');
    plant('alembic/versions/ae1027a6acf4_b.py', '');
    const checks = await scan();
    assert.ok(!checks.some((c) => c.name.startsWith('data:migration-naming')), checks.map((c) => c.name).join(', '));
  });

  it('naming: CONTROL — a hand-named raw SQL set still gets the naming warning', async () => {
    plant('migrations/create_users.sql', 'SELECT 1;');
    plant('migrations/add_email.sql', 'SELECT 1;');
    const checks = await scan();
    const hit = checks.find((c) => c.name === 'data:migration-naming:migrations');
    assert.ok(hit && hit.severity === 'warning');
  });

  it('tool-state JSON beside migrations is not read as a migration statement', async () => {
    // Prisma 8's ops.json embeds the DDL as data AND a precheck that makes it
    // idempotent; the substring rule read "CREATE TABLE" out of it.
    plant('migrations/app/20260520T1317_init/ops.json', '[{"sql":"CREATE TABLE post (id int)","precheck":[]}]');
    plant('migrations/app/20260520T1317_init/migration.sql', 'CREATE TABLE post (id int);');
    const checks = await scan();
    assert.ok(!checks.some((c) => c.name.includes('ops.json')));
    assert.ok(checks.some((c) => c.name === 'data:idempotent:migrations/app/20260520T1317_init/migration.sql'), 'the .sql beside it still fires');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GT-12 (#771, AlecRae.com scan): five "PII in logs" errors were operator CLI
// scripts under apps/api/scripts/ printing the email address they were asked
// to act on (`console.log(\`provisioning ${email}\`)` in
// provision-alecrae-workspace.ts, seed-e2e.ts, ...). A human ran the script
// with that address on the command line; the script confirming it is not a
// log-stack leak. The identical line in application code still fires. One
// definition shared with logPii: src/core/operator-cli.js.
// ─────────────────────────────────────────────────────────────────────────────

describe('DataIntegrityModule — operator CLIs printing what they were told to print are not PII in logs (GT-12)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-di-cli-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scanFiles(files) {
    for (const [rel, source] of Object.entries(files)) {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, source);
    }
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    const result = makeResult();
    await new DataIntegrityModule().run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && c.name.startsWith('data:pii'));
  }

  it('NEGATIVE: the customer line — a scripts/ CLI echoing the email it was invoked for', async () => {
    const found = await scanFiles({
      'apps/api/scripts/provision-workspace.ts': [
        'const email = process.argv[2];',
        'console.log(`provisioning workspace for ${email}`);',
        '',
      ].join('\n'),
      'bin/create-admin-user.js': [
        '#!/usr/bin/env node',
        'const password = generatePassword();',
        'console.log("ONE-TIME PASSWORD (change it after first login):");',
        'console.log(`  ${password}`);',
        '',
      ].join('\n'),
    });
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('NEGATIVE: a shebang file outside bin/scripts/cli is still an operator CLI', async () => {
    const found = await scanFiles({
      'tools/admin-tool.js': '#!/usr/bin/env node\nconsole.log("resetting", email);\n',
    });
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('POSITIVE: the identical console.log(email) in application code still fires', async () => {
    const found = await scanFiles({
      'src/auth/login.js': 'console.log(`login attempt for ${email}`);\n',
    });
    assert.deepStrictEqual(found.map((f) => [f.name, f.line]), [['data:pii:PII in logs:src/auth/login.js', 1]]);
  });

  it('POSITIVE: a "subscripts/" directory has no "scripts" segment and still fires', async () => {
    const found = await scanFiles({
      'subscripts/report.js': 'console.log(user.password);\n',
    });
    assert.deepStrictEqual(found.map((f) => f.name), ['data:pii:PII in logs:subscripts/report.js']);
  });

  it('NEGATIVE (#842 DR-6): a dev tool seeding a token into the browser it drives is not shipped', async () => {
    // Previously pinned the other way ("a CLI that writes a token into
    // localStorage is not printing to a terminal"). A Node script has no
    // localStorage at all; the only way it reaches one is by driving a
    // browser — DavenRoe frontend/scripts/inspect.mjs seeds a mock token
    // into its Playwright context so gated routes render. That file never
    // ships, and the finding said it did. The role of the file decides, in
    // one place (src/core/operator-cli.js), for every PII rule.
    const found = await scanFiles({
      'scripts/bootstrap.js': 'localStorage.setItem("session", token);\n',
    });
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('POSITIVE: the same localStorage line in application code, and in a SHIPPED public/scripts/ file, still fires', async () => {
    const found = await scanFiles({
      'src/auth/session.js': 'localStorage.setItem("session", token);\n',
      'public/scripts/app.js': 'localStorage.setItem("session", token);\n',
    });
    assert.deepStrictEqual(found.map((f) => f.name).sort(), [
      'data:pii:Sensitive data in localStorage:public/scripts/app.js',
      'data:pii:Sensitive data in localStorage:src/auth/session.js',
    ]);
  });
});
