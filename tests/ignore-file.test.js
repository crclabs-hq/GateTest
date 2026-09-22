'use strict';

// =============================================================================
// .gatetestignore — user-facing finding suppression (WS2, Craig 2026-07-11).
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, load } = require('../src/core/ignore-file');

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

describe('ignore-file — module-name spelling normalization (2026-07-12 fix)', () => {
  // Findings carry the camelCase registry module name (`hardcodedUrl`) while
  // check names render kebab-case (`hardcoded-url:localhost:file:line`).
  // Users copy whichever spelling they saw — both must match.
  it('kebab-case entry matches camelCase module name', () => {
    const m = parse('hardcoded-url:localhost');
    assert.equal(
      m.matches({
        module: 'hardcodedUrl',
        name: 'hardcoded-url:localhost:src/a.ts:12',
        file: 'src/a.ts',
      }),
      true,
    );
  });

  it('camelCase entry matches too', () => {
    const m = parse('hardcodedUrl:localhost');
    assert.equal(
      m.matches({
        module: 'hardcodedUrl',
        name: 'hardcoded-url:localhost:src/a.ts:12',
        file: 'src/a.ts',
      }),
      true,
    );
  });

  it('rule matches the segment after the module prefix even with trailing file:line segments', () => {
    const m = parse('money-float:js-parse-float');
    assert.equal(
      m.matches({
        module: 'moneyFloat',
        name: 'money-float:js-parse-float:scripts/x.js:61',
        file: 'scripts/x.js',
      }),
      true,
    );
  });

  it('glob + camelCase module + backslash Windows path all together', () => {
    const m = parse('hardcoded-url:localhost@website/app/components/HomeEyesEarsHands.tsx');
    assert.equal(
      m.matches({
        module: 'hardcodedUrl',
        name: 'hardcoded-url:localhost:website\\app\\components\\HomeEyesEarsHands.tsx:28',
        file: 'website\\app\\components\\HomeEyesEarsHands.tsx',
      }),
      true,
    );
  });

  it('different module still does not match', () => {
    const m = parse('hardcoded-url:localhost');
    assert.equal(
      m.matches({
        module: 'secrets',
        name: 'secrets:localhost:src/a.ts:1',
        file: 'src/a.ts',
      }),
      false,
    );
  });
});

// suggestLine (move 25): the line offered beside a finding must be one the
// matcher honours — most specific first, never broader than needed.
describe('ignore-file — suggestLine round-trips through the matcher', () => {
  const { suggestLine } = require('../src/core/ignore-file');
  const { ruleKeyOf } = require('../src/core/finding-registry');
  const mk = (module, name, file) => ({ module, name, file, ruleKey: ruleKeyOf(name, file) });

  const cases = [
    [mk('hardcodedUrl', 'hardcoded-url:localhost:src/x.ts:12', 'src/x.ts'), 'hardcodedUrl:localhost@src/x.ts'],
    [mk('prSize', 'pr-size:too-large'), 'prSize:too-large'],
    // a path-shaped rule segment is not a rule: scope by file, not by "rule"
    [mk('secrets', 'secrets:src/config.js', 'src/config.js'), 'secrets@src/config.js'],
    [mk('security', 'security:secret:src/a.js:3', 'src/a.js'), 'security:secret@src/a.js'],
    [mk('crossFileTaint', 'cross-file-taint:sink:sql-query:src/db.js:12', 'src/db.js'), 'crossFileTaint:sink@src/db.js'],
  ];
  for (const [finding, expected] of cases) {
    it(`${finding.name} → ${expected}`, () => {
      const line = suggestLine(finding);
      assert.strictEqual(line, expected);
      assert.strictEqual(parse(line).matches(finding), true, 'the suggested line must silence the finding');
    });
  }

  it('the suggested line does not silence a sibling rule or another file', () => {
    const f = mk('hardcodedUrl', 'hardcoded-url:localhost:src/x.ts:12', 'src/x.ts');
    const m = parse(suggestLine(f));
    assert.strictEqual(m.matches(mk('hardcodedUrl', 'hardcoded-url:production-ip:src/x.ts:4', 'src/x.ts')), false);
    assert.strictEqual(m.matches(mk('hardcodedUrl', 'hardcoded-url:localhost:src/y.ts:1', 'src/y.ts')), false);
  });

  it('returns null without a module', () => {
    assert.strictEqual(suggestLine({ name: 'x' }), null);
  });
});

// KI #112 G4 (issue #633): `.gatetest.json`'s `ignore` array is not a second
// matcher — it feeds the SAME parser as `.gatetestignore`, via load()'s
// second argument.
describe('ignore-file — load() merges .gatetest.json\'s `ignore` array (KI #112 G4)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ignore-load-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('extraLines alone suppress, with no .gatetestignore file present at all', () => {
    const m = load(tmp, ['secrets:apiKey']);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'a.js' }), true);
  });

  it('.gatetestignore and config extraLines combine — either suppresses', () => {
    fs.writeFileSync(path.join(tmp, '.gatetestignore'), 'lint:todoComment\n');
    const m = load(tmp, ['secrets:apiKey']);
    assert.equal(m.matches({ module: 'lint', ruleKey: 'lint:todoComment', file: 'a.js' }), true, 'file rule still works');
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'a.js' }), true, 'config rule also works');
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:other', file: 'a.js' }), false);
  });

  it('no file, no extraLines → empty matcher, nothing suppressed', () => {
    const m = load(tmp, []);
    assert.equal(m.isEmpty, true);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'a.js' }), false);
  });

  it('non-array / undefined extraLines is tolerated (defensive callers)', () => {
    fs.writeFileSync(path.join(tmp, '.gatetestignore'), 'secrets:apiKey\n');
    const m = load(tmp, undefined);
    assert.equal(m.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'a.js' }), true);
  });
});
