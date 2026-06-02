'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  add,
  subtract,
  multiply,
  divide,
  isPositive,
  clamp,
  uniqueSorted,
} = require('../src/math');

test('add: positive integers', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(0, 0), 0);
  assert.equal(add(-1, 1), 0);
});

test('subtract: positive integers', () => {
  assert.equal(subtract(5, 3), 2);
  assert.equal(subtract(0, 0), 0);
});

test('multiply: positive integers', () => {
  assert.equal(multiply(3, 4), 12);
  assert.equal(multiply(0, 999), 0);
});

test('divide: throws on zero', () => {
  assert.throws(() => divide(1, 0));
  assert.equal(divide(10, 2), 5);
});

test('isPositive: strict greater-than-zero', () => {
  assert.equal(isPositive(1), true);
  assert.equal(isPositive(0), false);
  assert.equal(isPositive(-1), false);
});

test('clamp: bounds the value', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});

test('uniqueSorted: dedupes + sorts numeric ascending', () => {
  assert.deepEqual(uniqueSorted([3, 1, 2, 1, 3]), [1, 2, 3]);
  assert.deepEqual(uniqueSorted([]), []);
});
