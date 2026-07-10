'use strict';

// =============================================================================
// .gatetestignore — user-facing finding suppression (WS2, Craig 2026-07-11).
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/core/ignore-file');

describe('ignore-file — module:rule matching', () => {
  it('module:rule suppresses exactly that rule in that module', () => {
    const m = parse('secrets:apiKey');
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'a.js' }), true);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:token', file: 'a.js' }), false);
    assert.equal(m.matches({ module: 'lint', ruleKey: 'lint:apiKey', file: 'a.js' }), false);
  });

  it('bare module name suppresses the whole module', () => {
    const m = parse('deadCode');
    assert.equal(m.matches({ module: 'deadCode', ruleKey: 'deadCode:unused', file: 'a.js' }), true);
    assert.equal(m.matches({ module: 'deadCode', ruleKey: 'deadCode:whatever', file: 'b.ts' }), true);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:x', file: 'a.js' }), false);
  });

  it('module:* is equivalent to the whole module', () => {
    const m = parse('perf:*');
    assert.equal(m.matches({ module: 'perf', ruleKey: 'perf:slow', file: 'a.js' }), true);
  });

  it('*:rule suppresses a rule across every module', () => {
    const m = parse('*:todoComment');
    assert.equal(m.matches({ module: 'lint', ruleKey: 'lint:todoComment', file: 'a.js' }), true);
    assert.equal(m.matches({ module: 'docs', ruleKey: 'docs:todoComment', file: 'b.md' }), true);
    assert.equal(m.matches({ module: 'lint', ruleKey: 'lint:other', file: 'a.js' }), false);
  });

  it('is case-insensitive on module and rule', () => {
    const m = parse('Secrets:ApiKey');
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apikey', file: 'a.js' }), true);
  });
});

describe('ignore-file — @glob file scope', () => {
  it('module:rule@glob only suppresses under the glob', () => {
    const m = parse('secrets:apiKey@test/**');
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'test/a.js' }), true);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'test/deep/b.js' }), true);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'src/a.js' }), false);
  });

  it('bare path glob suppresses any finding under it', () => {
    const m = parse('vendor/**');
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:x', file: 'vendor/lib.js' }), true);
    assert.equal(m.matches({ module: 'lint', ruleKey: 'lint:y', file: 'vendor/deep/z.js' }), true);
    assert.equal(m.matches({ module: 'lint', ruleKey: 'lint:y', file: 'src/z.js' }), false);
  });

  it('single-star glob does not cross directory boundaries', () => {
    const m = parse('src/*.js');
    assert.equal(m.matches({ module: 'x', file: 'src/a.js' }), true);
    assert.equal(m.matches({ module: 'x', file: 'src/deep/a.js' }), false);
  });
});

describe('ignore-file — parsing hygiene', () => {
  it('ignores comments and blank lines', () => {
    const m = parse('# a comment\n\n   \nsecrets:apiKey\n# another');
    assert.equal(m.rules.length, 1);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'a.js' }), true);
  });

  it('empty file matches nothing', () => {
    const m = parse('');
    assert.equal(m.isEmpty, true);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'a.js' }), false);
  });

  it('matches on the name field when ruleKey has no colon', () => {
    const m = parse('secrets:apiKey');
    assert.equal(m.matches({ module: 'secrets', name: 'apiKey', file: 'a.js' }), true);
  });
});
