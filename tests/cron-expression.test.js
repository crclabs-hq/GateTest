const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CronExpressionModule = require('../src/modules/cron-expression');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new CronExpressionModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('CronExpressionModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'cron:no-files'));
  });

  it('records summary when files are scanned', async () => {
    write(tmp, 'src/a.ts', 'const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'cron:summary'));
  });
});

describe('CronExpressionModule — field count', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-field-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on a cron with too few fields', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 *", run);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('cron:field-count:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('accepts valid 5-field cron', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 * * *", run);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('accepts valid 6-field (with seconds) cron', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 0 * * *", run);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('CronExpressionModule — out-of-range values', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-range-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on minute=60', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("60 0 * * *", run);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('cron:out-of-range:'));
    assert.ok(hit);
  });

  it('errors on hour=25', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 25 * * *", run);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:out-of-range:')));
  });

  it('errors on month=13', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 1 13 *", run);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:out-of-range:')));
  });

  it('errors on day-of-month=0', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 0 1 *", run);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:out-of-range:')));
  });

  it('accepts month name JAN-DEC', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 1 JAN *", run);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('accepts step syntax */5', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("*/5 * * * *", run);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('accepts range 0-30', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0-30 * * * *", run);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('errors on inverted range 30-10', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("30-10 * * * *", run);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:out-of-range:')));
  });
});

describe('CronExpressionModule — impossible dates', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-imp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on Feb 30', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 30 2 *", run);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('cron:impossible-date:'));
    assert.ok(hit);
    assert.match(hit.message, /February 30/);
  });

  it('errors on Apr 31', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 31 4 *", run);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:impossible-date:')));
  });

  it('errors on Feb 31 using month name', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 31 FEB *", run);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:impossible-date:')));
  });

  it('accepts Feb 29 (leap-year-possible)', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("0 0 29 2 *", run);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:impossible-date:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('CronExpressionModule — too-frequent', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-freq-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on every-minute cron', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("* * * * *", run);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('cron:too-frequent:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });
});

describe('CronExpressionModule — aliases', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-alias-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('accepts @daily', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("@daily", run);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('warns on typo @weely', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("@weely", run);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('cron:unknown-alias:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });
});

describe('CronExpressionModule — GitHub Actions YAML', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-gh-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on an invalid cron in .github/workflows/', async () => {
    write(tmp, '.github/workflows/nightly.yml', [
      'name: Nightly',
      'on:',
      '  schedule:',
      "    - cron: '0 25 * * *'",
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:out-of-range:')));
  });

  it('accepts a valid cron in .github/workflows/', async () => {
    write(tmp, '.github/workflows/nightly.yml', [
      'name: Nightly',
      'on:',
      '  schedule:',
      "    - cron: '0 3 * * *'",
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('CronExpressionModule — Kubernetes CronJob', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-k8s-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on an invalid k8s CronJob schedule', async () => {
    write(tmp, 'k8s/backup.yaml', [
      'apiVersion: batch/v1',
      'kind: CronJob',
      'metadata:',
      '  name: backup',
      'spec:',
      "  schedule: '0 0 31 2 *'",
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:impossible-date:')));
  });
});

describe('CronExpressionModule — vercel.json', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-vcl-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('validates vercel.json cron schedules', async () => {
    write(tmp, 'vercel.json', JSON.stringify({
      crons: [{ path: '/api/warm', schedule: '*/5 * * * *' }],
    }, null, 2));
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('catches invalid vercel.json cron', async () => {
    write(tmp, 'vercel.json', JSON.stringify({
      crons: [{ path: '/api/warm', schedule: '0 0 31 2 *' }],
    }, null, 2));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:impossible-date:')));
  });
});

describe('CronExpressionModule — suppressions', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-sup-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('honours `// cron-ok` on the same line', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("* * * * *", run); // cron-ok — load test only\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('cron:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('CronExpressionModule — Python', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-py-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('validates CronTrigger.from_crontab', async () => {
    write(tmp, 'src/a.py', 'trigger = CronTrigger.from_crontab("0 25 * * *")\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:out-of-range:')));
  });
});

describe('CronExpressionModule — self-scan fixture false positives', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-self-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a test-fixture cron call nested in a string arg', async () => {
    write(
      tmp,
      'tests/cron-expression.test.js',
      "write(tmp, 'src/a.ts', 'cron.schedule(\"60 0 * * *\", run);\\n');\n",
    );
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(hits.length, 0);
  });

  it('still flags the same expression when it is real (unquoted) source', async () => {
    write(tmp, 'src/a.ts', 'cron.schedule("60 0 * * *", run);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('cron:out-of-range:')));
  });
});
