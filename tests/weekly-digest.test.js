'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTrendFromHistory,
  sendRepoDigest,
  runWeeklyDigests,
} = require('../website/app/lib/weekly-digest');

// ── buildTrendFromHistory ─────────────────────────────────────────────────────

const NOW = new Date();
function hoursAgo(h) {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

describe('buildTrendFromHistory', () => {
  test('returns insufficient-data for empty rows', () => {
    const t = buildTrendFromHistory([]);
    assert.equal(t.trend, 'insufficient-data');
    assert.equal(t.netDelta, 0);
    assert.equal(t.scansInWindow, 0);
  });

  test('returns insufficient-data for null rows', () => {
    const t = buildTrendFromHistory(null);
    assert.equal(t.trend, 'insufficient-data');
  });

  test('returns insufficient-data when all rows are older than windowDays', () => {
    const oldRow = {
      scanned_at: new Date('2020-01-01').toISOString(),
      total_issues: 10,
      total_modules: 5,
      module_summary: [],
    };
    const t = buildTrendFromHistory([oldRow]);
    assert.equal(t.trend, 'insufficient-data');
  });

  test('reports stable trend when delta is small', () => {
    const rows = [
      { scanned_at: hoursAgo(1),  total_issues: 10, total_modules: 5, module_summary: [] },
      { scanned_at: hoursAgo(24), total_issues: 8,  total_modules: 5, module_summary: [] },
    ];
    const t = buildTrendFromHistory(rows);
    assert.equal(t.trend, 'stable');    // delta = 2, below threshold of 3
    assert.equal(t.netDelta, 2);
    assert.equal(t.scansInWindow, 2);
  });

  test('reports improving trend when issues decreased by more than 3', () => {
    const rows = [
      { scanned_at: hoursAgo(1),  total_issues: 5,  total_modules: 5, module_summary: [] },
      { scanned_at: hoursAgo(48), total_issues: 20, total_modules: 5, module_summary: [] },
    ];
    const t = buildTrendFromHistory(rows);
    assert.equal(t.trend, 'improving');
    assert.equal(t.netDelta, -15);
  });

  test('reports declining trend when issues increased by more than 3', () => {
    const rows = [
      { scanned_at: hoursAgo(1),  total_issues: 25, total_modules: 5, module_summary: [] },
      { scanned_at: hoursAgo(48), total_issues: 5,  total_modules: 5, module_summary: [] },
    ];
    const t = buildTrendFromHistory(rows);
    assert.equal(t.trend, 'declining');
    assert.equal(t.netDelta, 20);
  });

  test('identifies top module from latest scan', () => {
    const rows = [
      {
        scanned_at: hoursAgo(1),
        total_issues: 10,
        total_modules: 3,
        module_summary: [
          { name: 'lint',         issues: 5, status: 'failed' },
          { name: 'errorSwallow', issues: 8, status: 'failed' },
          { name: 'syntax',       issues: 0, status: 'passed' },
        ],
      },
    ];
    const t = buildTrendFromHistory(rows);
    assert.equal(t.topModule, 'errorSwallow');
  });

  test('handles scan with no module_summary gracefully', () => {
    const rows = [
      { scanned_at: hoursAgo(1), total_issues: 5, total_modules: 3, module_summary: null },
    ];
    const t = buildTrendFromHistory(rows);
    assert.ok(t.trend);
    assert.equal(t.topModule, null);
  });

  test('computes lastGrade for zero-issue scan as A', () => {
    const rows = [
      { scanned_at: hoursAgo(1), total_issues: 0, total_modules: 5, module_summary: [] },
    ];
    const t = buildTrendFromHistory(rows);
    assert.equal(t.lastGrade, 'A');
    assert.equal(t.lastScore, 100);
  });

  test('computes lastGrade below A for high issue count', () => {
    // penalty = min(50, issues*2) so 100 issues → score 50 → grade D
    const rows = [
      { scanned_at: hoursAgo(1), total_issues: 100, total_modules: 5, module_summary: [] },
    ];
    const t = buildTrendFromHistory(rows);
    assert.ok(['D', 'F'].includes(t.lastGrade), `expected D or F, got ${t.lastGrade}`);
    assert.ok(t.lastScore <= 50);
  });

  test('respects custom windowDays parameter', () => {
    // 3 rows: 2 days ago, 5 days ago, 10 days ago
    const rows = [
      { scanned_at: hoursAgo(48),  total_issues: 10, total_modules: 5, module_summary: [] },
      { scanned_at: hoursAgo(120), total_issues: 8,  total_modules: 5, module_summary: [] },
      { scanned_at: hoursAgo(240), total_issues: 5,  total_modules: 5, module_summary: [] },
    ];
    // With 3-day window only the first row is recent
    const t3 = buildTrendFromHistory(rows, 3);
    assert.equal(t3.scansInWindow, 1);

    // With 7-day window two rows are recent
    const t7 = buildTrendFromHistory(rows, 7);
    assert.equal(t7.scansInWindow, 2);

    // With 14-day window all three are recent
    const t14 = buildTrendFromHistory(rows, 14);
    assert.equal(t14.scansInWindow, 3);
  });
});

// ── sendRepoDigest ────────────────────────────────────────────────────────────

describe('sendRepoDigest', () => {
  test('throws when repoUrl missing', async () => {
    const sql = async () => [];
    await assert.rejects(
      () => sendRepoDigest({ sql }),
      { message: /repoUrl is required/ }
    );
  });

  test('throws when sql missing', async () => {
    await assert.rejects(
      () => sendRepoDigest({ repoUrl: 'https://github.com/a/b' }),
      { message: /sql is required/ }
    );
  });

  test('returns not-configured for both channels when no webhook/email', async () => {
    // Stub sql that returns empty scan history
    const sql = Object.assign(async () => [], {
      [Symbol.asyncIterator]: undefined,
    });
    // getRepoHistory calls sql as a tagged template; make it return []
    const fakeSql = new Proxy(async () => [], {
      apply: () => Promise.resolve([]),
      get: (target, prop) => prop === 'then' ? undefined : target[prop],
    });

    // Capture original SLACK_WEBHOOK_URL
    const origSlack = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;

    try {
      const result = await sendRepoDigest({
        repoUrl: 'https://github.com/acme/repo',
        customerEmail: null,
        slackWebhookUrl: null,
        sql: fakeSql,
      });
      assert.equal(result.slack.ok, false);
      assert.equal(result.email.ok, false);
      // trend should still be present
      assert.ok('trend' in result);
    } finally {
      if (origSlack !== undefined) process.env.SLACK_WEBHOOK_URL = origSlack;
      else delete process.env.SLACK_WEBHOOK_URL;
    }
  });

  test('returns trend data even when DB is unavailable', async () => {
    const failSql = new Proxy(async () => { throw new Error('DB down'); }, {
      apply: () => Promise.reject(new Error('DB down')),
      get: (target, prop) => prop === 'then' ? undefined : target[prop],
    });

    const origSlack = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      const result = await sendRepoDigest({
        repoUrl: 'https://github.com/acme/repo',
        sql: failSql,
      });
      // Should not throw, should return graceful result
      assert.ok('trend' in result);
      assert.equal(result.trend.trend, 'insufficient-data');
    } finally {
      if (origSlack !== undefined) process.env.SLACK_WEBHOOK_URL = origSlack;
      else delete process.env.SLACK_WEBHOOK_URL;
    }
  });
});

