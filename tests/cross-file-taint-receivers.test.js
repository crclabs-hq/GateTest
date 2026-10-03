// crossFileTaint control pairs (2026-10-03). Tallrig agents/door/app.ts:
// `i.path.join(".")` is Array.join on a zod issue path, `tool.execute(x)` and
// `this.idempotency.run(x)` are ordinary methods. Gluecron blog.tsx: a row
// looked up in a constant table by a tainted slug is the table's row. The
// real sinks beside each still fire.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CrossFileTaint = require('../src/modules/cross-file-taint.js');

async function sinks(src) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-taint-recv-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/app.js'), src);
    const checks = [];
    await new CrossFileTaint().run({ addCheck(rule, passed, meta = {}) { checks.push({ rule, passed, ...meta }); } }, { projectRoot: root });
    return checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.rule.split(':').slice(0, 3).join(':'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const handler = (body) => `app.post('/x', async (req, res) => {\n  const input = req.body.input;\n${body}\n});\n`;

describe('crossFileTaint — not sinks', () => {
  it('a member named path: issue.path.join(".")', async () => {
    assert.deepStrictEqual(await sinks(handler('  const msg = input.issues.map((i) => i.path.join("."));\n  res.json(msg);')), []);
  });
  it('tool.execute(x) and this.idempotency.run(x)', async () => {
    assert.deepStrictEqual(await sinks(handler('  await tool.execute(input);\n  await this.idempotency.run(input);')), []);
  });
  it('a row looked up in a constant table', async () => {
    assert.deepStrictEqual(await sinks(handler('  const post = POSTS.find((p) => p.slug === input);\n  el.innerHTML = post;')), []);
  });
});

describe('crossFileTaint — still sinks', () => {
  it('path.join(root, input)', async () => {
    assert.deepStrictEqual(await sinks(handler('  const p = path.join(root, input);\n  res.send(p);')), ['taint:sink:path-join']);
  });
  it('db.execute(input) / stmt.run(input)', async () => {
    assert.deepStrictEqual(await sinks(handler('  await db.execute(input);')), ['taint:sink:sql-query']);
    assert.deepStrictEqual(await sinks(handler('  await stmt.run(input);')), ['taint:sink:sql-query']);
  });
  it('a value derived from input, not a table lookup', async () => {
    assert.deepStrictEqual(await sinks(handler('  const post = input.trimEnd();\n  el.innerHTML = post;')), ['taint:sink:dom-inject']);
  });
});
