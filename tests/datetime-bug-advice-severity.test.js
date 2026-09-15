'use strict';

// =============================================================================
// datetimeBug — naive datetime.now() is advice, not a gate
// =============================================================================
// django/django @ main, scanned 2026-09-14: seven `datetime.now()` findings,
// every one at confidence 1.0 and gate-BLOCKING, in the library that ships
// `django/utils/timezone.py`. Whether a naive datetime is a bug depends on what
// it is later compared with or stored as — a line scan cannot see that — so
// the rule is now calibrated like its JS month rules: warning in shipped code,
// info in a test path. Three shapes drop one step further, to info, and the
// message names the reason:
//   - the same line formats the value (`.strftime(`): a filename stamp, a
//     migration name, the runserver banner — never a datetime that leaves the
//     line (four of django's seven);
//   - the file imports an aware-time toolkit: `db/backends/base/schema.py`
//     picks `timezone.now()` for DateTimeField on the line above its naive
//     `datetime.now()` for DateField — a choice, not an oversight (two more);
//   - the project ships its own `timezone.py` (the seventh, `tokens.py:129`).
// Positive control: a bare naive call in a project with none of those is still
// a warning, still on the report.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DatetimeBugModule = require('../src/modules/datetime-bug');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
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
const naive = (r) => r.checks.filter((c) => !c.passed && /^datetime-bug:(?:naive-now|utcnow-deprecated):/.test(c.name));
const one = (r) => { const h = naive(r); assert.strictEqual(h.length, 1, `expected one finding, got ${h.map((c) => c.name)}`); return h[0]; };

describe('datetimeBug — the django lines, verbatim', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-django-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('django/core/management/commands/runserver.py:182 — formatted on the line, info', async () => {
    write(tmp, 'django/core/management/commands/runserver.py', [
      'from datetime import datetime',
      '',
      'def inner_run(self):',
      '    now = datetime.now().strftime("%B %d, %Y - %X")',
      '    self.stdout.write(now)',
      '',
    ].join('\n'));
    const h = one(await run(tmp));
    assert.strictEqual(h.severity, 'info');
    assert.match(h.message, /formatted on the same line/);
    assert.strictEqual(h.line, 4);
  });

  it('django/db/migrations/utils.py:24 — a migration name stamp, info', async () => {
    write(tmp, 'django/db/migrations/utils.py', [
      'import datetime',
      '',
      'def get_migration_name_timestamp():',
      '    return datetime.datetime.now().strftime("%Y%m%d_%H%M")',
      '',
    ].join('\n'));
    assert.strictEqual(one(await run(tmp)).severity, 'info');
  });

  it('django/db/backends/base/schema.py:491 — `timezone.now()` chosen on the line above, info', async () => {
    write(tmp, 'django/db/backends/base/schema.py', [
      'from datetime import datetime',
      'from django.utils import timezone',
      '',
      'def _effective_default(self, field):',
      '    if internal_type == "DateTimeField":',
      '        default = timezone.now()',
      '    else:',
      '        default = datetime.now()',
      '        if internal_type == "DateField":',
      '            default = default.date()',
      '',
    ].join('\n'));
    const h = one(await run(tmp));
    assert.strictEqual(h.severity, 'info');
    assert.match(h.message, /aware-time toolkit/);
    assert.strictEqual(h.line, 8);
  });

  it('django/contrib/auth/tokens.py:129 — the project ships django/utils/timezone.py, info', async () => {
    write(tmp, 'django/utils/timezone.py', 'def now():\n    return None\n');
    write(tmp, 'django/contrib/auth/tokens.py', [
      'from datetime import datetime',
      '',
      'class PasswordResetTokenGenerator:',
      '    def _now(self):',
      '        # Used for mocking in tests',
      '        return datetime.now()',
      '',
    ].join('\n'));
    const h = one(await run(tmp));
    assert.strictEqual(h.severity, 'info');
    assert.match(h.message, /ships its own timezone module \(django\/utils\/timezone\.py\)/);
  });
});

describe('datetimeBug — the calibration and its controls', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dt-grade-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('POSITIVE CONTROL — a bare naive call with no reason in sight is a warning, on the report', async () => {
    write(tmp, 'app/billing.py', 'from datetime import datetime\n\ndef due():\n    return datetime.now()\n');
    const h = one(await run(tmp));
    assert.strictEqual(h.severity, 'warning');
    assert.doesNotMatch(h.message, /Not blocking/);
  });

  it('POSITIVE CONTROL — utcnow() gets the same ladder: warning bare, info when formatted', async () => {
    write(tmp, 'app/a.py', 'from datetime import datetime\nstamp = datetime.utcnow()\nlabel = datetime.utcnow().isoformat()\n');
    const hits = naive(await run(tmp)).sort((a, b) => a.line - b.line);
    assert.deepStrictEqual(hits.map((h) => [h.line, h.severity]), [[2, 'warning'], [3, 'info']]);
  });

  it('`from datetime import datetime, timezone` is an aware toolkit in scope — the naive call beside it is a choice', async () => {
    write(tmp, 'app/a.py', 'from datetime import datetime, timezone\nlocal = datetime.now()\nutc = datetime.now(timezone.utc)\n');
    const h = one(await run(tmp));
    assert.strictEqual(h.severity, 'info');
    assert.strictEqual(h.line, 2);
  });

  for (const imp of ['import pytz', 'from zoneinfo import ZoneInfo', 'from dateutil import tz', 'import pendulum']) {
    it(`\`${imp}\` in the file drops the finding to info`, async () => {
      write(tmp, 'app/a.py', `${imp}\nfrom datetime import datetime\nnow = datetime.now()\n`);
      assert.strictEqual(one(await run(tmp)).severity, 'info');
    });
  }

  it('NEGATIVE CONTROL — `timezone` mentioned only in a comment is not a toolkit import', async () => {
    write(tmp, 'app/a.py', 'from datetime import datetime\n# TODO: use timezone.utc here\nnow = datetime.now()\n');
    assert.strictEqual(one(await run(tmp)).severity, 'warning');
  });

  it('NEGATIVE CONTROL — a `timezones.json` fixture or a `tz/` directory is not a timezone module', async () => {
    write(tmp, 'data/timezones.json', '{}');
    write(tmp, 'tz/handlers.py', 'x = 1\n');
    write(tmp, 'app/a.py', 'from datetime import datetime\nnow = datetime.now()\n');
    assert.strictEqual(one(await run(tmp)).severity, 'warning');
  });

  it('a test path is info regardless', async () => {
    write(tmp, 'tests/test_clock.py', 'from datetime import datetime\nnow = datetime.now()\n');
    assert.strictEqual(one(await run(tmp)).severity, 'info');
  });
});
