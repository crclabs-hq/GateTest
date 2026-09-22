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

// Integer minor units rendered for display. `Math.round(cents / 100)` inside
// a template literal (website/app/checkout/page.tsx:17) surfaced the moment
// the shared in-string guard learned that `${…}` is code (2026-09-05). It is
// the correct way to SHOW money stored as cents; the float is never stored.
describe('MoneyFloatModule — minor units divided for display are not float money math', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-display-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const arith = (r) => r.checks.filter((c) => !c.passed && c.name.startsWith('money-float:arithmetic:'));

  it('NEGATIVE: cents / 100 fed to Math.round, toFixed, Intl or a template literal is quiet', async () => {
    write(tmp, 'src/format.ts', [
      'function formatPrice(cents: number): string {',
      '  return `$${Math.round(cents / 100)}`;',
      '}',
      'const label = `${(amountCents / 100).toFixed(2)} USD`;',
      'const pretty = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(pence / 100);',
      '',
    ].join('\n'));
    assert.deepStrictEqual(arith(await run(tmp)).map((c) => c.name), []);
  });

  it('POSITIVE: the same division assigned, returned bare, or on a non-minor name still fires', async () => {
    write(tmp, 'src/charge.ts', [
      'const total = cents / 100;',
      'function dollars(cents: number) { return cents / 100; }',
      'const rounded = Math.round(price / 100);',
      '',
    ].join('\n'));
    const names = arith(await run(tmp)).map((c) => c.name);
    assert.strictEqual(names.length, 3, names.join(', '));
  });

  // issue #633 (2026-09-22): a bare `const label = cents / 100;` — no
  // formatter call, no template literal — was still flagged as money
  // arithmetic even though nothing is stored: the target's OWN name says
  // it's display text. `total` (already covered above) still fires: the
  // fix is scoped to display-shaped target names, not every assignment.
  it('CONTROL PAIR (issue #633): a display-named target (label/text/formatted/…) is quiet; a money-named target (total) still fires', async () => {
    write(tmp, 'src/receipt.ts', [
      'const label = cents / 100;',
      'let formattedText = pence / 100;',
      'const total = cents / 100;',
      '',
    ].join('\n'));
    const names = arith(await run(tmp)).map((c) => c.name);
    assert.deepStrictEqual(names, ['money-float:arithmetic:src/receipt.ts:3']);
  });
});

describe('MoneyFloatModule — one stripper: the masked line decides', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-mask-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('parseFloat / arithmetic on a money name inside a string, a template or a comment is not a cast; the real one beside them is (2026-09-05)', async () => {
    write(tmp, 'src/checkout.js', [
      'const doc = "const total = parseFloat(priceString)";',
      'const tpl = `',
      '  const price = parseFloat(raw);',
      '  const due = fee * 1.2;',
      '`;',
      '/* a block comment that starts on this line',
      '   this.cost = Number(input);',
      '   subtotal += item.price * item.qty */',
      'const price = parseFloat(input);',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const casts = r.checks.filter((c) => c.name.startsWith('money-float:js-parse-float'));
    assert.deepStrictEqual(casts.map((c) => [c.name.split(':')[1], c.line]), [['js-parse-float', 9]]);
    assert.ok(!r.checks.some((c) => c.name.startsWith('money-float:arithmetic:')), 'arithmetic in a template or comment is not arithmetic');
  });
});

describe('MoneyFloatModule — JSX display text quoting an identifier is not a variable reference (self-scan 2026-09-16)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mf-jsx-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const arith = (r) => r.checks.filter((c) => !c.passed && c.name.startsWith('money-float:arithmetic:'));

  // Control pair: website/app/preview/_components/Playground.tsx renders a
  // marketing code-sample as JSX text — `total * 0.0825` appeared as BARE
  // JSX text (not inside a string), which the masker cannot distinguish
  // from real executing code, and fired the arithmetic rule on a component
  // that never runs any arithmetic at all. Wrapping the identifier as a
  // quoted string (`{"total"}`) renders byte-identical output but moves it
  // out of the code the mask leaves visible. A real bare identifier next to
  // an arithmetic operator must still fire.
  it('bare `total * 0.0825` in real code still fires', async () => {
    write(tmp, 'src/quote.js', 'const tax = total * 0.0825;\n');
    assert.strictEqual(arith(await run(tmp)).length, 1);
  });

  it('the same pattern with the identifier quoted as JSX display text does not', async () => {
    write(tmp, 'src/Demo.tsx', 'const el = <>{"total"} * 0.0825</>;\n');
    assert.strictEqual(arith(await run(tmp)).length, 0);
  });
});
