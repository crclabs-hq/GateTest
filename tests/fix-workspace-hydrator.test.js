// ============================================================================
// FIX-WORKSPACE-HYDRATOR TEST — Phase 1.2b production wiring
// ============================================================================
// Covers website/app/lib/fix-workspace-hydrator.js — the server-side
// hydration that finally activates the cross-fix scanner gate (plus
// contextual grounding / stack detection) for production callers that
// don't supply originalFileContents + originalFindingsByModule.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hydrateFixWorkspace,
  selectFilesToHydrate,
  findingsByModuleFromScan,
  CONVENTION_FILES,
} = require('../website/app/lib/fix-workspace-hydrator.js');

// ----------------------------------------------------------------------------
// selectFilesToHydrate
// ----------------------------------------------------------------------------

const tree = [
  'src/app.ts',
  'src/db.ts',
  'src/util/helpers.ts',
  'package.json',
  'README.md',
  'tsconfig.json',
  'node_modules/react/index.js',
  'dist/bundle.js',
  'assets/logo.png',
  'src/big.min.js',
];

test('issue files come first, then convention files, then source files', () => {
  const picked = selectFilesToHydrate({ treePaths: tree, issueFiles: ['src/db.ts'], maxFiles: 60 });
  assert.equal(picked[0], 'src/db.ts');
  assert.ok(picked.includes('package.json'));
  assert.ok(picked.includes('README.md'));
  assert.ok(picked.includes('src/app.ts'));
});

test('node_modules, dist, minified and binary files are never hydrated', () => {
  const picked = selectFilesToHydrate({ treePaths: tree, issueFiles: [], maxFiles: 60 });
  assert.ok(!picked.includes('node_modules/react/index.js'));
  assert.ok(!picked.includes('dist/bundle.js'));
  assert.ok(!picked.includes('assets/logo.png'));
  assert.ok(!picked.includes('src/big.min.js'));
});

test('cap is respected and issue files survive the cap', () => {
  const bigTree = Array.from({ length: 200 }, (_, i) => `src/file${i}.ts`).concat(['src/target.ts']);
  const picked = selectFilesToHydrate({ treePaths: bigTree, issueFiles: ['src/target.ts'], maxFiles: 10 });
  assert.equal(picked.length, 10);
  assert.equal(picked[0], 'src/target.ts');
});

test('issue files not present in the tree are skipped (deleted/renamed)', () => {
  const picked = selectFilesToHydrate({ treePaths: tree, issueFiles: ['gone/missing.ts'], maxFiles: 60 });
  assert.ok(!picked.includes('gone/missing.ts'));
});

test('no duplicates when an issue file is also a convention file', () => {
  const picked = selectFilesToHydrate({ treePaths: tree, issueFiles: ['package.json'], maxFiles: 60 });
  assert.equal(picked.filter((p) => p === 'package.json').length, 1);
});

// ----------------------------------------------------------------------------
// findingsByModuleFromScan
// ----------------------------------------------------------------------------

test('maps module details and drops empty/detail-less modules', () => {
  const out = findingsByModuleFromScan({
    modules: [
      { name: 'tlsSecurity', details: ['src/a.ts:1: rejectUnauthorized'] },
      { name: 'lint', details: [] },
      { name: 'syntax' },
      { name: 'weird', details: ['ok', 42, null] },
    ],
  });
  assert.deepEqual(Object.keys(out).sort(), ['tlsSecurity', 'weird']);
  assert.deepEqual(out.weird, ['ok']);
});

test('handles null/empty scans', () => {
  assert.deepEqual(findingsByModuleFromScan(null), {});
  assert.deepEqual(findingsByModuleFromScan({}), {});
});

// ----------------------------------------------------------------------------
// hydrateFixWorkspace
// ----------------------------------------------------------------------------

const fetchTreeOk = async () => tree;
const fetchBlobOk = async (_o, _r, path) => `// contents of ${path}`;

test('caller-supplied workspace + findings short-circuits (no fetching)', async () => {
  let fetched = false;
  const res = await hydrateFixWorkspace({
    owner: 'o', repo: 'r', token: 't', issueFiles: [],
    existingFileContents: [{ path: 'a.ts', content: 'x' }],
    existingFindings: { lint: ['a.ts:1: thing'] },
    fetchTree: async () => { fetched = true; return tree; },
    fetchBlob: fetchBlobOk,
  });
  assert.equal(fetched, false);
  assert.equal(res.hydratedFiles, false);
  assert.equal(res.hydratedFindings, false);
  assert.equal(res.fileContents[0].path, 'a.ts');
});

