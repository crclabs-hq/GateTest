/**
 * Tests for website/app/lib/notify-store.js — the "email me when it
 * launches" capture behind /api/notify (first topic: pentest,
 * Craig 2026-07-14).
 *
 * Uses the same fake Neon tagged-template `sql` recorder as the other
 * store tests: queries are captured as flattened strings and canned row
 * sets are returned in order.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const Store = require('../website/app/lib/notify-store');

function fakeSql(results = []) {
  const queries = [];
  let i = 0;
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    queries.push({ text, values });
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/i.test(text)) {
      return Promise.resolve([]);
    }
    const result = i < results.length ? results[i] : [];
    i += 1;
    return Promise.resolve(result);
  };
  sql.queries = queries;
  return sql;
}

// ---------------------------------------------------------------------------
// isValidEmail / normalizeEmail
// ---------------------------------------------------------------------------

describe('isValidEmail', () => {
  test('accepts ordinary addresses', () => {
    assert.strictEqual(Store.isValidEmail('craig@gatetest.ai'), true);
    assert.strictEqual(Store.isValidEmail('a.b+tag@sub.example.co.nz'), true);
  });

  test('rejects garbage', () => {
    assert.strictEqual(Store.isValidEmail(''), false);
    assert.strictEqual(Store.isValidEmail('   '), false);
    assert.strictEqual(Store.isValidEmail('no-at-sign'), false);
    assert.strictEqual(Store.isValidEmail('two@@ats.com'), false);
    assert.strictEqual(Store.isValidEmail('spaces in@email.com'), false);
    assert.strictEqual(Store.isValidEmail('no-tld@domain'), false);
    assert.strictEqual(Store.isValidEmail(null), false);
    assert.strictEqual(Store.isValidEmail(42), false);
  });

  test('rejects addresses over the RFC 5321 length cap', () => {
    const long = `${'a'.repeat(250)}@example.com`;
    assert.strictEqual(Store.isValidEmail(long), false);
  });
});

describe('normalizeEmail', () => {
  test('trims and lowercases', () => {
    assert.strictEqual(Store.normalizeEmail('  Craig@GateTest.AI '), 'craig@gatetest.ai');
  });
});

// ---------------------------------------------------------------------------
// addSignup
// ---------------------------------------------------------------------------

describe('addSignup', () => {
  test('inserts a normalized row and reports new signup', async () => {
    const sql = fakeSql([[{ id: 1 }]]);
    const result = await Store.addSignup(sql, { email: ' Craig@GateTest.AI ', topic: 'pentest' });
    assert.deepStrictEqual(result, { ok: true, alreadySignedUp: false });
    const insert = sql.queries.find((q) => q.text.startsWith('INSERT INTO notify_signups'));
    assert.ok(insert, 'INSERT issued');
    assert.strictEqual(insert.values[0], 'craig@gatetest.ai');
    assert.strictEqual(insert.values[1], 'pentest');
    assert.match(insert.text, /ON CONFLICT \(email, topic\) DO NOTHING/);
  });

  test('repeat signup is a no-op, not an error', async () => {
    const sql = fakeSql([[]]); // ON CONFLICT DO NOTHING returns no rows
    const result = await Store.addSignup(sql, { email: 'craig@gatetest.ai', topic: 'pentest' });
    assert.deepStrictEqual(result, { ok: true, alreadySignedUp: true });
  });

  test('rejects invalid email', async () => {
    const sql = fakeSql();
    await assert.rejects(
      () => Store.addSignup(sql, { email: 'not-an-email', topic: 'pentest' }),
      /invalid email/
    );
    assert.strictEqual(sql.queries.length, 0, 'no query issued');
  });

  test('rejects unknown topic', async () => {
    const sql = fakeSql();
    await assert.rejects(
      () => Store.addSignup(sql, { email: 'craig@gatetest.ai', topic: 'jetpacks' }),
      /invalid topic/
    );
    assert.strictEqual(sql.queries.length, 0, 'no query issued');
  });

  test('requires sql', async () => {
    await assert.rejects(
      () => Store.addSignup(null, { email: 'craig@gatetest.ai', topic: 'pentest' }),
      /sql is required/
    );
  });
});

// ---------------------------------------------------------------------------
// listSignups
// ---------------------------------------------------------------------------

describe('listSignups', () => {
  test('returns rows for a valid topic', async () => {
    const rows = [
      { email: 'a@example.com', created_at: '2026-07-14T00:00:00Z' },
      { email: 'b@example.com', created_at: '2026-07-14T01:00:00Z' },
    ];
    const sql = fakeSql([rows]);
    const result = await Store.listSignups(sql, 'pentest');
    assert.deepStrictEqual(result, rows);
    const select = sql.queries.find((q) => q.text.startsWith('SELECT email'));
    assert.ok(select, 'SELECT issued');
    assert.strictEqual(select.values[0], 'pentest');
  });

  test('rejects unknown topic', async () => {
    const sql = fakeSql();
    await assert.rejects(() => Store.listSignups(sql, 'jetpacks'), /invalid topic/);
  });
});
