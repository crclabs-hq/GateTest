const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RedosModule = require('../src/modules/redos');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new RedosModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('RedosModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'redos:no-files'));
  });

  it('records scanning when source files exist', async () => {
    write(tmp, 'src/a.ts', 'const x = /foo/;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'redos:scanning'));
  });
});

describe('RedosModule — nested quantifier', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-nest-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on (a+)+ literal', async () => {
    write(tmp, 'src/a.ts', 'const re = /(\\w+)+/;\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('redos:nested-quantifier:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on (.*)* literal', async () => {
    write(tmp, 'src/a.ts', 'const re = /(.*)*/;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:nested-quantifier:')));
  });

  it('errors on (?:[abc]+)* non-capturing nested quantifier', async () => {
    write(tmp, 'src/a.ts', 'const re = /(?:[abc]+)*/;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:nested-quantifier:')));
  });

  it('errors on new RegExp("(\\d+)*")', async () => {
    write(tmp, 'src/a.ts', 'const re = new RegExp("(\\\\d+)*");\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:nested-quantifier:')));
  });

  it('does NOT flag a simple anchored pattern', async () => {
    write(tmp, 'src/a.ts', 'const re = /^[a-z]+$/;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('redos:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT flag a single quantifier', async () => {
    write(tmp, 'src/a.ts', 'const re = /foo.*bar/;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('redos:nested-quantifier:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('RedosModule — overlapping alternation', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-alt-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on (a|a)* — same branch repeated', async () => {
    write(tmp, 'src/a.ts', 'const re = /(a|a)*/;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:overlapping-alternation:')));
  });

  it('errors on (\\d|\\d+)* — prefix overlap', async () => {
    write(tmp, 'src/a.ts', 'const re = /(\\d|\\d+)*/;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:overlapping-alternation:')));
  });

  it('does NOT flag distinct alternation (a|b)*', async () => {
    write(tmp, 'src/a.ts', 'const re = /(a|b)*/;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('redos:overlapping-alternation:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('RedosModule — user-controlled regex', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-usr-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on new RegExp(req.body.pattern)', async () => {
    write(tmp, 'src/a.ts', 'const re = new RegExp(req.body.pattern);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('redos:user-controlled-regex:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on RegExp(req.query.filter)', async () => {
    write(tmp, 'src/a.ts', 'const re = RegExp(req.query.filter);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:user-controlled-regex:')));
  });

  it('errors on new RegExp(userInput)', async () => {
    write(tmp, 'src/a.ts', 'function f(userInput) { return new RegExp(userInput); }\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:user-controlled-regex:')));
  });

  it('does NOT flag new RegExp("literal")', async () => {
    write(tmp, 'src/a.ts', 'const re = new RegExp("literal");\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('redos:user-controlled-regex:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('RedosModule — greedy backtrack', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-grd-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on .*X.*Y pattern', async () => {
    write(tmp, 'src/a.ts', 'const re = /.*foo.*bar.*/;\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('redos:greedy-backtrack:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });
});

describe('RedosModule — suppressions and exemptions', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-supp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('respects `// redos-ok` on the same line', async () => {
    write(tmp, 'src/a.ts', 'const re = /(\\w+)+/; // redos-ok — checked against bounded input\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('redos:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('respects `// redos-ok` on the preceding line', async () => {
    write(tmp, 'src/a.ts', '// redos-ok: the input is fixed-length\nconst re = /(\\w+)+/;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('redos:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('downgrades error → warning in test files', async () => {
    write(tmp, 'tests/a.test.ts', 'const re = /(\\w+)+/;\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('redos:nested-quantifier:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('ignores regexes inside block comments', async () => {
    write(tmp, 'src/a.ts', '/* example: const re = /(\\w+)+/; */\nconst x = 1;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('redos:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('ignores regexes inside line comments', async () => {
    write(tmp, 'src/a.ts', 'const x = 1; // example: /(\\w+)+/\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('redos:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('RedosModule — Python', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-py-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on re.compile with catastrophic pattern', async () => {
    write(tmp, 'src/a.py', 'import re\nre.compile(r"(\\w+)*")\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:nested-quantifier:')));
  });
});

describe('RedosModule — summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-sum-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records a summary', async () => {
    write(tmp, 'src/a.ts', 'const re = /^[a-z]+$/;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'redos:summary');
    assert.ok(s);
    assert.match(s.message, /file\(s\).*issue\(s\)/);
  });
});

describe('RedosModule — self-scan fixture false positives', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rdos-self-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a test-fixture regex literal nested in a string arg', async () => {
    write(
      tmp,
      'tests/redos.test.js',
      "write(tmp, 'src/a.ts', 'const re = /(a|a)*/;\\n');\n",
    );
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT flag a test-fixture RegExp() taint call nested in a string arg', async () => {
    write(
      tmp,
      'tests/redos.test.js',
      "write(tmp, 'src/a.ts', 'const re = new RegExp(req.body.pattern);\\n');\n",
    );
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(hits.length, 0);
  });

  it('still flags the same pattern when it is real (unquoted) source', async () => {
    write(tmp, 'src/a.ts', 'const re = /(a|a)*/;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('redos:overlapping-alternation:')));
  });
});
