// Control pairs: a loop's header says how many round trips it makes
// (Gluecron 2026-10-03). Over chunks it is the batching fix; over a small
// literal bound it is a retry; over a module constant the count is fixed in
// source (warning). The per-row loop beside each still blocks.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const NPlusOneModule = require('../src/modules/n-plus-one');

async function findings(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-n1-chunk-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/x.ts'), body);
    const checks = [];
    await new NPlusOneModule().run({ addCheck(n, p, d = {}) { checks.push({ name: n, passed: p, ...d }); } }, { projectRoot: root });
    return checks.filter((c) => /query-in-loop/.test(c.name)).map((c) => c.severity);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('nPlusOne — loops whose count does not grow with the data', () => {
  it('chunked insert: i += CHUNK', async () => {
    assert.deepStrictEqual(await findings([
      'export async function save(rows) {',
      '  const CHUNK = 500;',
      '  for (let i = 0; i < rows.length; i += CHUNK) {',
      '    await db.insert(repoDependencies).values(rows.slice(i, i + CHUNK));',
      '  }',
      '}',
    ].join('\n')), []);
  });

  it('chunked insert: for (const part of chunk(list, N))', async () => {
    assert.deepStrictEqual(await findings([
      'export async function save(plan) {',
      '  for (const part of chunk(plan.milestones, INSERT_CHUNK)) {',
      '    await db.insert(milestones).values(part);',
      '  }',
      '}',
    ].join('\n')), []);
  });

  it('bounded retry: attempt < 5', async () => {
    assert.deepStrictEqual(await findings([
      'export async function create(user) {',
      '  for (let attempt = 0; attempt < 5; attempt++) {',
      '    const [g] = await db.insert(gists).values({ ownerId: user.id }).returning();',
      '    if (g) return g;',
      '  }',
      '}',
    ].join('\n')), []);
  });

  it('constant list fixed in source is a warning', async () => {
    assert.deepStrictEqual(await findings([
      'export async function seed(repoId) {',
      '  for (const l of DEFAULT_LABELS) {',
      '    await db.insert(labels).values({ repositoryId: repoId, name: l.name });',
      '  }',
      '}',
    ].join('\n')), ['warning']);
  });
});

describe('nPlusOne — per-row loops still block', () => {
  it('for (const r of rows) with a query per row', async () => {
    assert.deepStrictEqual(await findings([
      'export async function renumber(plan) {',
      '  for (const r of plan.renumber) {',
      '    await db.update(pullRequests).set({ number: r.to }).where(eq(pullRequests.id, r.destId));',
      '  }',
      '}',
    ].join('\n')), ['error']);
  });

  it('a counted loop bounded by data length', async () => {
    assert.deepStrictEqual(await findings([
      'export async function each(rows) {',
      '  for (let i = 0; i < rows.length; i++) {',
      '    await db.select().from(users).where(eq(users.id, rows[i].id));',
      '  }',
      '}',
    ].join('\n')), ['error']);
  });
});