// ── runWeeklyDigests ──────────────────────────────────────────────────────────

describe('runWeeklyDigests', () => {
  test('throws when sql is not a function', async () => {
    await assert.rejects(
      () => runWeeklyDigests(null),
      { message: /sql is required/ }
    );
  });

  test('returns zeroed counts when no active subscriptions', async () => {
    const origSlack = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;

    // Fake sql that returns empty subscription list
    const fakeSql = new Proxy(async () => [], {
      apply: () => Promise.resolve([]),
      get: (target, prop) => prop === 'then' ? undefined : target[prop],
    });

    try {
      const summary = await runWeeklyDigests(fakeSql);
      assert.equal(summary.sent, 0);
      assert.equal(summary.failed, 0);
      assert.ok(Array.isArray(summary.results));
    } finally {
      if (origSlack !== undefined) process.env.SLACK_WEBHOOK_URL = origSlack;
      else delete process.env.SLACK_WEBHOOK_URL;
    }
  });

  test('skips subscriptions with no delivery channel when no global webhook', async () => {
    const origSlack = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;

    const fakeSql = new Proxy(async () => [
      { repo_url: 'github.com/a/b', customer_email: null, slack_webhook_url: null },
    ], {
      apply: () => Promise.resolve([
        { repo_url: 'github.com/a/b', customer_email: null, slack_webhook_url: null },
      ]),
      get: (target, prop) => prop === 'then' ? undefined : target[prop],
    });

    try {
      const summary = await runWeeklyDigests(fakeSql);
      assert.equal(summary.skipped, 1);
      assert.equal(summary.sent, 0);
    } finally {
      if (origSlack !== undefined) process.env.SLACK_WEBHOOK_URL = origSlack;
      else delete process.env.SLACK_WEBHOOK_URL;
    }
  });
});
