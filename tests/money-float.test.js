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

describe('MoneyFloatModule — generic accumulator names require corroboration', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-generic-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT fire on a lone `total` counter incremented by an integer literal', async () => {
    // Corpus shape (scripts/flywheel-stats.js:60): `all.total += 1` is a
    // plain event counter, not a currency accumulation.
    write(tmp, 'src/a.js', [
      'function tally(entries) {',
      '  const all = { total: 0 };',
      '  for (const e of entries) {',
      '    all.total += 1;',
      '  }',
      '  return all;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:arithmetic:'),
    );
    assert.strictEqual(hits.length, 0, `unexpected findings: ${JSON.stringify(hits, null, 2)}`);
  });

  it('does NOT fire on a lone `total` counter incremented by a .length read', async () => {
    // Corpus shape (src/core/claude-md-parser.js:102): `total += items.length`
    // is a list-size tally, not a currency accumulation.
    write(tmp, 'src/a.js', [
      'function getTotalChecklistItems(checklists) {',
      '  let total = 0;',
      '  for (const items of Object.values(checklists)) {',
      '    total += items.length;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:arithmetic:'),
    );
    assert.strictEqual(hits.length, 0, `unexpected findings: ${JSON.stringify(hits, null, 2)}`);
  });

  it('STILL fires when a lone `total` counter is corroborated by a second money-named identifier', async () => {
    // Corpus shape (src/utils/price.js): `total += item.price * item.qty` —
    // `total` is generic but `price` in the same statement corroborates it.
    write(tmp, 'src/price.js', [
      'function sumCart(items) {',
      '  let total = 0.0;',
      '  for (const item of items) {',
      '    total += item.price * item.qty;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:arithmetic:'));
    assert.ok(hit, 'corroborated total accumulation must still fire');
    assert.strictEqual(hit.severity, 'error');
    assert.strictEqual(hit.variable, 'total');
  });

  it('specific names like `price`/`cost`/`fee`/`salary` still fire alone, uncorroborated', async () => {
    write(tmp, 'src/a.js', [
      'function bump(order) {',
      '  order.cost += 1;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:arithmetic:'));
    assert.ok(hit, 'specific money name must still fire without a second identifier');
    assert.strictEqual(hit.variable, 'cost');
  });

  it('does NOT fire on a dotted generic accumulator (`stats.total * x`) with no real corroboration', async () => {
    // Regression: hasCorroboratingMoneyIdentifier compared tokens against the
    // FULL dotted match string (`stats.total`) captured by the mult/div rule.
    // The tokenizer splits on `.`, so the `total` token never equalled
    // `stats.total` and got tested (and matched) against MONEY_NAME_RE on its
    // own — the accumulator self-corroborated. Must compare against the
    // exclude's last dotted segment instead.
    write(tmp, 'src/a.js', [
      'function scale(stats, multiplier) {',
      '  return stats.total * multiplier;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:arithmetic:'),
    );
    assert.strictEqual(hits.length, 0, `unexpected findings: ${JSON.stringify(hits, null, 2)}`);
  });

  it('STILL fires on a dotted generic accumulator (`stats.total * item.price`) when corroborated by a second money-named identifier', async () => {
    write(tmp, 'src/price.js', [
      'function scale(stats, item) {',
      '  return stats.total * item.price;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('money-float:arithmetic:'));
    assert.ok(hit, 'corroborated dotted total accumulation must still fire');
    assert.strictEqual(hit.severity, 'error');
  });

  it('does NOT fire on a `credit`/`i` false match inside a regex literal chained to a method call', async () => {
    // Corpus shape (website/app/lib/anthropic-error.js:43): the regex literal
    // `/credit|balance/i.test(x)` reads as identifier "credit" followed by
    // `/i` to a naive scan — that's a regex flag + method chain, not division.
    write(tmp, 'src/a.js', [
      'function classify(status, snippet) {',
      '  if (status === 402 || /credit[_ ]balance|out[_ ]of[_ ]credit/i.test(snippet)) {',
      '    return "out-of-credit";',
      '  }',
      '  return "unknown";',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('money-float:arithmetic:'),
    );
    assert.strictEqual(hits.length, 0, `unexpected findings: ${JSON.stringify(hits, null, 2)}`);
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
