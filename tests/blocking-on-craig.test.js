'use strict';
/**
 * scripts/ops/blocking-on-craig.js — the Craig-only queue cannot render an
 * invalid list, and the rendered list cannot omit an item or lie about its
 * age. Control pairs: the committed seed passes; a duplicate id, a bad date,
 * a missing step, a bad priority, an unknown key and a dangling dependency
 * each FAIL with a message naming the item. Age is computed, not typed. The
 * markdown carries every open title and the same oldest-days figure the
 * summary line (and the issue title) carry.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ops', 'blocking-on-craig.js');
const boc = require(SCRIPT);

const TODAY = '2026-09-16';

/** A small valid fixture; each control mutates a deep copy of it. */
function fixture() {
  return {
    updated: '2026-09-16',
    items: [
      {
        id: 'alpha-one', title: 'Alpha title', since: '2026-09-13',
        unblocks: 'alpha unblocks', step: 'click alpha', where: 'https://example.test/alpha',
        priority: 1, done: false,
      },
      {
        id: 'beta-two', title: 'Beta title', since: '2026-05-14',
        unblocks: 'beta unblocks', step: 'click beta', where: 'https://example.test/beta',
        priority: 2, done: false, after: ['alpha-one'],
      },
      {
        id: 'gamma-done', title: 'Gamma finished', since: '2026-09-01',
        unblocks: 'nothing now', step: 'already clicked', where: 'n/a',
        priority: 3, done: true,
      },
    ],
  };
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: cwd || path.join(__dirname, '..'), encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('blocking-on-craig — validation control pairs', () => {
  it('NEGATIVE: the committed seed validates and has items', () => {
    const data = boc.load(boc.DEFAULT_FILE);
    assert.deepEqual(boc.validate(data), []);
    assert.ok(data.items.length >= 10, `seed has ${data.items.length} items`);
    assert.ok(boc.isIsoDate(data.updated));
  });

  it('NEGATIVE: the fixture validates', () => {
    assert.deepEqual(boc.validate(fixture()), []);
  });

  it('POSITIVE: a duplicate id fails and names the id', () => {
    const d = fixture();
    d.items[1].id = 'alpha-one';
    const errors = boc.validate(d);
    assert.ok(errors.some((e) => /duplicate id "alpha-one"/.test(e)), errors.join('\n'));
  });

  it('POSITIVE: a bad date fails — impossible day, wrong format, non-string', () => {
    for (const bad of ['2026-13-40', '2026-02-30', '16/09/2026', '2026-9-3', 20260913]) {
      const d = fixture();
      d.items[0].since = bad;
      const errors = boc.validate(d);
      assert.ok(errors.some((e) => /item "alpha-one": "since"/.test(e)), `${JSON.stringify(bad)}: ${errors.join('\n')}`);
    }
    const top = fixture();
    top.updated = 'yesterday';
    assert.ok(boc.validate(top).some((e) => /"updated" must be an ISO date/.test(e)));
  });

  it('POSITIVE: a missing or empty step fails', () => {
    const missing = fixture();
    delete missing.items[0].step;
    assert.ok(boc.validate(missing).some((e) => /item "alpha-one" is missing "step"/.test(e)));
    const empty = fixture();
    empty.items[0].step = '   ';
    assert.ok(boc.validate(empty).some((e) => /item "alpha-one": "step" must not be empty/.test(e)));
  });

  it('POSITIVE: priority outside 1..3 or non-integer fails', () => {
    for (const bad of [0, 4, 1.5, '1']) {
      const d = fixture();
      d.items[0].priority = bad;
      assert.ok(boc.validate(d).some((e) => /item "alpha-one": "priority"/.test(e)), `priority ${JSON.stringify(bad)}`);
    }
  });

  it('POSITIVE: a non-kebab id, an unknown key, and a non-boolean done fail', () => {
    const id = fixture();
    id.items[0].id = 'Alpha_One';
    assert.ok(boc.validate(id).some((e) => /kebab-case/.test(e)));
    const key = fixture();
    key.items[0].steps = 'typo for step';
    assert.ok(boc.validate(key).some((e) => /unknown key "steps"/.test(e)));
    const done = fixture();
    done.items[0].done = 'false';
    assert.ok(boc.validate(done).some((e) => /"done" must be a boolean/.test(e)));
  });

  it('POSITIVE: "after" naming an unknown id or itself fails; since after updated fails', () => {
    const dangling = fixture();
    dangling.items[1].after = ['nope'];
    assert.ok(boc.validate(dangling).some((e) => /"after" names unknown id "nope"/.test(e)));
    const self = fixture();
    self.items[0].after = ['alpha-one'];
    assert.ok(boc.validate(self).some((e) => /must not name itself/.test(e)));
    const future = fixture();
    future.items[0].since = '2026-09-17';
    assert.ok(boc.validate(future).some((e) => /is after "updated"/.test(e)));
  });

  it('POSITIVE: the wrong top-level shape fails without throwing', () => {
    assert.ok(boc.validate(null).length > 0);
    assert.ok(boc.validate([]).length > 0);
    assert.ok(boc.validate({ updated: '2026-09-16', items: 'no' }).some((e) => /"items" must be an array/.test(e)));
    assert.ok(boc.validate({ updated: '2026-09-16', items: [42] }).some((e) => /item #0 must be an object/.test(e)));
  });
});

describe('blocking-on-craig — age is computed from since, never typed', () => {
  it('counts whole days, clamps the future to 0, and crosses a leap day', () => {
    assert.equal(boc.ageDays('2026-09-13', '2026-09-16'), 3);
    assert.equal(boc.ageDays('2026-09-16', '2026-09-16'), 0);
    assert.equal(boc.ageDays('2026-09-20', '2026-09-16'), 0);
    assert.equal(boc.ageDays('2026-05-14', '2026-09-16'), 125);
    assert.equal(boc.ageDays('2028-02-28', '2028-03-01'), 2);
    assert.throws(() => boc.ageDays('not-a-date', TODAY), TypeError);
  });

  it('the summary excludes done items and finds the oldest open one', () => {
    const s = boc.summarize(fixture(), TODAY);
    assert.equal(s.count, 2);
    assert.equal(s.oldestId, 'beta-two');
    assert.equal(s.oldestDays, 125);
    assert.equal(s.line, '2 items blocking, oldest 125 days');
    assert.equal(s.issueTitle, 'Blocking on Craig — 2 items, oldest 125 days');
  });

  it('singulars and the empty queue read correctly', () => {
    assert.equal(boc.summaryLine({ count: 1, oldestDays: 1 }), '1 item blocking, oldest 1 day');
    const empty = fixture();
    for (const item of empty.items) item.done = true;
    const s = boc.summarize(empty, TODAY);
    assert.equal(s.count, 0);
    assert.equal(s.line, '0 items blocking');
    assert.equal(s.issueTitle, 'Blocking on Craig — 0 items');
  });
});

describe('blocking-on-craig — markdown carries every title and the oldest-days figure', () => {
  it('renders the seed with every open title, the summary line and the oldest age', () => {
    const data = boc.load(boc.DEFAULT_FILE);
    const md = boc.render(data, TODAY);
    const s = boc.summarize(data, TODAY);
    for (const item of data.items.filter((i) => !i.done)) {
      assert.ok(md.includes(`### ${item.title}`), `title missing: ${item.title}`);
      assert.ok(md.includes(`\`${item.id}\``), `id missing: ${item.id}`);
      assert.ok(md.includes(item.step), `step missing: ${item.id}`);
    }
    assert.ok(md.includes(`**${s.line}**`), `summary line missing: ${s.line}`);
    assert.ok(md.includes(`oldest ${s.oldestDays} days`));
    assert.ok(md.includes(`waiting **${s.oldestDays} days** (since ${s.oldestSince})`));
    assert.ok(md.indexOf('## P1') < md.indexOf('## P2'), 'P1 renders before P2');
    assert.ok(md.includes(`(updated ${data.updated})`), `updated stamp missing: ${data.updated}`);
  });

  it('done items render struck through, oldest-first within a priority, and dependencies show', () => {
    const md = boc.render(fixture(), TODAY);
    assert.ok(md.includes('- ~~Gamma finished~~ (`gamma-done`)'));
    assert.ok(!md.includes('### Gamma finished'));
    assert.ok(md.includes('- **After:** `alpha-one`'));
    assert.ok(md.includes('waiting **3 days** (since 2026-09-13)'));
    assert.ok(md.includes('waiting **125 days** (since 2026-05-14)'));
  });

  it('an empty queue renders the zero line and no priority sections', () => {
    const empty = fixture();
    for (const item of empty.items) item.done = true;
    const md = boc.render(empty, TODAY);
    assert.ok(md.includes('**0 items blocking.**'));
    assert.ok(!md.includes('## P1'));
    assert.ok(md.includes('## Done (3)'));
  });
});

describe('blocking-on-craig — CLI exit codes', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-boc-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('--check passes the seed and reports the summary on stderr', () => {
    const r = run(['--check', '--today', TODAY]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /OK — \d+ items in .*blocking-on-craig\.json; \d+ items blocking, oldest \d+ days/);
  });

  it('--check exits 1 on an invalid file and names the problem', () => {
    const bad = fixture();
    bad.items[1].id = 'alpha-one';
    delete bad.items[1].after; // keep this an exact two-error control (the rename would also make `after` self-referential)
    delete bad.items[0].step;
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify(bad));
    const r = run(['--check', '--file', file]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /INVALID \(2 errors\)/);
    assert.match(r.stderr, /duplicate id "alpha-one"/);
    assert.match(r.stderr, /is missing "step"/);
  });

  it('--json and --markdown validate first, then agree with the library', () => {
    const file = path.join(dir, 'good.json');
    fs.writeFileSync(file, JSON.stringify(fixture()));
    const j = run(['--json', '--file', file, '--today', TODAY]);
    assert.equal(j.code, 0, j.stderr);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.summary.count, 2);
    assert.equal(parsed.summary.oldestDays, 125);
    assert.equal(parsed.summary.issueTitle, 'Blocking on Craig — 2 items, oldest 125 days');
    assert.equal(parsed.items.find((i) => i.id === 'alpha-one').ageDays, 3);
    const m = run(['--markdown', '--file', file, '--today', TODAY]);
    assert.equal(m.code, 0, m.stderr);
    assert.equal(m.stdout, boc.render(fixture(), TODAY));
    const invalid = run(['--json', '--file', file, '--today', 'soon']);
    assert.equal(invalid.code, 2);
    const missing = run(['--json', '--file', path.join(dir, 'nope.json')]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /cannot read/);
  });
});
