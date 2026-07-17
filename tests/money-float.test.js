const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MoneyFloatModule = require('../src/modules/money-float');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new MoneyFloatModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('MoneyFloatModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'money-float:no-files'));
  });

  it('records summary when files are scanned', async () => {
    write(tmp, 'src/a.ts', 'const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'money-float:summary'));
  });
});

describe('MoneyFloatModule — JS parseFloat/Number on money-named variable', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-jsf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on const price = parseFloat(input)', async () => {
    write(tmp, 'src/a.js', 'const price = parseFloat(input);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:js-parse-float:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on let total = Number(input)', async () => {
    write(tmp, 'src/a.js', 'let total = Number(input);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('money-float:js-parse-float:')));
  });

  it('errors on this.amount = parseFloat(x)', async () => {
    write(tmp, 'src/a.js', 'class C { f() { this.amount = parseFloat(x); } }\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('money-float:js-parse-float-prop:')));
  });

  it('does not flag non-money names', async () => {
    write(tmp, 'src/a.js', 'const count = parseFloat(input);\nconst timeout = Number(input);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag when file imports a decimal library', async () => {
    write(tmp, 'src/a.js', 'const Decimal = require("decimal.js");\nconst price = parseFloat(input);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('MoneyFloatModule — Python float cast on money variable', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-py-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on price = float(input)', async () => {
    write(tmp, 'src/a.py', 'price = float(input)\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:py-float-cast:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on self.total = float(x)', async () => {
    write(tmp, 'src/a.py', 'class C:\n    def f(self):\n        self.total = float(x)\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('money-float:py-float-cast:')));
  });

  it('does not flag non-money variable names', async () => {
    write(tmp, 'src/a.py', 'ratio = float(numerator) / float(denominator)\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag when file imports decimal', async () => {
    write(tmp, 'src/a.py', 'from decimal import Decimal\nprice = float(input)\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('MoneyFloatModule — plain arithmetic on a money-named identifier', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-arith-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on `price * (1 + taxRate)` — no cast needed to be float arithmetic', async () => {
    // Corpus shape (src/utils/price.js).
    write(tmp, 'src/price.js', [
      'function applyTax(price, taxRate) {',
      '  return price * (1 + taxRate);',
      '}',
      '',
      'module.exports = { applyTax };',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:arithmetic:'));
    assert.ok(hit, 'expected a money-float:arithmetic finding');
    assert.strictEqual(hit.severity, 'error');
    assert.strictEqual(hit.variable, 'price');
  });

  it('errors on `total += item.price * item.qty` — compound-assign accumulator', async () => {
    // Corpus shape (src/utils/price.js).
    write(tmp, 'src/price.js', [
      'function sumCart(items) {',
      '  let total = 0.0;',
      '  for (const item of items) {',
      '    total += item.price * item.qty;',
      '  }',
      '  return total;',
      '}',
      '',
      'module.exports = { sumCart };',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:arithmetic:'));
    assert.ok(hit, 'expected a money-float:arithmetic finding');
    assert.strictEqual(hit.variable, 'total');
  });

  it('does NOT flag arithmetic on a money-named identifier nested inside a string literal', async () => {
    write(tmp, 'src/a.js', [
      'const example = "return price * (1 + taxRate);";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:arithmetic:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT flag arithmetic when the file imports a decimal library', async () => {
    write(tmp, 'src/a.js', [
      'const Decimal = require("decimal.js");',
      'function applyTax(price, taxRate) { return price * (1 + taxRate); }',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:arithmetic:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('MoneyFloatModule — insufficient .toFixed precision', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-tf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on price.toFixed(0) — sub-cent', async () => {
    write(tmp, 'src/a.js', 'const s = price.toFixed(0);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:insufficient-precision:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on total.toFixed(1) — sub-cent', async () => {
    write(tmp, 'src/a.js', 'const s = total.toFixed(1);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('money-float:insufficient-precision:')));
  });

  it('does not flag price.toFixed(2)', async () => {
    write(tmp, 'src/a.js', 'const s = price.toFixed(2);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag non-money .toFixed(0)', async () => {
    write(tmp, 'src/a.js', 'const pct = percentage.toFixed(0);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('MoneyFloatModule — suppressions', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-sup-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('honours // money-float-ok on the same line (JS)', async () => {
    write(tmp, 'src/a.js', 'const price = parseFloat(input); // money-float-ok — legacy import\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('honours # money-float-ok on the same line (Python)', async () => {
    write(tmp, 'src/a.py', 'price = float(input)  # money-float-ok\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('MoneyFloatModule — library safe-harbour marker', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-lib-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits decimal-library-ok when library detected', async () => {
    write(tmp, 'src/a.js', 'import Decimal from "decimal.js";\nconst price = new Decimal("19.99");\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'money-float:decimal-library-ok'));
  });
});

describe('MoneyFloatModule — test path downgrade', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-t-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('downgrades error -> warning in test paths (JS)', async () => {
    write(tmp, 'tests/a.test.js', 'const price = parseFloat(input);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:js-parse-float:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('downgrades error -> warning in test paths (Python)', async () => {
    write(tmp, 'tests/test_a.py', 'price = float(input)\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:py-float-cast:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });
});
