'use strict';
/**
 * Tests for website/app/lib/release-notifier.js — "Release notes to
 * installs" (board item). Control pairs: fake sql (pattern from
 * continuous-subscription-store.test.js) + fake transport (pattern from
 * mail-transport.test.js / digest-mailer's own deliver seam).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const RN = require('../website/app/lib/release-notifier');

const ENV_VARS = ['GATETEST_RELEASE_NOTIFY_ENABLED', 'SESSION_SECRET', 'GATETEST_INTERNAL_TOKEN', 'GATETEST_ADMIN_PASSWORD'];
let saved = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_VARS) saved[k] = process.env[k];
  delete process.env.GATETEST_RELEASE_NOTIFY_ENABLED;
  delete process.env.GATETEST_INTERNAL_TOKEN;
  delete process.env.GATETEST_ADMIN_PASSWORD;
  process.env.SESSION_SECRET = 'test-session-secret';
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Fake sql tagged-template: schema statements are no-ops; data queries are
 * routed by a simple table so tests don't have to count query order. */
function fakeSql({ customers = [], releaseNotifications = [] } = {}) {
  const queries = [];
  const state = { customers: [...customers], releaseNotifications: [...releaseNotifications] };
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    queries.push({ text, values });
    if (/^CREATE TABLE|^ALTER TABLE|^CREATE INDEX/i.test(text)) return Promise.resolve([]);
    if (/^SELECT email FROM customers/i.test(text)) {
      return Promise.resolve(state.customers.filter((c) => c.release_emails_opt_in === true));
    }
    if (/^SELECT version FROM release_notifications/i.test(text)) {
      const version = values[0];
      return Promise.resolve(state.releaseNotifications.filter((r) => r.version === version));
    }
    if (/^INSERT INTO release_notifications/i.test(text)) {
      const [version] = values;
      state.releaseNotifications.push({ version });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  sql.queries = queries;
  sql.state = state;
  return sql;
}

/** Fake transport: records every send, always succeeds unless told not to. */
function fakeTransport(shouldFail = () => false) {
  const calls = [];
  return {
    calls,
    deliver: async (msg) => {
      calls.push(msg);
      if (shouldFail(msg)) return { ok: false, error: 'simulated failure' };
      return { ok: true, id: `msg_${calls.length}` };
    },
  };
}

const CHANGELOG = { entries: [{ sha: 'abc123', title: 'spineHealth: structural analysis, module #121', version: '9.9.9' }] };

// ---------------------------------------------------------------------------
// buildReleaseEmail
// ---------------------------------------------------------------------------

describe('buildReleaseEmail', () => {
  test('throws without a version', () => {
    assert.throws(() => RN.buildReleaseEmail({}), /version is required/);
  });

  test('subject, text and html mention the version and the install command', () => {
    const { subject, text, html } = RN.buildReleaseEmail({ version: '9.9.9', unsubscribeUrl: 'https://gatetest.io/x' });
    assert.match(subject, /9\.9\.9/);
    assert.match(text, /npm i -g @gatetest\/cli@9\.9\.9/);
    assert.match(html, /npm i -g @gatetest\/cli@9\.9\.9/);
  });

  test('includes the changelog title when provided', () => {
    const { text, html } = RN.buildReleaseEmail({
      version: '9.9.9',
      changelogEntry: { title: 'a real change description' },
    });
    assert.match(text, /a real change description/);
    assert.match(html, /a real change description/);
  });

  test('omits a changelog section when no entry is given', () => {
    const { text } = RN.buildReleaseEmail({ version: '9.9.9' });
    assert.doesNotMatch(text, /What changed/);
  });

  test('includes the unsubscribe link when given, omits it otherwise', () => {
    const withUrl = RN.buildReleaseEmail({ version: '1.0.0', unsubscribeUrl: 'https://gatetest.io/account/notifications?token=abc' });
    assert.match(withUrl.text, /Unsubscribe: https:\/\/gatetest\.io\/account\/notifications/);
    assert.match(withUrl.html, /Unsubscribe/);

    const withoutUrl = RN.buildReleaseEmail({ version: '1.0.0' });
    assert.doesNotMatch(withoutUrl.text, /Unsubscribe/);
  });

  test('mentions how to update: the CLI command and the editor extension', () => {
    const { text } = RN.buildReleaseEmail({ version: '2.3.4' });
    assert.match(text, /npm i -g @gatetest\/cli@2\.3\.4/);
    assert.match(text, /extension.*updates automatically/i);
  });

  // Control pair — public copy must never name an AI vendor or model
  // (Bible Boss Rule: vendor-neutral public copy).
  const FORBIDDEN = /\b(claude|anthropic|fable|sonnet|opus|haiku|openai|gpt-?\d)\b/i;
  test('CONTROL: email body names no AI vendor or model', () => {
    const { subject, text, html } = RN.buildReleaseEmail({
      version: '9.9.9',
      changelogEntry: CHANGELOG.entries[0],
      unsubscribeUrl: 'https://gatetest.io/account/notifications?token=abc',
    });
    assert.doesNotMatch(subject, FORBIDDEN);
    assert.doesNotMatch(text, FORBIDDEN);
    assert.doesNotMatch(html, FORBIDDEN);
  });
  test('POSITIVE CONTROL: the forbidden-word regex actually fires on vendor language', () => {
    assert.match('powered by Claude, running Sonnet', FORBIDDEN);
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe token
// ---------------------------------------------------------------------------

describe('unsubscribe token', () => {
  test('round-trips a valid email', () => {
    const token = RN.signUnsubscribeToken('customer@example.com');
    assert.ok(token);
    assert.equal(RN.verifyUnsubscribeToken(token), 'customer@example.com');
  });

  test('rejects a tampered token', () => {
    const token = RN.signUnsubscribeToken('customer@example.com');
    const tampered = token.replace(/.$/, token.endsWith('a') ? 'b' : 'a');
    assert.equal(RN.verifyUnsubscribeToken(tampered), null);
  });

  test('rejects garbage input', () => {
    assert.equal(RN.verifyUnsubscribeToken(''), null);
    assert.equal(RN.verifyUnsubscribeToken(null), null);
    assert.equal(RN.verifyUnsubscribeToken('not-a-token'), null);
  });

  test('buildUnsubscribeUrl embeds a verifiable token', () => {
    const url = RN.buildUnsubscribeUrl('customer@example.com');
    const token = new URL(url).searchParams.get('token');
    assert.equal(RN.verifyUnsubscribeToken(token), 'customer@example.com');
  });

  test('signing fails closed with no secret configured', () => {
    delete process.env.SESSION_SECRET;
    assert.equal(RN.signUnsubscribeToken('customer@example.com'), null);
    assert.equal(RN.buildUnsubscribeUrl('customer@example.com'), null);
  });
});

// ---------------------------------------------------------------------------
// selectRecipients
// ---------------------------------------------------------------------------

describe('selectRecipients', () => {
  test('only opted-in customers with a well-formed email', async () => {
    const sql = fakeSql({
      customers: [
        { email: 'in@example.com', release_emails_opt_in: true },
        { email: 'out@example.com', release_emails_opt_in: false },
        { email: 'bad-email', release_emails_opt_in: true },
      ],
    });
    const recipients = await RN.selectRecipients({ sql });
    assert.deepEqual(recipients, ['in@example.com']);
  });

  test('requires sql', async () => {
    await assert.rejects(() => RN.selectRecipients({}), /sql is required/);
  });
});

// ---------------------------------------------------------------------------
// notifyRelease — the three-state control pairs
// ---------------------------------------------------------------------------

describe('notifyRelease', () => {
  test('flag off: disabled, zero transport calls', async () => {
    delete process.env.GATETEST_RELEASE_NOTIFY_ENABLED;
    const sql = fakeSql({ customers: [{ email: 'a@example.com', release_emails_opt_in: true }] });
    const transport = fakeTransport();
    const result = await RN.notifyRelease({ sql, transport, version: '9.9.9', changelog: CHANGELOG });
    assert.equal(result.status, 'disabled');
    assert.equal(result.sent, 0);
    assert.equal(result.skipped, 0);
    assert.equal(transport.calls.length, 0);
  });

  test('flag on, two opted-in + one opted-out: exactly two sends, opted-out untouched', async () => {
    process.env.GATETEST_RELEASE_NOTIFY_ENABLED = '1';
    const sql = fakeSql({
      customers: [
        { email: 'one@example.com', release_emails_opt_in: true },
        { email: 'two@example.com', release_emails_opt_in: true },
        { email: 'nope@example.com', release_emails_opt_in: false },
      ],
    });
    const transport = fakeTransport();
    const result = await RN.notifyRelease({ sql, transport, version: '9.9.9', changelog: CHANGELOG });
    assert.equal(result.status, 'sent');
    assert.equal(result.sent, 2);
    assert.equal(result.skipped, 0);
    assert.equal(transport.calls.length, 2);
    const sentTo = transport.calls.map((m) => m.to).sort();
    assert.deepEqual(sentTo, ['one@example.com', 'two@example.com']);
    assert.ok(!sentTo.includes('nope@example.com'));
  });

  test('second call for the same version: already-sent, zero sends', async () => {
    process.env.GATETEST_RELEASE_NOTIFY_ENABLED = '1';
    const sql = fakeSql({ customers: [{ email: 'one@example.com', release_emails_opt_in: true }] });
    const transport = fakeTransport();

    const first = await RN.notifyRelease({ sql, transport, version: '9.9.9', changelog: CHANGELOG });
    assert.equal(first.status, 'sent');
    assert.equal(transport.calls.length, 1);

    const second = await RN.notifyRelease({ sql, transport, version: '9.9.9', changelog: CHANGELOG });
    assert.equal(second.status, 'already-sent');
    assert.equal(second.sent, 0);
    assert.equal(second.skipped, 0);
    assert.equal(transport.calls.length, 1, 'no additional send on the re-run');
  });

  test('no changelog entry for the version: no-changelog, zero sends', async () => {
    process.env.GATETEST_RELEASE_NOTIFY_ENABLED = '1';
    const sql = fakeSql({ customers: [{ email: 'one@example.com', release_emails_opt_in: true }] });
    const transport = fakeTransport();
    const result = await RN.notifyRelease({ sql, transport, version: '0.0.0-nope', changelog: CHANGELOG });
    assert.equal(result.status, 'no-changelog');
    assert.equal(result.sent, 0);
    assert.equal(result.skipped, 0);
    assert.equal(transport.calls.length, 0);
  });

  test('no opted-in recipients: no-recipients, zero sends', async () => {
    process.env.GATETEST_RELEASE_NOTIFY_ENABLED = '1';
    const sql = fakeSql({ customers: [{ email: 'nope@example.com', release_emails_opt_in: false }] });
    const transport = fakeTransport();
    const result = await RN.notifyRelease({ sql, transport, version: '9.9.9', changelog: CHANGELOG });
    assert.equal(result.status, 'no-recipients');
    assert.equal(transport.calls.length, 0);
  });

  test('a per-recipient delivery failure counts as skipped, not thrown', async () => {
    process.env.GATETEST_RELEASE_NOTIFY_ENABLED = '1';
    const sql = fakeSql({
      customers: [
        { email: 'good@example.com', release_emails_opt_in: true },
        { email: 'bad@example.com', release_emails_opt_in: true },
      ],
    });
    const transport = fakeTransport((msg) => msg.to === 'bad@example.com');
    const result = await RN.notifyRelease({ sql, transport, version: '9.9.9', changelog: CHANGELOG });
    assert.equal(result.status, 'sent');
    assert.equal(result.sent, 1);
    assert.equal(result.skipped, 1);
  });

  test('requires sql and version', async () => {
    await assert.rejects(() => RN.notifyRelease({ version: '1.0.0' }), /sql is required/);
    await assert.rejects(() => RN.notifyRelease({ sql: fakeSql() }), /version is required/);
  });
});

// ---------------------------------------------------------------------------
// findChangelogEntry
// ---------------------------------------------------------------------------

describe('findChangelogEntry', () => {
  test('finds the entry that carries a version, using an injected changelog', () => {
    const entry = RN.findChangelogEntry('9.9.9', CHANGELOG);
    assert.equal(entry.title, CHANGELOG.entries[0].title);
  });

  test('returns null for a version with no entry', () => {
    assert.equal(RN.findChangelogEntry('0.0.0-nope', CHANGELOG), null);
  });

  test('reads the real generated changelog.json when nothing is injected (smoke)', () => {
    // Doesn't assert a specific version — just that it doesn't throw and
    // returns null-or-object, proving the require() path resolves.
    const entry = RN.findChangelogEntry('0.0.0-definitely-not-a-real-version');
    assert.equal(entry, null);
  });
});
