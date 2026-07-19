// =============================================================================
// SECURITY MODULE — SQL INJECTION (string concat / template interpolation)
// =============================================================================
// Regression tests for the in-file SQL injection detector added to
// src/modules/security.js (_checkSqlInjectionPatterns). Covers both planted
// shapes from the reliability corpus — string concatenation and
// template-literal interpolation of an identifier into a SQL string passed
// to a query-like sink — plus the required negatives: parameterised calls,
// tagged-template query builders, and SQL-injection-shaped text nested
// inside an outer string literal (fixture data).
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SecurityModule = require('../src/modules/security');

function makeResult() {
  const checks = [];
  return {
    checks,
    addCheck(rule, passed, meta = {}) {
      checks.push({ rule, passed, severity: meta.severity || (passed ? 'info' : 'error'), ...meta });
    },
    errors() { return this.checks.filter((c) => !c.passed && c.severity === 'error'); },
  };
}

async function run(tmp) {
  const mod = new SecurityModule();
  const result = makeResult();
  await mod.run(result, { projectRoot: tmp });
  return result;
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function withTmp(prefix, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Positive — string concatenation
// ---------------------------------------------------------------------------

describe('SecurityModule — SQL injection via string concatenation', () => {
  it('flags a SQL string built by concatenating an identifier and passed to conn.query()', async () => {
    await withTmp('gt-sqli-concat-', async (tmp) => {
      write(tmp, 'src/db/query.js', `
function findUserByEmail(email) {
  const conn = getConnection();
  const sql = "SELECT * FROM users WHERE email = '" + email + "'";
  return conn.query(sql);
}
module.exports = { findUserByEmail };
`);
      const result = await run(tmp);
      const finding = result.errors().find((c) => c.rule.startsWith('security:sql-injection:'));
      assert.ok(finding, `expected a sql-injection finding, got: ${JSON.stringify(result.checks.map((c) => c.rule))}`);
      assert.strictEqual(finding.line, 4);
    });
  });
});

// ---------------------------------------------------------------------------
// Positive — template-literal interpolation
// ---------------------------------------------------------------------------

describe('SecurityModule — SQL injection via template-literal interpolation', () => {
  it('flags a SQL string built by interpolating an identifier and passed to conn.query()', async () => {
    await withTmp('gt-sqli-tmpl-', async (tmp) => {
      write(tmp, 'src/db/query.js', `
function findOrderById(orderId) {
  const conn = getConnection();
  const sql = \`SELECT * FROM orders WHERE id = \${orderId}\`;
  return conn.query(sql);
}
module.exports = { findOrderById };
`);
      const result = await run(tmp);
      const finding = result.errors().find((c) => c.rule.startsWith('security:sql-injection:'));
      assert.ok(finding, `expected a sql-injection finding, got: ${JSON.stringify(result.checks.map((c) => c.rule))}`);
      assert.strictEqual(finding.line, 4);
    });
  });

  it('flags an inline template-literal built directly inside the sink call', async () => {
    await withTmp('gt-sqli-tmpl-inline-', async (tmp) => {
      write(tmp, 'src/db/query.js', `
function findProductsByName(name) {
  return conn.query(\`SELECT * FROM products WHERE name LIKE '%\${name}%'\`);
}
module.exports = { findProductsByName };
`);
      const result = await run(tmp);
      const finding = result.errors().find((c) => c.rule.startsWith('security:sql-injection:'));
      assert.ok(finding, `expected a sql-injection finding, got: ${JSON.stringify(result.checks.map((c) => c.rule))}`);
    });
  });
});

// ---------------------------------------------------------------------------
// Negative — parameterised queries and tagged-template builders must NOT fire
// ---------------------------------------------------------------------------

describe('SecurityModule — SQL injection negatives', () => {
  it('does not flag a parameterised query (placeholder + values array)', async () => {
    await withTmp('gt-sqli-param-', async (tmp) => {
      write(tmp, 'src/db/query.js', `
function findUserById(id) {
  const conn = getConnection();
  return conn.query('SELECT * FROM users WHERE id = ?', [id]);
}
module.exports = { findUserById };
`);
      const result = await run(tmp);
      const findings = result.errors().filter((c) => c.rule.startsWith('security:sql-injection:'));
      assert.strictEqual(findings.length, 0, `expected no findings, got: ${JSON.stringify(findings)}`);
    });
  });

  it('does not flag a sql-tagged template builder', async () => {
    await withTmp('gt-sqli-tagged-', async (tmp) => {
      write(tmp, 'src/db/query.js', `
const { sql } = require('./db');
function findOrderById(orderId) {
  const conn = getConnection();
  return conn.query(sql\`SELECT * FROM orders WHERE id = \${orderId}\`);
}
module.exports = { findOrderById };
`);
      const result = await run(tmp);
      const findings = result.errors().filter((c) => c.rule.startsWith('security:sql-injection:'));
      assert.strictEqual(findings.length, 0, `expected no findings, got: ${JSON.stringify(findings)}`);
    });
  });

  // One nested-in-string negative per detection site (task requirement):
  // SQL-injection-shaped text sitting inside an OUTER string literal (test
  // fixtures / example strings writing code as data) must not fire —
  // enforced via BaseModule._isInsideStringLiteral.

  it('does not flag string-concat SQL injection text nested inside an outer string literal', async () => {
    await withTmp('gt-sqli-nested-concat-', async (tmp) => {
      write(tmp, 'src/docs/example.js', `
const EXAMPLE = "const sql = 'SELECT * FROM users WHERE id = ' + id; conn.query(sql);";
module.exports = { EXAMPLE };
`);
      const result = await run(tmp);
      const findings = result.errors().filter((c) => c.rule.startsWith('security:sql-injection:'));
      assert.strictEqual(findings.length, 0, `expected no findings, got: ${JSON.stringify(findings)}`);
    });
  });

  it('does not flag template-literal SQL injection text nested inside an outer string literal', async () => {
    await withTmp('gt-sqli-nested-tmpl-', async (tmp) => {
      write(tmp, 'src/docs/example.js', `
const EXAMPLE = "const sql = \`SELECT * FROM orders WHERE id = \${orderId}\`; conn.query(sql);";
module.exports = { EXAMPLE };
`);
      const result = await run(tmp);
      const findings = result.errors().filter((c) => c.rule.startsWith('security:sql-injection:'));
      assert.strictEqual(findings.length, 0, `expected no findings, got: ${JSON.stringify(findings)}`);
    });
  });
});
