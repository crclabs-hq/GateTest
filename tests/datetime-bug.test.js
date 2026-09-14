const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DatetimeBugModule = require('../src/modules/datetime-bug');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new DatetimeBugModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('DatetimeBugModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'datetime-bug:no-files'));
  });

  it('records summary when files are scanned', async () => {
    write(tmp, 'src/a.ts', 'const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'datetime-bug:summary'));
  });
});

describe('DatetimeBugModule — Python naive datetime.now()', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-pynow-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on bare datetime.now() — advice, not a gate (was error until 2026-09-14)', async () => {
    write(tmp, 'src/a.py', 'from datetime import datetime\nnow = datetime.now()\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:naive-now:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('errors on datetime.datetime.now()', async () => {
    write(tmp, 'src/a.py', 'import datetime\nnow = datetime.datetime.now()\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:naive-now:')));
  });

  it('accepts datetime.now(timezone.utc)', async () => {
    write(tmp, 'src/a.py', 'from datetime import datetime, timezone\nnow = datetime.now(timezone.utc)\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('accepts datetime.now(tz=ZoneInfo("UTC"))', async () => {
    write(tmp, 'src/a.py', 'from datetime import datetime\nfrom zoneinfo import ZoneInfo\nnow = datetime.now(tz=ZoneInfo("UTC"))\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('downgrades warning -> info in test/ paths', async () => {
    write(tmp, 'tests/test_a.py', 'from datetime import datetime\nnow = datetime.now()\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:naive-now:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });
});

describe('DatetimeBugModule — Python datetime.utcnow() deprecated', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-utcnow-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on datetime.utcnow() — advice, not a gate (was error until 2026-09-14)', async () => {
    write(tmp, 'src/a.py', 'from datetime import datetime\nnow = datetime.utcnow()\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:utcnow-deprecated:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('errors on datetime.datetime.utcnow()', async () => {
    write(tmp, 'src/a.py', 'import datetime\nnow = datetime.datetime.utcnow()\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:utcnow-deprecated:')));
  });
});

describe('DatetimeBugModule — JS new Date(y, m, d) one-based month', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-jsone-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on new Date(2026, 2, 14) — Feb or Mar?', async () => {
    write(tmp, 'src/a.js', 'const d = new Date(2026, 2, 14);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:one-based-month:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on new Date(2026, 12, 25)', async () => {
    write(tmp, 'src/a.js', 'const d = new Date(2026, 12, 25);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:one-based-month:')));
  });

  it('does not flag new Date(2026, 0, 14) — month 0 is correct Jan', async () => {
    write(tmp, 'src/a.js', 'const d = new Date(2026, 0, 14);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('flags new Date(2026, 11, 25) — month 11 is ambiguous (Nov 1-idx or Dec 0-idx)', async () => {
    // Per docblock: any 1..12 literal is ambiguous and deserves a flag.
    write(tmp, 'src/a.js', 'const d = new Date(2026, 11, 25);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:one-based-month:')));
  });
});

describe('DatetimeBugModule — JS Date.UTC(y, m, d) one-based month', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-jsutc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on Date.UTC(2026, 2, 14)', async () => {
    write(tmp, 'src/a.js', 'const t = Date.UTC(2026, 2, 14);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:utc-one-based-month:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does not flag Date.UTC(2026, 0, 14) — month 0 is correct Jan', async () => {
    write(tmp, 'src/a.js', 'const t = Date.UTC(2026, 0, 14);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('DatetimeBugModule — moment() without .tz', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-moment-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on moment()', async () => {
    write(tmp, 'src/a.js', 'const m = moment();\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('datetime-bug:moment-no-tz:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('accepts moment().tz("UTC")', async () => {
    write(tmp, 'src/a.js', 'const m = moment().tz("UTC");\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('accepts moment.tz(...)', async () => {
    write(tmp, 'src/a.js', 'const m = moment.tz("2026-04-14", "UTC");\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('does not flag import/require lines', async () => {
    write(tmp, 'src/a.js', 'const moment = require("moment");\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('DatetimeBugModule — suppressions', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-sup-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('honours // datetime-ok on the same line (JS)', async () => {
    write(tmp, 'src/a.js', 'const d = new Date(2026, 2, 14); // datetime-ok — legacy epoch\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('honours # datetime-ok on the same line (Python)', async () => {
    write(tmp, 'src/a.py', 'now = datetime.now()  # datetime-ok — utc enforced elsewhere\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('honours # datetime-ok on the preceding line (Python)', async () => {
    write(tmp, 'src/a.py', '# datetime-ok\nnow = datetime.now()\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('DatetimeBugModule — comment stripping', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-cmt-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('ignores matches inside JS line comments', async () => {
    write(tmp, 'src/a.js', '// example: new Date(2026, 2, 14)\nconst x = 1;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('ignores matches inside JS block comments', async () => {
    write(tmp, 'src/a.js', '/* new Date(2026, 2, 14) */\nconst x = 1;\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('ignores matches inside Python triple-quoted docstrings', async () => {
    write(tmp, 'src/a.py', '"""\nExample: datetime.now()\n"""\nx = 1\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('ignores matches inside Python # line comments', async () => {
    write(tmp, 'src/a.py', '# example: datetime.utcnow()\nx = 1\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('datetime-bug:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Measured on django/django @b3f4d83 (2026-09-05): 11 `naive-now` blocking
// findings, 4 of them `datetime.now(tz)` — a positional tz argument, which
// makes the result AWARE. The rule looked for keyword spellings only.
// ─────────────────────────────────────────────────────────────────────────────
describe('datetime-bug — naive-now judges the argument, not the spelling', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const DatetimeBug = require('../src/modules/datetime-bug');
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  async function naive(src) {
    fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'app', 'm.py'), src);
    const checks = [];
    await new DatetimeBug().run({ checks, addCheck: (n, p, d = {}) => checks.push({ name: n, passed: p, ...d }), addInfo() {} }, { projectRoot: tmp });
    return checks.filter((c) => !c.passed && c.name.startsWith('datetime-bug:naive-now')).length;
  }
  it('a positional tz is aware', async () => {
    // django/core/mail/message.py:358 · humanize.py:197 · timesince.py:68
    assert.strictEqual(await naive('msg["Date"] = datetime.now(tz)\n'), 0);
    assert.strictEqual(await naive('today = datetime.now(tzinfo).date()\n'), 0);
    assert.strictEqual(await naive('now = datetime.now(UTC if is_aware(value) else None)\n'), 0);
  });
  it('keyword tz is still aware', async () => {
    assert.strictEqual(await naive('now = datetime.now(tz=timezone.utc)\n'), 0);
  });
  it('an empty call is naive and still fires', async () => {
    // django/contrib/auth/tokens.py:129 — reported, and Django means it.
    assert.strictEqual(await naive('return datetime.now()\n'), 1);
    assert.strictEqual(await naive('timestamp = datetime.datetime.now().strftime("%Y")\n'), 1);
  });
  it('an explicit None is naive and still fires', async () => {
    assert.strictEqual(await naive('now = datetime.now(None)\n'), 1);
  });
});
