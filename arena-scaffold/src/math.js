/**
 * The arena target — a deliberately small, deliberately stable Node.js codebase
 * that the bug-injector mutates. The arena's CI runs the tests below; the
 * ai-ci-fixer is expected to open a PR that restores them to green.
 *
 * Keep this file SIMPLE. The whole point of the arena is that bugs are
 * mechanically introducible and mechanically detectable. Real-world complexity
 * lives in the customer's repo, not here.
 */

'use strict';

function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

function divide(a, b) {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}

function isPositive(n) {
  return n > 0;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort((a, b) => a - b);
}

module.exports = {
  add,
  subtract,
  multiply,
  divide,
  isPositive,
  clamp,
  uniqueSorted,
};
