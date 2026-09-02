// =============================================================================
// CORPUS GATE — the comparison logic, tested on hand-built reports.
// =============================================================================
// scripts/corpus-gate.js is the standing tripwire for both false positives
// (clean repos) and lost recall (vulnerable repos). Its decision function has
// to be right in both directions, so each rule is pinned with a case that
// must fail and a case that must pass.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { signature, classOf, measure, compare } = require('../scripts/corpus-gate');

function report(modules) {
  return { results: Object.entries(modules).map(([module, checks]) => ({ module, checks })) };
}
const err = (name, confidence = 1) => ({ name, passed: false, severity: 'error', confidence });
const warn = (name) => ({ name, passed: false, severity: 'warning', confidence: 1 });

describe('corpus-gate — signatures are stable across line numbers', () => {
  it('strips trailing and interior line numbers', () => {
    assert.strictEqual(signature('security', { name: 'security:sql-injection:src/db.js:11' }), 'security|security:sql-injection:src/db.js');
    assert.strictEqual(signature('security', { name: 'security:sql-injection:src/db.js:12' }), 'security|security:sql-injection:src/db.js');
    assert.strictEqual(signature('quality', { name: 'quality:eval() usage detected:src/x.js:4' }), 'quality|quality:eval() usage detected:src/x.js');
  });
  it('classOf reduces to module:rule', () => {
    assert.strictEqual(classOf('security|security:sql-injection:src/db.js'), 'security:security:sql-injection');
    assert.strictEqual(classOf('documentation|docs:readme'), 'documentation:docs:readme');
  });
});

describe('corpus-gate — measure counts only what blocks', () => {
  it('soft errors are not blocking, suppressed checks are ignored', () => {
    const m = measure(report({
      secrets: [err('secrets:a.js:1'), err('secrets:b.js:2', 0.2), { ...err('secrets:c.js:3'), suppressReason: 'gatetestignore' }, warn('secrets:w:1')],
    }));
    assert.strictEqual(m.blockingCount, 1);
    assert.deepStrictEqual(m.blocking, ['secrets|secrets:a.js']);
    assert.deepStrictEqual(m.warnings, { secrets: 1 });
  });
});

describe('corpus-gate — clean repos', () => {
  const entry = { name: 'x', kind: 'clean' };
  const baseline = { blockingCount: 1, blocking: ['secrets|secrets:tracked-.npmrc'], warnings: { deadCode: 20 } };

  it('passes when blocking matches the baseline and warnings are within budget', () => {
    const m = measure(report({ secrets: [err('secrets:tracked-.npmrc')], deadCode: Array.from({ length: 25 }, (_, i) => warn(`dead-code:unused-export:f${i}.js:1`)) }));
    assert.deepStrictEqual(compare(entry, m, baseline), []);
  });
  it('FAILS on a new blocking finding (a false positive until reviewed)', () => {
    const m = measure(report({ secrets: [err('secrets:tracked-.npmrc')], documentation: [err('docs:readme')] }));
    const f = compare(entry, m, baseline);
    assert.strictEqual(f.length, 1);
    assert.match(f[0], /NEW BLOCKING.*documentation\|docs:readme/);
  });
  it('FAILS on warning volume past baseline * 1.25 + 5', () => {
    const m = measure(report({ deadCode: Array.from({ length: 31 }, (_, i) => warn(`dead-code:unused-export:f${i}.js:1`)) }));
    const f = compare(entry, m, baseline);
    assert.strictEqual(f.length, 1);
    assert.match(f[0], /warning volume regression in deadCode: 31 > ceiling 30/);
  });
  it('does not fail when a baselined blocking finding disappears (precision improved)', () => {
    const m = measure(report({ deadCode: [] }));
    assert.deepStrictEqual(compare(entry, m, baseline), []);
  });
  it('fails loudly with no baseline rather than passing vacuously', () => {
    const f = compare(entry, measure(report({})), null);
    assert.strictEqual(f.length, 1);
    assert.match(f[0], /no baseline/);
  });
});

describe('corpus-gate — vulnerable repos', () => {
  const entry = { name: 'v', kind: 'vulnerable' };
  const baseline = {
    blockingCount: 10,
    blocking: [
      'security|security:sql-injection:a.js', 'security|security:sql-injection:b.js',
      'security|security:eval():c.js', 'authBypass|auth-bypass:idor-shadow:d.js',
    ],
    warnings: {},
  };
  const full = () => report({
    security: [err('security:sql-injection:a.js:1'), err('security:sql-injection:b.js:2'), err('security:eval():c.js:3'), ...Array.from({ length: 6 }, (_, i) => err(`security:xss:e${i}.js:1`))],
    authBypass: [err('auth-bypass:idor-shadow:d.js:5')],
  });

  it('passes when every planted class still fires and the count holds', () => {
    assert.deepStrictEqual(compare(entry, measure(full()), baseline), []);
  });
  it('FAILS when a planted class stops firing, even if the total holds', () => {
    const r = full();
    r.results.find((m) => m.module === 'authBypass').checks = [];
    r.results.find((m) => m.module === 'security').checks.push(err('security:xss:extra.js:9'));
    const f = compare(entry, measure(r), baseline);
    assert.ok(f.some((x) => /RECALL regression: planted class no longer detected: authBypass:auth-bypass:idor-shadow/.test(x)), f.join('\n'));
  });
  it('FAILS when blocking falls below 80% of baseline', () => {
    const r = report({
      security: [err('security:sql-injection:a.js:1'), err('security:eval():c.js:3')],
      authBypass: [err('auth-bypass:idor-shadow:d.js:5')],
    });
    const f = compare(entry, measure(r), baseline);
    assert.ok(f.some((x) => /blocking 3 < floor 8/.test(x)), f.join('\n'));
  });
  it('a moved finding (same class, different file) is not a regression', () => {
    const r = full();
    r.results.find((m) => m.module === 'security').checks[0] = err('security:sql-injection:zz.js:1');
    assert.deepStrictEqual(compare(entry, measure(r), baseline), []);
  });
});
