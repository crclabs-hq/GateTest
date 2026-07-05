'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// mcp-query-db.test.js — tests for query_db MCP handler and
// the underlying src/core/db-client.js safety gate + driver resolution.
// ---------------------------------------------------------------------------

let mcp;
before(async () => {
  mcp = await import('../bin/gatetest-mcp.mjs');
});

describe('db-client safety gate', () => {
  const { assertReadOnly, detectDialect } = require('../src/core/db-client.js');

  test('assertReadOnly is exported', () => {
    assert.strictEqual(typeof assertReadOnly, 'function');
  });

  test('INSERT is blocked', () => {
    assert.throws(() => assertReadOnly("INSERT INTO users VALUES (1, 'x')"), /blocked/i);
  });

  test('UPDATE is blocked', () => {
    assert.throws(() => assertReadOnly('UPDATE users SET name = "x"'), /blocked/i);
  });

  test('DELETE is blocked', () => {
    assert.throws(() => assertReadOnly('DELETE FROM users WHERE id = 1'), /blocked/i);
  });

  test('DROP is blocked', () => {
    assert.throws(() => assertReadOnly('DROP TABLE users'), /blocked/i);
  });

  test('CREATE is blocked', () => {
    assert.throws(() => assertReadOnly('CREATE TABLE foo (id INT)'), /blocked/i);
  });

  test('ALTER is blocked', () => {
    assert.throws(() => assertReadOnly('ALTER TABLE users ADD COLUMN x INT'), /blocked/i);
  });

  test('TRUNCATE is blocked', () => {
    assert.throws(() => assertReadOnly('TRUNCATE users'), /blocked/i);
  });

  test('EXECUTE is blocked', () => {
    assert.throws(() => assertReadOnly('EXECUTE sp_something'), /blocked/i);
  });

  test('SELECT passes', () => {
    assert.doesNotThrow(() => assertReadOnly('SELECT * FROM users LIMIT 10'));
  });

  test('SELECT with WITH CTE passes', () => {
    assert.doesNotThrow(() => assertReadOnly('WITH cte AS (SELECT id FROM t) SELECT * FROM cte'));
  });

  test('SHOW passes', () => {
    assert.doesNotThrow(() => assertReadOnly('SHOW TABLES'));
  });

  test('DESCRIBE passes', () => {
    assert.doesNotThrow(() => assertReadOnly('DESCRIBE users'));
  });

  test('EXPLAIN passes', () => {
    assert.doesNotThrow(() => assertReadOnly('EXPLAIN SELECT * FROM users'));
  });

  test('comment-wrapped mutation is still blocked', () => {
    assert.throws(() => assertReadOnly('/* innocent */ INSERT INTO x VALUES (1)'), /blocked/i);
  });

  test('multi-statement query is blocked (SELECT + DROP)', () => {
    assert.throws(() => assertReadOnly('SELECT 1; DROP TABLE users'), /multi-statement|blocked/i);
  });

  test('multi-statement query is blocked (SELECT + INSERT)', () => {
    assert.throws(() => assertReadOnly("SELECT * FROM t; INSERT INTO t VALUES (1,'x')"), /multi-statement|blocked/i);
  });

  test('trailing semicolon alone does not block', () => {
    // Trailing semicolons are stripped before the check
    assert.doesNotThrow(() => assertReadOnly('SELECT 1;'));
  });

  test('MongoDB .insertOne() is blocked', () => {
    assert.throws(() => assertReadOnly("users.insertOne({name:'evil'})"), /blocked/i);
  });

  test('MongoDB .updateOne() is blocked', () => {
    assert.throws(() => assertReadOnly('users.updateOne({id:1},{$set:{x:2}})'), /blocked/i);
  });

  test('MongoDB .deleteOne() is blocked', () => {
    assert.throws(() => assertReadOnly('users.deleteOne({id:1})'), /blocked/i);
  });

  test('MongoDB .drop() is blocked', () => {
    assert.throws(() => assertReadOnly('users.drop()'), /blocked/i);
  });

  test('MongoDB .dropIndexes() is blocked', () => {
    assert.throws(() => assertReadOnly('users.dropIndexes()'), /blocked/i);
  });

  test('MongoDB dropDatabase() is blocked', () => {
    assert.throws(() => assertReadOnly('dropDatabase()'), /blocked/i);
  });

  test('MongoDB .find() passes assertReadOnly', () => {
    assert.doesNotThrow(() => assertReadOnly('users.find({active:true}).limit(10)'));
  });
});

