const { test } = require('node:test');
const assert = require('node:assert');
const { lineLocator, lineAt } = require('../src/core/line-at');

test('lineAt: offsets map to 1-based line and column, LF and CRLF alike (#842 DR-b)', () => {
  const lf = 'ab\ncd\n\nef';
  assert.deepStrictEqual(lineAt(lf, 0), { line: 1, column: 1 });
  assert.deepStrictEqual(lineAt(lf, 2), { line: 1, column: 3 });
  assert.deepStrictEqual(lineAt(lf, 3), { line: 2, column: 1 });
  assert.deepStrictEqual(lineAt(lf, 6), { line: 3, column: 1 });
  assert.deepStrictEqual(lineAt(lf, 8), { line: 4, column: 2 });
  const crlf = 'ab\r\ncd\r\nef';
  assert.deepStrictEqual(lineAt(crlf, 4), { line: 2, column: 1 });
  assert.deepStrictEqual(lineAt(crlf, crlf.indexOf('ef')), { line: 3, column: 1 });
});

test('lineLocator: one index per file answers every offset; out-of-range offsets clamp', () => {
  const at = lineLocator('x\ny\nz');
  assert.deepStrictEqual(at(4), { line: 3, column: 1 });
  assert.deepStrictEqual(at(-5), { line: 1, column: 1 });
  assert.deepStrictEqual(at(99), { line: 3, column: 2 });
  assert.deepStrictEqual(lineLocator(null)(3), { line: 1, column: 1 });
});