test('hydrates files and computes baseline findings via runTier', async () => {
  const res = await hydrateFixWorkspace({
    owner: 'o', repo: 'r', token: 't', tier: 'full',
    issueFiles: ['src/db.ts'],
    fetchTree: fetchTreeOk,
    fetchBlob: fetchBlobOk,
    runTier: async (tier, ctx) => {
      assert.equal(tier, 'full');
      assert.ok(ctx.fileContents.length > 0);
      return { modules: [{ name: 'nPlusOne', details: ['src/db.ts:9: query in loop'] }], totalIssues: 1 };
    },
  });
  assert.equal(res.hydratedFiles, true);
  assert.equal(res.hydratedFindings, true);
  assert.deepEqual(res.findingsByModule, { nPlusOne: ['src/db.ts:9: query in loop'] });
  assert.equal(res.fileContents[0].path, 'src/db.ts');
  assert.equal(res.reason, null);
});

test('tree failure degrades cleanly — no throw, gate-skip state returned', async () => {
  const res = await hydrateFixWorkspace({
    owner: 'o', repo: 'r', token: 't', issueFiles: [],
    fetchTree: async () => { throw new Error('403 rate limited'); },
    fetchBlob: fetchBlobOk,
    runTier: async () => ({ modules: [], totalIssues: 0 }),
  });
  assert.equal(res.hydratedFiles, false);
  assert.equal(res.fileContents.length, 0);
  assert.equal(res.findingsByModule, null);
  assert.match(res.reason, /403 rate limited/);
});

test('empty tree reported, blob failures skipped silently', async () => {
  const emptyRes = await hydrateFixWorkspace({
    owner: 'o', repo: 'r', token: 't', issueFiles: [],
    fetchTree: async () => [],
    fetchBlob: fetchBlobOk,
  });
  assert.match(emptyRes.reason, /empty repo tree/);

  const partialRes = await hydrateFixWorkspace({
    owner: 'o', repo: 'r', token: 't', issueFiles: [],
    fetchTree: fetchTreeOk,
    fetchBlob: async (_o, _r, path) => (path === 'package.json' ? null : `// ${path}`),
  });
  assert.equal(partialRes.hydratedFiles, true);
  assert.ok(!partialRes.fileContents.some((f) => f.path === 'package.json'));
});

test('baseline scan failure leaves findings null but keeps the files', async () => {
  const res = await hydrateFixWorkspace({
    owner: 'o', repo: 'r', token: 't', issueFiles: [],
    fetchTree: fetchTreeOk,
    fetchBlob: fetchBlobOk,
    runTier: async () => { throw new Error('scanner exploded'); },
  });
  assert.equal(res.hydratedFiles, true);
  assert.equal(res.findingsByModule, null);
  assert.equal(res.hydratedFindings, false);
  assert.match(res.reason, /scanner exploded/);
});

test('caller findings are kept even when files must be hydrated', async () => {
  let tierRan = false;
  const res = await hydrateFixWorkspace({
    owner: 'o', repo: 'r', token: 't', issueFiles: [],
    existingFindings: { lint: ['x'] },
    fetchTree: fetchTreeOk,
    fetchBlob: fetchBlobOk,
    runTier: async () => { tierRan = true; return { modules: [], totalIssues: 0 }; },
  });
  assert.equal(res.hydratedFiles, true);
  assert.equal(tierRan, false, 'must not recompute a baseline the caller supplied');
  assert.deepEqual(res.findingsByModule, { lint: ['x'] });
});

test('convention files list covers grounding + stack detection inputs', () => {
  for (const f of ['package.json', 'README.md', 'tsconfig.json', 'Dockerfile']) {
    assert.ok(CONVENTION_FILES.includes(f), `${f} missing from CONVENTION_FILES`);
  }
});

test('convention files list includes monorepo workspace configs (Phase 1C)', () => {
  for (const f of ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json']) {
    assert.ok(CONVENTION_FILES.includes(f), `${f} missing from CONVENTION_FILES — needed for monorepo detection`);
  }
});