describe('db-client Redis read-only gate', () => {
  const { assertRedisReadOnly } = require('../src/core/db-client.js');

  test('assertRedisReadOnly is exported', () => {
    assert.strictEqual(typeof assertRedisReadOnly, 'function');
  });

  test('SET is blocked', () => {
    assert.throws(() => assertRedisReadOnly('SET mykey myvalue'), /not on the read-only allowlist/i);
  });

  test('DEL is blocked', () => {
    assert.throws(() => assertRedisReadOnly('DEL mykey'), /not on the read-only allowlist/i);
  });

  test('FLUSHALL is blocked', () => {
    assert.throws(() => assertRedisReadOnly('FLUSHALL'), /not on the read-only allowlist/i);
  });

  test('FLUSHDB is blocked', () => {
    assert.throws(() => assertRedisReadOnly('FLUSHDB'), /not on the read-only allowlist/i);
  });

  test('LPUSH is blocked', () => {
    assert.throws(() => assertRedisReadOnly('LPUSH mylist value'), /not on the read-only allowlist/i);
  });

  test('GET passes', () => {
    assert.doesNotThrow(() => assertRedisReadOnly('GET mykey'));
  });

  test('HGETALL passes', () => {
    assert.doesNotThrow(() => assertRedisReadOnly('HGETALL myhash'));
  });

  test('KEYS passes', () => {
    assert.doesNotThrow(() => assertRedisReadOnly('KEYS *'));
  });

  test('SCAN passes', () => {
    assert.doesNotThrow(() => assertRedisReadOnly('SCAN 0 MATCH * COUNT 100'));
  });

  test('INFO passes', () => {
    assert.doesNotThrow(() => assertRedisReadOnly('INFO server'));
  });

  test('case-insensitive — set is also blocked', () => {
    assert.throws(() => assertRedisReadOnly('set mykey value'), /not on the read-only allowlist/i);
  });
});

describe('db-client dialect detection', () => {
  const { detectDialect } = require('../src/core/db-client.js');

  test('postgres:// → postgres', () => {
    assert.strictEqual(detectDialect('postgres://user:pass@localhost/db'), 'postgres');
  });

  test('postgresql:// → postgres', () => {
    assert.strictEqual(detectDialect('postgresql://user:pass@localhost/db'), 'postgres');
  });

  test('mysql:// → mysql', () => {
    assert.strictEqual(detectDialect('mysql://user:pass@localhost/db'), 'mysql');
  });

  test('mysql2:// → mysql', () => {
    assert.strictEqual(detectDialect('mysql2://user:pass@localhost/db'), 'mysql');
  });

  test('mongodb:// → mongodb', () => {
    assert.strictEqual(detectDialect('mongodb://localhost/db'), 'mongodb');
  });

  test('mongodb+srv:// → mongodb', () => {
    assert.strictEqual(detectDialect('mongodb+srv://cluster0.abc.mongodb.net/db'), 'mongodb');
  });

  test('redis:// → redis', () => {
    assert.strictEqual(detectDialect('redis://localhost:6379'), 'redis');
  });

  test('.sqlite extension → sqlite', () => {
    assert.strictEqual(detectDialect('/path/to/db.sqlite'), 'sqlite');
  });

  test('.db extension → sqlite', () => {
    assert.strictEqual(detectDialect('/path/to/myapp.db'), 'sqlite');
  });

  test('file: prefix → sqlite', () => {
    assert.strictEqual(detectDialect('file:./mydb.sqlite?cache=shared'), 'sqlite');
  });

  test('null → null', () => {
    assert.strictEqual(detectDialect(null), null);
  });
});

describe('db-client max rows cap', () => {
  const { queryDb } = require('../src/core/db-client.js');

  test('queryDb is exported', () => {
    assert.strictEqual(typeof queryDb, 'function');
  });

  test('queryDb rejects mutation query before touching connection', async () => {
    await assert.rejects(
      () => queryDb('DELETE FROM foo', { connectionString: 'postgres://localhost/test' }),
      /blocked/i,
    );
  });

  test('queryDb rejects when no connection available', async () => {
    // Clear env to avoid accidentally picking up a real DB
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.MYSQL_URL;
    delete process.env.MONGODB_URI;
    delete process.env.REDIS_URL;
    delete process.env.SQLITE_URL;
    delete process.env.DB_URL;
    try {
      await assert.rejects(
        () => queryDb('SELECT 1', {}),
        /no database connection/i,
      );
    } finally {
      if (saved) process.env.DATABASE_URL = saved;
    }
  });
});

describe('MCP query_db handler', () => {
  test('handleQueryDb is exported', () => {
    assert.strictEqual(typeof mcp.handleQueryDb, 'function');
  });

  test('rejects mutation query with isError', async () => {
    const result = await mcp.handleQueryDb({ query: 'DROP TABLE users' });
    assert.ok(result.isError === true || /blocked/i.test(result.content[0].text));
  });

  test('rejects empty query with isError', async () => {
    const result = await mcp.handleQueryDb({ query: '' });
    assert.ok(result.isError === true);
  });

  test('returns error when no connection configured', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.MYSQL_URL;
    delete process.env.MONGODB_URI;
    delete process.env.REDIS_URL;
    delete process.env.SQLITE_URL;
    delete process.env.DB_URL;
    try {
      const result = await mcp.handleQueryDb({ query: 'SELECT 1' });
      assert.ok(result.isError === true || /no database|connection/i.test(result.content[0].text));
    } finally {
      if (saved) process.env.DATABASE_URL = saved;
    }
  });

  test('content is array of text objects', async () => {
    const result = await mcp.handleQueryDb({ query: 'DROP TABLE x' });
    assert.ok(Array.isArray(result.content));
    for (const c of result.content) {
      assert.strictEqual(c.type, 'text');
      assert.strictEqual(typeof c.text, 'string');
    }
  });
});
