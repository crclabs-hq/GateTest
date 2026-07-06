'use strict';

const { execFile } = require('child_process');
const path = require('path');
const util = require('util');

const execFileAsync = util.promisify(execFile);

// ---------------------------------------------------------------------------
// DB Client — read-only queries against the project's database.
// Zero new GateTest dependencies: resolves drivers from the project's own
// node_modules, falls back to CLI tools (psql, mysql, sqlite3, mongosh).
// ---------------------------------------------------------------------------

const MAX_ROWS_DEFAULT = 100;
const MAX_ROWS_HARD = 500;
const QUERY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Safety gate — hard-coded, cannot be overridden
// ---------------------------------------------------------------------------

const MUTATION_PATTERN = /^\s*(insert|update|delete|drop|create|alter|truncate|grant|revoke|replace|merge|call|exec|execute)\b/i;

// MongoDB method-style mutations — covers both modern and legacy APIs, plus write-capable ops
const MONGO_MUTATION_PATTERN = /\.\s*(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findAndModify|bulkWrite|drop|dropIndex|dropIndexes|createIndex|ensureIndex|save|remove|update|insert|aggregate|mapReduce|copyTo|renameCollection|runCommand|eval)\s*\(/i;
const MONGO_DB_MUTATION_PATTERN = /\b(dropDatabase|createCollection|runCommand|eval)\s*\(/i;

// Redis read-only command allowlist — STRICT.
// CONFIG, DEBUG, CLIENT, CLUSTER, SLOWLOG, LATENCY are intentionally excluded:
//   CONFIG SET dir + CONFIG SET dbfilename + BGSAVE = RCE on a Redis server
//   DEBUG SLEEP = DoS; DEBUG RELOAD = data manipulation
//   CLIENT KILL = disconnects sessions; CLUSTER FAILOVER = destructive
//   SLOWLOG RESET / LATENCY RESET = clears monitoring data
const REDIS_READ_COMMANDS = new Set([
  // String reads
  'GET', 'MGET', 'GETEX', 'GETRANGE', 'SUBSTR', 'STRLEN',
  // Hash reads
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HRANDFIELD',
  // List reads
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
  // Set reads
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SRANDMEMBER', 'SDIFF', 'SINTER', 'SUNION',
  // Sorted set reads
  'ZRANGE', 'ZRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZREVRANGEBYLEX',
  'ZRANK', 'ZREVRANK', 'ZSCORE', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZMSCORE', 'ZRANDMEMBER',
  // Key inspection / scanning
  'KEYS', 'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN',
  'TYPE', 'TTL', 'PTTL', 'EXISTS', 'RANDOMKEY', 'DUMP',
  // Read-only introspection
  'OBJECT', 'COMMAND', 'TIME', 'MEMORY',
  'INFO', 'DBSIZE',
]);

function assertReadOnly(query) {
  const stripped = query
    .replace(/\/\*[\s\S]*?\*\//g, '') // strip /* */ block comments
    .replace(/--[^\n]*/g, '')          // strip -- line comments
    .replace(/#[^\n]*/g, '')           // strip # comments (MySQL)
    .trim()
    .replace(/;\s*$/, '');             // strip trailing semicolon

  // Reject multi-statement queries (e.g. "SELECT 1; DROP TABLE users")
  if (stripped.includes(';')) {
    throw new Error('Multi-statement queries are blocked. Use a single statement without semicolons.');
  }

  // SQL-style mutation keywords
  if (MUTATION_PATTERN.test(stripped)) {
    throw new Error(`Mutation query blocked: only SELECT, SHOW, DESCRIBE, and EXPLAIN are allowed. Detected: ${stripped.slice(0, 60)}`);
  }

  // MongoDB method-style mutations (e.g. users.drop(), users.insertOne({}))
  if (MONGO_MUTATION_PATTERN.test(stripped) || MONGO_DB_MUTATION_PATTERN.test(stripped)) {
    throw new Error(`MongoDB mutation operation blocked. Only .find() and .countDocuments() are allowed. Detected: ${stripped.slice(0, 60)}`);
  }
}

function assertRedisReadOnly(query) {
  const command = query.trim().split(/\s+/)[0].toUpperCase();
  if (!REDIS_READ_COMMANDS.has(command)) {
    throw new Error(
      `Redis command '${command}' is not on the read-only allowlist. ` +
      `Allowed read commands: GET, HGET, HGETALL, KEYS, SCAN, LRANGE, SMEMBERS, ZRANGE, TYPE, TTL, INFO, etc.`
    );
  }
}

// ---------------------------------------------------------------------------
// Connection string parsing
// ---------------------------------------------------------------------------

function detectDialect(connStr) {
  if (!connStr) return null;
  if (connStr.startsWith('postgres://') || connStr.startsWith('postgresql://')) return 'postgres';
  if (connStr.startsWith('mysql://') || connStr.startsWith('mysql2://')) return 'mysql';
  if (connStr.startsWith('mongodb://') || connStr.startsWith('mongodb+srv://')) return 'mongodb';
  if (connStr.startsWith('redis://') || connStr.startsWith('rediss://')) return 'redis';
  if (connStr.endsWith('.db') || connStr.endsWith('.sqlite') || connStr.endsWith('.sqlite3') || connStr.startsWith('file:')) return 'sqlite';
  return null;
}

function resolveConnection(opts) {
  // 1. Explicit arg
  if (opts.connectionString) return { connStr: opts.connectionString, dialect: detectDialect(opts.connectionString) };
  // 2. Well-known env vars
  const envVars = [
    ['DATABASE_URL', null],
    ['POSTGRES_URL', 'postgres'],
    ['MYSQL_URL', 'mysql'],
    ['MONGODB_URI', 'mongodb'],
    ['REDIS_URL', 'redis'],
    ['SQLITE_URL', 'sqlite'],
    ['DB_URL', null],
  ];
  for (const [varName, hint] of envVars) {
    const val = process.env[varName];
    if (val) return { connStr: val, dialect: hint || detectDialect(val) };
  }
  return { connStr: null, dialect: null };
}

// ---------------------------------------------------------------------------
// Driver resolution — try project's node_modules first
// ---------------------------------------------------------------------------

function tryRequireFrom(projectRoot, ...moduleNames) {
  for (const name of moduleNames) {
    try {
      return require(path.join(projectRoot, 'node_modules', name));
    } catch {}
    // Also try global require as fallback
    try { return require(name); } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

async function queryPostgres(connStr, query, limit, projectRoot) {
  const pg = tryRequireFrom(projectRoot, 'pg');
  if (pg) {
    const client = new pg.Client({ connectionString: connStr });
    await client.connect();
    try {
      const limitedQuery = addLimit(query, limit);
      const result = await client.query(limitedQuery);
      return {
        rows: result.rows.slice(0, limit),
        rowCount: result.rowCount,
        columns: result.fields ? result.fields.map(f => f.name) : [],
        driver: 'pg',
      };
    } finally {
      await client.end();
    }
  }

  // CLI fallback
  const args = [connStr, '-c', addLimit(query, limit), '--csv', '-t'];
  const { stdout } = await execFileAsync('psql', args, { timeout: QUERY_TIMEOUT_MS });
  return { rows: parseCsv(stdout), rowCount: null, columns: [], driver: 'psql-cli' };
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

async function queryMysql(connStr, query, limit, projectRoot) {
  const mysql2 = tryRequireFrom(projectRoot, 'mysql2/promise', 'mysql2');
  if (mysql2) {
    const createConn = mysql2.createConnection || (mysql2.default && mysql2.default.createConnection);
    if (createConn) {
      const conn = await createConn(connStr);
      try {
        const limitedQuery = addLimit(query, limit);
        const [rows, fields] = await conn.execute(limitedQuery);
        return {
          rows: rows.slice(0, limit),
          rowCount: rows.length,
          columns: fields ? fields.map(f => f.name) : [],
          driver: 'mysql2',
        };
      } finally {
        await conn.end();
      }
    }
  }

  // CLI fallback — parse connection string for CLI args
  const url = new URL(connStr.replace('mysql2://', 'mysql://'));
  const args = [
    `-h${url.hostname}`, `-P${url.port || 3306}`,
    `-u${url.username}`, `-p${url.password}`,
    '--batch', '--raw', '-e', addLimit(query, limit),
    url.pathname.slice(1),
  ];
  const { stdout } = await execFileAsync('mysql', args, { timeout: QUERY_TIMEOUT_MS });
  return { rows: parseTsv(stdout), rowCount: null, columns: [], driver: 'mysql-cli' };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function querySqlite(connStr, query, limit, projectRoot) {
  const filePath = connStr.startsWith('file:') ? connStr.slice(5).split('?')[0] : connStr;

  const bsq = tryRequireFrom(projectRoot, 'better-sqlite3');
  if (bsq) {
    const db = new bsq(filePath, { readonly: true });
    try {
      const stmt = db.prepare(addLimit(query, limit));
      const rows = stmt.all();
      return { rows: rows.slice(0, limit), rowCount: rows.length, columns: rows.length ? Object.keys(rows[0]) : [], driver: 'better-sqlite3' };
    } finally {
      db.close();
    }
  }

  // CLI fallback
  const { stdout } = await execFileAsync('sqlite3', ['-json', filePath, addLimit(query, limit)], { timeout: QUERY_TIMEOUT_MS });
  try {
    const rows = JSON.parse(stdout || '[]');
    return { rows: rows.slice(0, limit), rowCount: rows.length, columns: rows.length ? Object.keys(rows[0]) : [], driver: 'sqlite3-cli' };
  } catch {
    return { rows: parseCsv(stdout), rowCount: null, columns: [], driver: 'sqlite3-cli' };
  }
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

async function queryMongodb(connStr, query, limit, projectRoot) {
  // MongoDB queries come in as JS expressions like: db.users.find({}).limit(10)
  // or as JSON filter strings. We support a simplified format:
  // "collection.find({filter})" or just a JSON-stringified find filter.

  const mongodb = tryRequireFrom(projectRoot, 'mongodb');
  if (mongodb) {
    const { MongoClient } = mongodb;
    const client = new MongoClient(connStr);
    await client.connect();
    try {
      const db = client.db();
      // Parse simple "collectionName.find({...})" syntax
      const m = query.trim().match(/^(\w+)\.find\(({[\s\S]*})\)(?:\.limit\((\d+)\))?/);
      if (!m) throw new Error('MongoDB queries must be in format: collectionName.find({filter}).limit(n)');
      const [, collName, filterStr, limitStr] = m;
      const filter = JSON.parse(filterStr);
      const effectiveLimit = Math.min(Number(limitStr) || limit, limit);
      const rows = await db.collection(collName).find(filter).limit(effectiveLimit).toArray();
      return { rows, rowCount: rows.length, columns: rows.length ? Object.keys(rows[0]) : [], driver: 'mongodb' };
    } finally {
      await client.close();
    }
  }

  // CLI fallback — mongosh. Restrict to the same safe find() format as the driver path
  // to prevent arbitrary JavaScript injection via --eval.
  const safeMatch = query.trim().match(/^(\w+)\.find\(({[\s\S]*})\)(?:\.limit\((\d+)\))?$/);
  if (!safeMatch) {
    throw new Error(
      'MongoDB CLI fallback requires: collectionName.find({filter}).limit(n) — ' +
      'install the mongodb npm package for full query support.'
    );
  }
  const [, collName, filterStr, limitStr] = safeMatch;
  const parsedFilter = JSON.parse(filterStr); // validate JSON; throws on invalid JSON
  const effectiveLimit = Math.min(Number(limitStr) || limit, limit);
  // Re-serialize through JSON.stringify so the script contains only safe JSON, not raw user input
  const safeScript = `JSON.stringify(db.${collName}.find(${JSON.stringify(parsedFilter)}).limit(${effectiveLimit}).toArray())`;
  const { stdout } = await execFileAsync('mongosh', [connStr, '--eval', safeScript, '--quiet'], { timeout: QUERY_TIMEOUT_MS });
  try {
    return { rows: JSON.parse(stdout), rowCount: null, columns: [], driver: 'mongosh-cli' };
  } catch {
    return { rows: [{ output: stdout.trim() }], rowCount: null, columns: [], driver: 'mongosh-cli' };
  }
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

async function queryRedis(connStr, query, limit, projectRoot) {
  // Redis queries = Redis CLI commands like "KEYS *" or "GET mykey" or "LRANGE list 0 9"
  // Enforce read-only allowlist before any connection attempt
  assertRedisReadOnly(query);
  const ioredis = tryRequireFrom(projectRoot, 'ioredis');
  if (ioredis) {
    const Redis = ioredis.default || ioredis;
    const client = new Redis(connStr);
    try {
      const parts = query.trim().split(/\s+/);
      const result = await client.call(...parts);
      const rows = Array.isArray(result) ? result.slice(0, limit).map((v, i) => ({ index: i, value: v })) : [{ value: result }];
      return { rows, rowCount: rows.length, columns: ['value'], driver: 'ioredis' };
    } finally {
      client.disconnect();
    }
  }

  // CLI fallback
  const url = new URL(connStr);
  const args = ['-h', url.hostname, '-p', url.port || 6379];
  if (url.password) args.push('-a', url.password);
  args.push(...query.trim().split(/\s+/));
  const { stdout } = await execFileAsync('redis-cli', args, { timeout: QUERY_TIMEOUT_MS });
  return { rows: stdout.trim().split('\n').slice(0, limit).map((text, i) => ({ index: i, value: text })), rowCount: null, columns: ['value'], driver: 'redis-cli' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addLimit(query, limit) {
  const q = query.trim().replace(/;$/, '');
  // Don't double-add LIMIT
  if (/\blimit\s+\d+/i.test(q)) return q;
  // Only add LIMIT to SELECT-style queries
  if (/^\s*(select|with)\b/i.test(q)) return `${q} LIMIT ${limit}`;
  return q;
}

function parseCsv(text) {
  return text.trim().split('\n').map(line => ({ _row: line }));
}

function parseTsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const vals = line.split('\t');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i]; });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * queryDb(query, opts) → Promise<QueryResult>
 *
 * opts.connectionString — explicit connection string (falls back to env)
 * opts.projectRoot      — project root for driver resolution
 * opts.limit            — max rows (default 100, max 500)
 *
 * QueryResult: { rows, rowCount, columns, duration, driver }
 */
async function queryDb(query, opts = {}) {
  assertReadOnly(query);

  const limit = Math.min(opts.limit || MAX_ROWS_DEFAULT, MAX_ROWS_HARD);
  const projectRoot = opts.projectRoot || process.cwd();
  const { connStr, dialect } = resolveConnection(opts);

  if (!connStr) {
    throw new Error(
      'No database connection found. Provide connectionString, or set one of: ' +
      'DATABASE_URL, POSTGRES_URL, MYSQL_URL, MONGODB_URI, REDIS_URL, SQLITE_URL'
    );
  }

  const start = Date.now();
  let result;

  switch (dialect) {
    case 'postgres': result = await queryPostgres(connStr, query, limit, projectRoot); break;
    case 'mysql':    result = await queryMysql(connStr, query, limit, projectRoot); break;
    case 'sqlite':   result = await querySqlite(connStr, query, limit, projectRoot); break;
    case 'mongodb':  result = await queryMongodb(connStr, query, limit, projectRoot); break;
    case 'redis':    result = await queryRedis(connStr, query, limit, projectRoot); break;
    default:
      throw new Error(`Unsupported or unrecognised database dialect from connection string. Detected: ${dialect || 'unknown'}. Supported: postgres, mysql, sqlite, mongodb, redis`);
  }

  return { ...result, duration: Date.now() - start };
}

module.exports = { queryDb, assertReadOnly, assertRedisReadOnly, detectDialect };
