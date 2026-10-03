// undefinedRef's stripper blanks regex literals. Tallrig minio.ts:
// `.replace(/"/g, "")` opened a "string" at the quote inside the regex and
// inverted the rest of the file, so `new Error("minio: completeMultipart
// returned …")` was read as code naming an undeclared `completeMultipart`.
// Control: a real undeclared object-literal value after the same regex fires.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UndefinedRef = require('../src/modules/undefined-ref');

async function flagged(src) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-re-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/minio.ts'), src);
    const checks = [];
    await new UndefinedRef().run({ addCheck(n, p) { checks.push({ n, p }); } }, { projectRoot: root });
    return checks.filter((c) => !c.p && c.n.startsWith('undefined-ref:')).map((c) => c.n.split(':')[1]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const HEAD = [
  'export class Driver {',
  '  async etag(h: string) { return (h ?? "").replace(/"/g, ""); }',
  '  async completeMultipart() { return null; }',
  '  async go() {',
].join('\n');

describe('undefinedRef — regex literals are not strings', () => {
  it('a message after /"/g is still a string', async () => {
    assert.deepStrictEqual(await flagged(`${HEAD}\n    throw new Error("minio: completeMultipart returned no object");\n  }\n}\n`), []);
  });
  it('a division is not a regex', async () => {
    assert.deepStrictEqual(await flagged('export const half = (a: number, b: number) => a / b / 2;\nexport const s = "x: y";\n'), []);
  });
  it('control: an undeclared object-literal value after the regex still fires', async () => {
    assert.deepStrictEqual(await flagged(`${HEAD}\n    return { key: missingThing };\n  }\n}\n`), ['missingThing']);
  });
});
