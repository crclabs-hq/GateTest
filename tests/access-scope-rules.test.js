'use strict';

// Control pairs for src/core/access-scope-rules.js. The firing half is the
// shape Tallrig shipped (TALLRIG-2026-010 / -028, paraphrased — the corpus
// itself is private and never committed here); the quiet half is the fix
// Tallrig made, plus the idioms a real codebase uses instead.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scanAccessScope } = require('../src/core/access-scope-rules');

const rules = (src) => scanAccessScope('src/x.ts', src).map((f) => f.rule);

describe('unscoped-lookup', () => {
  const vuln = [
    'export function ops(db) {',
    '  async function locate(rawName, value) {',
    '    const name = rawName.toLowerCase();',
    '    const zone = matchZone(await db.listZones(), name);',
    '    if (!zone) return { ok: false, status: 404 };',
    '    return { name, zone };',
    '  }',
    '  return { locate };',
    '}',
  ];
  it('fires: a record chosen from every tenant\'s rows and returned unchecked', () => {
    assert.deepEqual(rules(vuln.join('\n')), ['unscoped-lookup']);
  });
  it('fires: `(await db.listProjects()).find(...)` acted on unchecked', () => {
    assert.deepEqual(rules([
      'async function rename(db, slug, next) {',
      '  const p = (await db.listProjects()).find((x) => x.slug === slug);',
      '  await db.update(p.id, { name: next });',
      '}',
    ].join('\n')), ['unscoped-lookup']);
  });
  it('quiet: an allowlist check after the match (the Tallrig fix)', () => {
    const fixed = [...vuln];
    fixed.splice(5, 0, '    if (!allowed.has(zone.name)) return { ok: false, status: 403 };');
    assert.deepEqual(rules(fixed.join('\n')), []);
  });
  it('quiet: an ownership comparison after the match', () => {
    assert.deepEqual(rules([
      'async function get(db, slug, user) {',
      '  const p = (await db.listProjects()).find((x) => x.slug === slug);',
      '  if (!p || p.ownerId !== user.id) return null;',
      '  return p;',
      '}',
    ].join('\n')), []);
  });
  it('quiet: a list scoped by argument is not "every tenant"', () => {
    assert.deepEqual(rules('async function f(db, u, n) { return matchZone(await db.listZones(u), n); }'), []);
  });
  it('quiet: a comment mentioning the owner is not a check', () => {
    assert.deepEqual(rules([
      'async function f(db, n) {',
      '  const z = matchZone(await db.listZones(), n);',
      '  // TODO verify owner',
      '  return z;',
      '}',
    ].join('\n')), ['unscoped-lookup']);
  });
});

describe('soft-state-unfiltered', () => {
  const query = (where, after = []) => [
    'async function lookup(db, host) {',
    '  const rows = await db',
    '    .select({ id: projects.id, port: projects.port, status: projects.status })',
    '    .from(projectDomains)',
    '    .innerJoin(projects, eq(projectDomains.projectId, projects.id))',
    `    .where(${where})`,
    '    .limit(1);',
    ...after,
    '  return rows[0];',
    '}',
  ].join('\n');
  it('fires: lookup by domain reads status but never tests it', () => {
    assert.deepEqual(rules(query('eq(projectDomains.domain, host)')), ['soft-state-unfiltered']);
  });
  it('quiet: the status predicate in the where (the Tallrig fix)', () => {
    assert.deepEqual(rules(query('and(eq(projectDomains.domain, host), ne(projectDomains.status, "removed"))')), []);
  });
  it('quiet: the status tested in code after the query', () => {
    assert.deepEqual(rules(query('eq(projectDomains.domain, host)', ['  if (!rows[0] || rows[0].status === "removed") return null;'])), []);
  });
  it('quiet: a lookup by id is not a natural-key lookup', () => {
    assert.deepEqual(rules(query('eq(projects.id, host)')), []);
  });
  it('quiet: no soft-state column selected — nothing says the table has one', () => {
    assert.deepEqual(rules(query('eq(projectDomains.domain, host)').replace(', status: projects.status', '')), []);
  });
});
