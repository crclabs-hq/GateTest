const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { scanInventory } = require('../src/core/scan-scope');

// Issue #630 — the pre-scan "Scanning N files in P packages across M
// modules" line needs real numbers, derived from the same walk every
// module honours (WALK_EXCLUDE_SET) plus the one workspace-package
// definition (src/core/workspaces.js), never a second hand-typed estimate.
describe('scan-scope — scanInventory (issue #630 pre-scan counts)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-scan-inv-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('counts files and excludes node_modules/dist/coverage exactly like every module\'s walk', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.js'), '1;');
    fs.writeFileSync(path.join(tmp, 'src', 'b.js'), '2;');
    // Noise that must NOT be counted.
    fs.mkdirSync(path.join(tmp, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'left-pad', 'index.js'), 'noise');
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dist', 'bundle.js'), 'noise');
    fs.mkdirSync(path.join(tmp, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'coverage', 'index.html'), 'noise');

    const inv = scanInventory(tmp);
    // package.json + src/a.js + src/b.js = 3. None of the excluded-dir files.
    assert.strictEqual(inv.fileCount, 3);
  });

  it('reports one package for a plain (non-monorepo) project', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'index.js'), '1;');
    const inv = scanInventory(tmp);
    assert.strictEqual(inv.packageCount, 1);
  });

  it('counts real workspace members as separate packages', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    for (const name of ['a', 'b', 'c']) {
      const dir = path.join(tmp, 'packages', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@x/${name}` }));
      fs.writeFileSync(path.join(dir, 'index.js'), '1;');
    }
    const inv = scanInventory(tmp);
    assert.strictEqual(inv.packageCount, 3);
    // root package.json (1) + 3 * (package.json + index.js) = 7
    assert.strictEqual(inv.fileCount, 7);
  });
});
